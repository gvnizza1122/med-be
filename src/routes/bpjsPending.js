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
const XLSX = require('xlsx');
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

// Rekap pending BPJS dari RS ternyata berformat XLSX tabular (bukan surat PDF
// per-klaim) — 2 sheet ("Pending RJ"/"Pending RI"), header baris ke-4 berisi
// NOSEP/TGLSEP/TGLPLG/NOKARTU/MR/NAMAPESERTA/KDINACBG/BYPENGAJUAN/
// ALASANPENDING/JAWABAN RS. Satu baris = satu klaim pending. Jauh lebih andal
// diparse langsung (kolom eksplisit) daripada lewat AI ekstraksi teks PDF.
const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname) ||
      /spreadsheetml|ms-excel/.test(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Hanya file Excel (.xlsx/.xls) yang diperbolehkan.'));
  }
});

const REQUIRED_HEADER = 'NOSEP';

function excelDateToISO(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') {
    // Serial date Excel (basis 1899-12-30)
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s || null;
}

/**
 * Cari baris header (mengandung "NOSEP") lalu map baris-baris di bawahnya
 * jadi objek by kolom. Baris tanpa NOSEP (baris judul/kosong) dilewati.
 */
function parsePendingSheet(sheet, sheetLabel) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headerIdx = rows.findIndex(r => r.some(c => String(c).trim().toUpperCase() === REQUIRED_HEADER));
  if (headerIdx === -1) return [];
  const headers = rows[headerIdx].map(h => String(h).trim().toUpperCase());
  const colIdx = (name) => headers.indexOf(name);

  const iSep = colIdx('NOSEP'), iTglSep = colIdx('TGLSEP'), iTglPlg = colIdx('TGLPLG'),
    iNokartu = colIdx('NOKARTU'), iMr = colIdx('MR'), iNama = colIdx('NAMAPESERTA'),
    iInacbg = colIdx('KDINACBG'), iBiaya = colIdx('BYPENGAJUAN'), iAlasan = colIdx('ALASANPENDING'),
    iJawaban = colIdx('JAWABAN RS');

  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const sep = String(row[iSep] ?? '').trim();
    if (!sep) continue;
    out.push({
      sheet: sheetLabel,
      sep,
      tgl_sep: excelDateToISO(row[iTglSep]),
      tgl_pulang: excelDateToISO(row[iTglPlg]),
      nokartu: iNokartu >= 0 ? String(row[iNokartu] ?? '').trim() : '',
      mr: iMr >= 0 ? String(row[iMr] ?? '').trim() : '',
      nama_peserta: iNama >= 0 ? String(row[iNama] ?? '').trim() : '',
      kdinacbg: iInacbg >= 0 ? String(row[iInacbg] ?? '').trim() : '',
      by_pengajuan: iBiaya >= 0 ? row[iBiaya] : null,
      alasan_pending: iAlasan >= 0 ? String(row[iAlasan] ?? '').trim() : '',
      jawaban_rs: iJawaban >= 0 ? String(row[iJawaban] ?? '').trim() : '',
    });
  }
  return out;
}

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

/**
 * POST /api/v1/records/pending-import-xlsx
 * Import massal rekap pending BPJS dari file Excel RS (sheet "Pending RJ" /
 * "Pending RI", format lihat parsePendingSheet()). Tidak butuh AI untuk
 * ekstraksi — datanya sudah tabular. AI draft dibuat belakangan per-baris
 * lewat POST /pending/:id/generate-draft (biar tidak menembak AI utk
 * puluhan baris sekaligus tanpa kontrol koder).
 * Cocokkan NOSEP ke claim_records; baris yang SEP-nya sudah pernah diimpor
 * (sep+alasan_pending sama) dilewati supaya re-upload file yang sama aman.
 */
router.post('/pending-import-xlsx', authenticate, xlsxUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File Excel wajib diunggah.' });
    const db = getDb();

    let wb;
    try {
      wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    } catch (e) {
      return res.status(400).json({ error: 'File Excel tidak bisa dibaca. Pastikan format .xlsx/.xls valid.' });
    }

    const sheetLabelOf = (name) => /rawat\s*inap|^ri$|pending\s*ri/i.test(name) ? 'RI'
      : /rawat\s*jalan|^rj$|pending\s*rj/i.test(name) ? 'RJ' : name;

    let parsedRows = [];
    for (const sheetName of wb.SheetNames) {
      const rows = parsePendingSheet(wb.Sheets[sheetName], sheetLabelOf(sheetName));
      parsedRows = parsedRows.concat(rows);
    }
    if (!parsedRows.length) {
      return res.status(400).json({ error: 'Tidak ada baris data ditemukan (kolom NOSEP tidak terdeteksi di sheet manapun).' });
    }

    const fileId = uuidv4();
    let imported = 0, skippedDuplicate = 0, matchedClaim = 0;
    for (const row of parsedRows) {
      const dup = await db.prepare(`
        SELECT id FROM bpjs_pending_responses WHERE sep = ? AND alasan_raw = ? AND source = 'xlsx_import'
      `).get(row.sep, row.alasan_pending);
      if (dup) { skippedDuplicate++; continue; }

      const claimRecord = await db.prepare(`
        SELECT id FROM claim_records WHERE sep = ? ORDER BY row_number LIMIT 1
      `).get(row.sep);
      if (claimRecord) matchedClaim++;

      await db.prepare(`
        INSERT INTO bpjs_pending_responses
          (id, pending_file_id, claim_record_id, sep, mrn, nokartu, nama_peserta, kdinacbg, by_pengajuan,
           tanggal_pending, tgl_pulang, alasan_raw, jawaban_rs_manual, status, source, jenis_klaim)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'xlsx_import', ?)
      `).run(
        uuidv4(), fileId, claimRecord?.id || null, row.sep, row.mr || null, row.nokartu || null,
        row.nama_peserta || null, row.kdinacbg || null, row.by_pengajuan,
        row.tgl_sep, row.tgl_pulang, row.alasan_pending, row.jawaban_rs || null, row.sheet
      );
      imported++;
    }

    await db.prepare(`
      INSERT INTO bpjs_pending_files (id, file_name, total_rows, imported_rows, skipped_duplicate, matched_claim, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, req.file.originalname, parsedRows.length, imported, skippedDuplicate, matchedClaim, req.user?.id || null);

    res.json({ file_id: fileId, total_rows: parsedRows.length, imported, skipped_duplicate: skippedDuplicate, matched_claim: matchedClaim });
  } catch (err) {
    console.error('[bpjsPending] xlsx import error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/records/pending-files
 * List file Excel rekap pending yang sudah diimpor — tampilan per-file
 * (seperti Riwayat Upload), dengan ringkasan status baris di dalamnya.
 */
router.get('/pending-files', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const totalResult = await db.prepare('SELECT COUNT(*) as count FROM bpjs_pending_files').get();
    const files = await db.prepare(`
      SELECT f.*,
        (SELECT COUNT(*) FROM bpjs_pending_responses WHERE pending_file_id = f.id AND status = 'draft') as draft_count,
        (SELECT COUNT(*) FROM bpjs_pending_responses WHERE pending_file_id = f.id AND status = 'dikirim') as dikirim_count,
        (SELECT COUNT(*) FROM bpjs_pending_responses WHERE pending_file_id = f.id AND status = 'diterima') as diterima_count,
        (SELECT COUNT(*) FROM bpjs_pending_responses WHERE pending_file_id = f.id AND status = 'ditolak') as ditolak_count
      FROM bpjs_pending_files f
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `).all(parseInt(limit), offset);

    res.json({ total: Number(totalResult?.count || 0), files });
  } catch (err) {
    console.error('[bpjsPending] list files error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/records/pending
 * List semua entri pending BPJS (dari upload PDF maupun import XLSX), lintas
 * klaim — dipakai halaman rekap pending, bukan cuma modal per-record.
 * Query: status, outcome, jenis_klaim, search (cocok sep/nama_peserta), pending_file_id
 */
router.get('/pending', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { status, outcome, jenis_klaim, search, pending_file_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (outcome) { where += ' AND outcome = ?'; params.push(outcome); }
    if (jenis_klaim) { where += ' AND jenis_klaim = ?'; params.push(jenis_klaim); }
    if (pending_file_id) { where += ' AND pending_file_id = ?'; params.push(pending_file_id); }
    if (search) {
      where += ' AND (sep LIKE ? OR nama_peserta LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like);
    }
    const totalResult = await db.prepare(`SELECT COUNT(*) as count FROM bpjs_pending_responses ${where}`).get(...params);
    const rows = await db.prepare(`
      SELECT * FROM bpjs_pending_responses ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);
    res.json({
      total: Number(totalResult?.count || 0),
      items: rows.map(r => ({ ...r, alasan_parsed: r.alasan_parsed ? JSON.parse(r.alasan_parsed) : null })),
    });
  } catch (err) {
    console.error('[bpjsPending] list-all error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/records/pending/:id/generate-draft
 * Generate/regenerate draft klarifikasi AI untuk 1 entri pending yang sudah
 * ada (dari import XLSX ataupun upload PDF) — dipanggil manual per-baris
 * oleh koder, bukan otomatis saat import massal.
 */
router.post('/pending/:id/generate-draft', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT * FROM bpjs_pending_responses WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Data pending tidak ditemukan.' });
    if (!existing.alasan_raw) return res.status(400).json({ error: 'Tidak ada teks alasan pending untuk entri ini.' });

    let claimRecord = null;
    if (existing.claim_record_id) {
      claimRecord = await db.prepare(`
        SELECT id, sep, nama_pasien, mrn, admission_date, diagnosa_list, prosedur_list, dpjp_name
        FROM claim_records WHERE id = ?
      `).get(existing.claim_record_id);
    }
    if (!claimRecord) {
      // Belum ada klaim yang cocok di sistem (mis. NOSEP belum pernah diupload
      // via Extract PDF) — tetap generate draft, hanya field admin dari data
      // rekap Excel (nama_peserta/nokartu/mrn/kdinacbg), bukan dikarang.
      claimRecord = {
        sep: existing.sep, nama_pasien: existing.nama_peserta, mrn: existing.mrn || existing.nokartu,
        admission_date: existing.tanggal_pending, diagnosa_list: existing.kdinacbg ? `(INA-CBG: ${existing.kdinacbg})` : '',
        prosedur_list: '', dpjp_name: '',
      };
    }

    const priorExamples = await db.prepare(`
      SELECT kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci
      FROM ai_training_examples WHERE outcome = 'approved'
      ORDER BY created_at DESC LIMIT 3
    `).all();

    const prompt = buildPrompt({ alasanRaw: existing.alasan_raw, claimRecord, examples: priorExamples });
    let aiResult = null, aiError = null;
    try {
      aiResult = await callAi(prompt);
    } catch (err) {
      aiError = err.message;
      console.error('[bpjsPending] generate-draft AI error:', err.message);
    }
    if (!aiResult) {
      return res.status(aiError ? 502 : 400).json({
        error: aiError || 'AI_PROVIDER_API_KEY belum disetel di server — draft harus diisi manual.',
      });
    }

    const alasanParsed = {
      kategori: aiResult.kategori_pending || null,
      field: aiResult.field_dipermasalahkan || [],
      detail: aiResult.alasan_ringkas || null,
      checklist_dokumen_pendukung: aiResult.checklist_dokumen_pendukung || [],
    };

    await db.prepare(`
      UPDATE bpjs_pending_responses SET alasan_parsed = ?, draft_klarifikasi = ? WHERE id = ?
    `).run(JSON.stringify(alasanParsed), aiResult.draft_klarifikasi || null, req.params.id);

    const updated = await db.prepare('SELECT * FROM bpjs_pending_responses WHERE id = ?').get(req.params.id);
    res.json({ ...updated, alasan_parsed: updated.alasan_parsed ? JSON.parse(updated.alasan_parsed) : null });
  } catch (err) {
    console.error('[bpjsPending] generate-draft error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

module.exports = router;
