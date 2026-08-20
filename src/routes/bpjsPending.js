/**
 * Jawaban Pending BPJS — koder upload PDF surat pending dari BPJS, AI
 * mengekstrak alasan pending + generate draft surat klarifikasi (dengan
 * few-shot dari kasus serupa yang sebelumnya berhasil disetujui BPJS, lihat
 * ai_training_examples). Mounted di /api/v1/records (lihat index.js) —
 * konsisten dengan rv20-confirm yang juga di bawah prefix /records/:recordId.
 *
 * Prinsip anti-halusinasi yang sama dipakai di seluruh app: AI hanya boleh
 * mengekstrak & menyusun draft dari teks yang benar-benar ada di dokumen
 * pending + data klaim asli — bagian yang butuh justifikasi klinis manusia
 * tetap placeholder yang harus diisi koder, tidak dikarang AI.
 */
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Hanya file PDF yang diperbolehkan.'));
  }
});

const SYSTEM_PROMPT = `Kamu asisten koder klaim BPJS rumah sakit. Kamu diberi teks surat jawaban
pending dari BPJS untuk satu klaim, data klaim asli (hasil ekstraksi sistem), dan (kalau ada)
contoh klarifikasi yang PERNAH berhasil diterima BPJS untuk kasus sejenis.

TUGAS — kembalikan JSON dengan struktur persis:
{
  "sep": "nomor SEP yang disebut di surat pending, atau null kalau tidak ada",
  "tanggal_pending": "tanggal surat dalam format YYYY-MM-DD, atau null",
  "kategori_pending": "kategori singkat (mis. kode_tindakan, kegawatan, prb, koding_diagnosis, kelengkapan_dokumen, lainnya)",
  "alasan_ringkas": "ringkasan 1-2 kalimat alasan pending, dalam Bahasa Indonesia",
  "field_dipermasalahkan": ["daftar field/aspek klaim yang dipermasalahkan BPJS, mis. DIAGLIST, PROCLIST, kelengkapan resume medis"],
  "draft_klarifikasi": "draft surat klarifikasi lengkap siap edit, dalam Bahasa Indonesia formal",
  "checklist_dokumen_pendukung": ["daftar dokumen pendukung yang sebaiknya dilampirkan"]
}

ATURAN KERAS:
- draft_klarifikasi HANYA boleh memakai data yang benar-benar ada di ALASAN_PENDING atau DATA_KLAIM_ASLI
  yang diberikan. JANGAN mengarang kondisi klinis, hasil pemeriksaan, atau argumen medis yang tidak ada
  dasarnya di data yang diberikan.
- Kalau argumen klinis dibutuhkan tapi datanya tidak tersedia di DATA_KLAIM_ASLI, tulis placeholder
  "[isi ... — jelaskan kondisi klinis pasien terkait <topik>]" di bagian itu, JANGAN ditebak.
- Kalau ada CONTOH_BERHASIL, pelajari POLA argumentasi/strukturnya (bukan disalin mentah) untuk kasus
  yang benar-benar sejenis — tetap sesuaikan isi dengan data klaim ini.
- Field administratif (SEP, nama pasien, MRN, tanggal, diagnosis, DPJP) di draft WAJIB diisi otomatis
  dari DATA_KLAIM_ASLI kalau tersedia, jangan pakai placeholder untuk field yang datanya sudah ada.`;

function buildPrompt({ alasanRaw, claimRecord, examples }) {
  const claimSummary = claimRecord ? `
NOMOR SEP: ${claimRecord.sep || '-'}
NAMA PASIEN: ${claimRecord.nama_pasien || '-'}
MRN: ${claimRecord.mrn || '-'}
TANGGAL MASUK: ${claimRecord.admission_date || '-'}
DIAGNOSIS (DIAGLIST): ${claimRecord.diagnosa_list || '-'}
PROSEDUR (PROCLIST): ${claimRecord.prosedur_list || '-'}
DPJP: ${claimRecord.dpjp_name || '-'}` : '(data klaim asli tidak ditemukan di sistem)';

  const examplesText = examples.length
    ? examples.map((ex, i) => `Contoh ${i + 1} (kategori: ${ex.kategori_pending}):
Alasan BPJS: ${ex.alasan_bpjs}
Klarifikasi yang berhasil: ${ex.draft_berhasil}
${ex.poin_kunci ? `Catatan koder: ${ex.poin_kunci}` : ''}`).join('\n\n')
    : '(belum ada contoh kasus serupa yang berhasil)';

  return `ALASAN_PENDING (teks mentah dari dokumen BPJS):\n${alasanRaw}\n\nDATA_KLAIM_ASLI:\n${claimSummary}\n\nCONTOH_BERHASIL:\n${examplesText}`;
}

async function callAi(prompt) {
  const apiKey = process.env.AI_PROVIDER_API_KEY;
  if (!apiKey) return null;
  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_completion_tokens: 3000,
        response_format: { type: 'json_object' },
      }),
    });
    const respText = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${respText.slice(0, 160)}`);
    const data = JSON.parse(respText);
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('Model membalas kosong');
    try {
      return JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Model tidak mengembalikan JSON');
      return JSON.parse(m[0]);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/v1/records/:recordId/pending-upload
 * Upload PDF jawaban pending BPJS -> ekstrak teks -> AI analisis + draft.
 */
router.post('/:recordId/pending-upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File PDF wajib diunggah.' });
    const db = getDb();

    const claimRecord = await db.prepare(`
      SELECT id, sep, nama_pasien, mrn, admission_date, diagnosa_list, prosedur_list, dpjp_name
      FROM claim_records WHERE id = ?
    `).get(req.params.recordId);
    if (!claimRecord) return res.status(404).json({ error: 'Record klaim tidak ditemukan.' });

    const { PDFParse } = require('pdf-parse');
    const parsed = await new PDFParse({ data: req.file.buffer }).getText();
    const alasanRaw = (parsed.text || '').trim();
    if (alasanRaw.length < 20) {
      return res.status(400).json({ error: 'Teks dari PDF terlalu sedikit/tidak terbaca. Pastikan file bukan hasil scan gambar tanpa OCR.' });
    }

    let aiResult = null;
    let aiError = null;
    try {
      // Retrieval sederhana (bukan vector search) — ambil contoh sukses dari
      // kategori yang sama kalau sudah ada; kalau belum ada history sama
      // sekali, tetap panggil AI tanpa contoh (kategori ditentukan AI sendiri
      // di respons ini, jadi retrieval kategori spesifik baru bisa dilakukan
      // di iterasi kedua kalau perlu — MVP ambil top-3 contoh approved apa saja).
      const priorExamples = await db.prepare(`
        SELECT kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci
        FROM ai_training_examples WHERE outcome = 'approved'
        ORDER BY created_at DESC LIMIT 3
      `).all();

      const prompt = buildPrompt({ alasanRaw, claimRecord, examples: priorExamples });
      aiResult = await callAi(prompt);
    } catch (err) {
      aiError = err.message;
      console.error('[bpjsPending] AI error:', err.message);
    }

    const id = uuidv4();
    const alasanParsed = aiResult ? {
      kategori: aiResult.kategori_pending || null,
      field: aiResult.field_dipermasalahkan || [],
      detail: aiResult.alasan_ringkas || null,
      checklist_dokumen_pendukung: aiResult.checklist_dokumen_pendukung || [],
    } : null;

    await db.prepare(`
      INSERT INTO bpjs_pending_responses
        (id, claim_record_id, sep, mrn, tanggal_pending, alasan_raw, alasan_parsed, draft_klarifikasi, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(
      id, req.params.recordId,
      aiResult?.sep || claimRecord.sep || null,
      claimRecord.mrn || null,
      aiResult?.tanggal_pending || null,
      alasanRaw,
      alasanParsed ? JSON.stringify(alasanParsed) : null,
      aiResult?.draft_klarifikasi || null
    );

    const saved = await db.prepare('SELECT * FROM bpjs_pending_responses WHERE id = ?').get(id);
    res.json({
      ...saved,
      alasan_parsed: saved.alasan_parsed ? JSON.parse(saved.alasan_parsed) : null,
      ai_available: !!aiResult,
      ai_error: aiResult ? null : (aiError || 'AI_PROVIDER_API_KEY belum disetel — hanya teks mentah tersimpan, draft harus diisi manual.'),
    });
  } catch (err) {
    console.error('[bpjsPending] upload error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/records/:recordId/pending
 * Histori upload jawaban pending BPJS untuk 1 record klaim.
 */
router.get('/:recordId/pending', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT * FROM bpjs_pending_responses WHERE claim_record_id = ? ORDER BY created_at DESC
    `).all(req.params.recordId);
    res.json({ items: rows.map(r => ({ ...r, alasan_parsed: r.alasan_parsed ? JSON.parse(r.alasan_parsed) : null })) });
  } catch (err) {
    console.error('[bpjsPending] list error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * PATCH /api/v1/records/pending/:id/status
 * Update status (draft/dikirim) dan/atau outcome (approved/rejected) satu
 * entri pending. Saat outcome='approved', draft ini otomatis masuk ke
 * ai_training_examples supaya jadi few-shot example untuk kasus berikutnya.
 * Body: { status?, outcome?, poin_kunci?, draft_klarifikasi? }
 */
router.patch('/pending/:id/status', authenticate, async (req, res) => {
  try {
    const { status, outcome, poin_kunci, draft_klarifikasi } = req.body;
    const allowedStatus = ['draft', 'dikirim', 'diterima', 'ditolak'];
    const allowedOutcome = ['approved', 'rejected'];
    if (status && !allowedStatus.includes(status)) return res.status(400).json({ error: 'Status tidak valid.' });
    if (outcome && !allowedOutcome.includes(outcome)) return res.status(400).json({ error: 'Outcome tidak valid.' });

    const db = getDb();
    const existing = await db.prepare('SELECT * FROM bpjs_pending_responses WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Data pending tidak ditemukan.' });

    const nextStatus = status || existing.status;
    const nextOutcome = outcome !== undefined ? outcome : existing.outcome;
    const nextDraft = draft_klarifikasi !== undefined ? draft_klarifikasi : existing.draft_klarifikasi;

    await db.prepare(`
      UPDATE bpjs_pending_responses SET status = ?, outcome = ?, draft_klarifikasi = ? WHERE id = ?
    `).run(nextStatus, nextOutcome, nextDraft, req.params.id);

    if (outcome === 'approved') {
      const alasanParsed = existing.alasan_parsed ? JSON.parse(existing.alasan_parsed) : {};
      await db.prepare(`
        INSERT INTO ai_training_examples (id, kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci, outcome)
        VALUES (?, ?, ?, ?, ?, 'approved')
      `).run(uuidv4(), alasanParsed.kategori || 'lainnya', existing.alasan_raw, nextDraft, poin_kunci || null);
    }

    const updated = await db.prepare('SELECT * FROM bpjs_pending_responses WHERE id = ?').get(req.params.id);
    res.json({ ...updated, alasan_parsed: updated.alasan_parsed ? JSON.parse(updated.alasan_parsed) : null });
  } catch (err) {
    console.error('[bpjsPending] status update error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

module.exports = router;
