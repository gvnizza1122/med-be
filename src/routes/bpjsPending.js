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
const { authenticate, authorize } = require('../middleware/auth');
const { callKimi } = require('../services/kimiClient');
const { muatIndeksKlaim, cocokkanSatu } = require('../services/sepCocokService');

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

  const headerIdxPrimary = rows.findIndex(r => r.some(c => String(c).trim().toUpperCase() === REQUIRED_HEADER));
  if (headerIdxPrimary !== -1) {
    const headers = rows[headerIdxPrimary].map(h => String(h).trim().toUpperCase());
    const colIdx = (name) => headers.indexOf(name);
    const iSep = colIdx('NOSEP'), iTglSep = colIdx('TGLSEP'), iTglPlg = colIdx('TGLPLG'),
      iNokartu = colIdx('NOKARTU'), iMr = colIdx('MR'), iNama = colIdx('NAMAPESERTA'),
      iInacbg = colIdx('KDINACBG'), iBiaya = colIdx('BYPENGAJUAN'), iAlasan = colIdx('ALASANPENDING'),
      iJawaban = colIdx('JAWABAN RS');

    const out = [];
    for (let i = headerIdxPrimary + 1; i < rows.length; i++) {
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

  // Format alternatif (ditemukan 8 Sep 2026 di rekap RI Januari 2026 RS
  // Lestari Raharja — sheet "RI" & "RJ" dalam satu file XLSX ternyata bisa
  // punya format kolom BERBEDA: "No. | Tgl. Masuk | Tgl. Pulang | No. RM |
  // Nama Pasien | No. Klaim / SEP | INACBG | Top Up | Total Tarif | Tarif RS
  // | Jenis | Konfirmasi" — kolom "Jenis" di format ini ternyata isinya
  // ALASAN PENDING (bukan kategori jenis), "Konfirmasi" = jawaban/tindakan
  // RS. Tanpa fallback ini, sheet berformat begini SILENT gagal total (0
  // baris ter-import) — bukan error, cuma diam-diam kosong.
  const normalize = (s) => String(s).trim().toUpperCase().replace(/\.\s*/g, ' ').replace(/\s+/g, ' ');
  const headerIdxAlt = rows.findIndex(r => r.some(c => /NO\s*KLAIM\s*\/?\s*SEP/.test(normalize(c))));
  if (headerIdxAlt === -1) return [];

  const headersAlt = rows[headerIdxAlt].map(normalize);
  const findCol = (...patterns) => headersAlt.findIndex(h => patterns.some(p => p.test(h)));

  const iSep = findCol(/NO\s*KLAIM\s*\/?\s*SEP/), iTglMasuk = findCol(/^TGL\s*MASUK$/),
    iTglPlg = findCol(/^TGL\s*PULANG$/), iMr = findCol(/^NO\s*RM$/), iNama = findCol(/^NAMA\s*PASIEN$/),
    iInacbg = findCol(/^INACBG$/), iBiaya = findCol(/^TOTAL\s*TARIF$/),
    // Kolom alasan pending di format alternatif ternyata beda label antar
    // bulan (ditemukan 8 Sep 2026, cross-check 6 file Excel Jan-Jun 2026):
    // "Jenis" (Feb-Apr) vs "Keterangan Pending" (Mei) — sama-sama berisi
    // alasan pending walau labelnya beda, JENIS bukan berarti kategori.
    iAlasan = findCol(/^JENIS$/, /KETERANGAN\s*PENDING/),
    iJawaban = findCol(/^KONFIRMASI$/);

  const out = [];
  for (let i = headerIdxAlt + 1; i < rows.length; i++) {
    const row = rows[i];
    const sep = iSep >= 0 ? String(row[iSep] ?? '').trim() : '';
    if (!sep) continue;
    out.push({
      sheet: sheetLabel,
      sep,
      // Format alternatif tidak punya "Tanggal SEP" terpisah — pakai
      // Tanggal Masuk sebagai referensi tanggal terdekat yang tersedia.
      tgl_sep: iTglMasuk >= 0 ? excelDateToISO(row[iTglMasuk]) : null,
      tgl_pulang: iTglPlg >= 0 ? excelDateToISO(row[iTglPlg]) : null,
      nokartu: '',
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

// Daftar kolom vClaim yang valid untuk "kolom_penyebab" — HARUS sinkron
// dengan FIELD_CATEGORIES di frontend (eclaim-production/src/app/(dashboard)/
// results/[fileId]/page.tsx) supaya nama kolom yang dikembalikan AI dijamin
// cocok dengan nama kolom yang dirender di tabel 60-kolom (dipakai untuk
// menyorot baris penyebab pending saat staf klik SEP dari halaman Pending BPJS).
const VALID_VCLAIM_COLUMNS = [
  'NAMA_PASIEN', 'MRN', 'SEX', 'BIRTH_DATE', 'BIRTH_WEIGHT', 'UMUR_TAHUN', 'UMUR_HARI',
  'KODE_RS', 'KELAS_RS', 'KELAS_RAWAT', 'ADMISSION_DATE', 'DISCHARGE_DATE', 'DISCHARGE_STATUS', 'LOS',
  'DIAGLIST', 'PROCLIST', 'ADL1', 'ADL2',
  'INACBG', 'DESKRIPSI_INACBG', 'TARIF_INACBG', 'SP', 'SR', 'SI', 'SD',
  'DESKRIPSI_SP', 'TARIF_SP', 'DESKRIPSI_SR', 'TARIF_SR', 'DESKRIPSI_SI', 'TARIF_SI', 'DESKRIPSI_SD', 'TARIF_SD', 'TOTAL_TARIF',
  'ICU_INDIKATOR', 'ICU_LOS', 'VENT_HOUR',
  'SEP', 'NOKARTU', 'PAYOR_ID', 'DPJP', 'KODE_TARIF', 'PTD', 'IN_SP', 'IN_SR', 'IN_SI', 'IN_SD', 'SUBACUTE', 'CHRONIC', 'TARIF_POLI_EKS',
  // TARIF_RS/CODER_ID/VERSI_INACBG/VERSI_GROUPER/C1-C4 sengaja TIDAK diikutkan
  // — kolom-kolom "isi otomatis vClaim" ini sudah dihapus dari tampilan tabel
  // frontend (staf tidak paham C1-C4), jadi AI tidak boleh menyarankan
  // highlight ke kolom yang sudah tidak dirender.
];

const SYSTEM_PROMPT = `Kamu asisten koder klaim BPJS rumah sakit. Kamu diberi ALASAN_PENDING (kenapa
klaim ditahan BPJS), data klaim asli (hasil ekstraksi sistem), dan (kalau ada) contoh jawaban yang
PERNAH berhasil diterima BPJS untuk kasus sejenis.

TUGAS — kembalikan JSON dengan struktur persis:
{
  "kategori_pending": "kategori singkat (mis. kode_tindakan, kegawatan, prb, koding_diagnosis, kelengkapan_dokumen, lainnya)",
  "alasan_ringkas": "ringkasan 1 kalimat alasan pending, dalam Bahasa Indonesia",
  "jawaban": "jawaban/klarifikasi LANGSUNG ke pertanyaan BPJS, 2-5 kalimat, Bahasa Indonesia, TANPA format surat resmi (tanpa kop surat/salam pembuka/tanda tangan) — cukup jawaban intinya saja seperti akan diketik langsung ke kolom jawaban BPJS",
  "kolom_penyebab": ["daftar nama kolom vClaim (huruf besar) yang jadi penyebab pending, HANYA dari KOLOM_VALID di bawah — array kosong [] kalau tidak jelas kolom mana"]
}

KOLOM_VALID (pilih HANYA dari daftar ini untuk kolom_penyebab): ${VALID_VCLAIM_COLUMNS.join(', ')}

ATURAN KERAS:
- jawaban HANYA boleh memakai data yang benar-benar ada di ALASAN_PENDING atau DATA_KLAIM_ASLI yang
  diberikan. JANGAN mengarang kondisi klinis, hasil pemeriksaan, atau argumen medis yang tidak ada
  dasarnya di data yang diberikan.
- Kalau argumen klinis dibutuhkan tapi datanya tidak tersedia di DATA_KLAIM_ASLI, tulis placeholder
  singkat "[isi: <topik yang perlu dikonfirmasi>]" di bagian itu, JANGAN ditebak.
- Kalau ada CONTOH_BERHASIL, pelajari POLA argumen yang berhasil (bukan disalin mentah) untuk kasus
  yang benar-benar sejenis — tetap sesuaikan isi dengan data klaim ini.
- Langsung ke inti jawaban, jangan bertele-tele atau mengulang pertanyaan BPJS.
- kolom_penyebab HANYA diisi kalau ALASAN_PENDING jelas merujuk ke kolom tertentu (mis. "kode diagnosis
  tidak sesuai" -> DIAGLIST). Kalau alasan pending bersifat umum/administratif (mis. kelengkapan dokumen
  yang tidak berkaitan ke 1 kolom spesifik), kembalikan array kosong — JANGAN menebak.`;

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
 * Ringkas 1 kasus pending+jawaban lewat Kimi K3 dan simpan sebagai contoh
 * training (ai_training_examples) — dipanggil best-effort setiap kali draft
 * berhasil dibuat (lihat POST pending/:id/generate-draft), TANPA menunggu
 * staf menandai status approved. generated_by='kimi-k3-auto' membedakannya
 * dari hasil backfill arsip lama (scripts/importTrainingData.js, generated_by
 * 'kimi-k3-backfill'). Silent no-op kalau KIMI_API_KEY belum disetel.
 */
async function recordKimiTrainingExample(db, alasanRaw, draftJawaban, kategoriFallback) {
  if (!alasanRaw || !draftJawaban) return;
  const prompt = `ALASAN_PENDING:\n${alasanRaw}\n\nJAWABAN_KLARIFIKASI_RS:\n${draftJawaban}\n\n(outcome belum diketahui saat ini — isi "tidak_diketahui")`;
  const result = await callKimi(prompt);
  if (!result) return; // KIMI_API_KEY belum disetel di server
  await db.prepare(`
    INSERT INTO ai_training_examples
      (id, kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci, outcome, generated_by, confidence_score)
    VALUES (?, ?, ?, ?, ?, ?, 'kimi-k3-auto', ?)
  `).run(
    uuidv4(),
    result.kategori_pending || kategoriFallback || 'lainnya',
    alasanRaw,
    draftJawaban,
    Array.isArray(result.poin_kunci) ? result.poin_kunci.join('; ') : null,
    result.outcome || 'tidak_diketahui',
    Number.isFinite(result.confidence) ? result.confidence : null,
  );
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
        FROM ai_training_examples
        ORDER BY confidence_score DESC NULLS LAST, created_at DESC LIMIT 3
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
      detail: aiResult.alasan_ringkas || null,
      field: Array.isArray(aiResult.kolom_penyebab) ? aiResult.kolom_penyebab.filter(c => VALID_VCLAIM_COLUMNS.includes(c)) : [],
    } : null;

    await db.prepare(`
      INSERT INTO bpjs_pending_responses
        (id, claim_record_id, sep, mrn, tanggal_pending, alasan_raw, alasan_parsed, draft_klarifikasi, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(
      id, req.params.recordId,
      claimRecord.sep || null,
      claimRecord.mrn || null,
      null,
      alasanRaw,
      alasanParsed ? JSON.stringify(alasanParsed) : null,
      aiResult?.jawaban || null
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
 * entri pending. TIDAK lagi jadi syarat masuk ai_training_examples — training
 * sekarang tercatat otomatis begitu draft dibuat (lihat POST
 * pending/:id/generate-draft), lepas dari status/outcome ini diklik atau
 * tidak (di lapangan gerbang klik ini jarang dipakai konsisten oleh staf).
 * Body: { status?, outcome?, poin_kunci?, draft_klarifikasi? }
 */
router.patch('/pending/:id/status', authenticate, async (req, res) => {
  try {
    const { status, outcome, draft_klarifikasi } = req.body;
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
    // Pencocokan SEP dinormalisasi (spasi, karakter tersembunyi, huruf mirip)
    // dan hasilnya dipecah supaya "cocok = 0" bisa dijelaskan penyebabnya.
    const indeksKlaim = await muatIndeksKlaim(db);
    const rincianCocok = { cocok: 0, klaim_tidak_ada: 0, format: 0 };
    for (const row of parsedRows) {
      const dup = await db.prepare(`
        SELECT id FROM bpjs_pending_responses WHERE sep = ? AND alasan_raw = ? AND source = 'xlsx_import'
      `).get(row.sep, row.alasan_pending);
      if (dup) { skippedDuplicate++; continue; }

      const hasilCocok = cocokkanSatu(row.sep, indeksKlaim);
      rincianCocok[hasilCocok.status]++;
      const claimRecord = hasilCocok.status === 'cocok' ? { id: hasilCocok.klaimId } : null;
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

    // Kalau semua baris ternyata duplikat (file yang sama diupload ulang),
    // jangan buat entri "file" baru yang isinya kosong — cuma bikin bingung
    // di daftar file. Tetap kabari user lewat respons (imported: 0).
    if (imported > 0) {
      await db.prepare(`
        INSERT INTO bpjs_pending_files (id, file_name, total_rows, imported_rows, skipped_duplicate, matched_claim, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(fileId, req.file.originalname, parsedRows.length, imported, skippedDuplicate, matchedClaim, req.user?.id || null);
    }

    res.json({
      file_id: imported > 0 ? fileId : null,
      total_rows: parsedRows.length, imported, skipped_duplicate: skippedDuplicate, matched_claim: matchedClaim,
      // Rincian penyebab: cocok / klaim_tidak_ada / format (lihat sepCocokService).
      rincian_cocok: rincianCocok,
    });
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
    // Prefix bpr. dari awal (bukan tempel belakangan) — bpjs_pending_responses
    // dan claim_records SAMA-SAMA punya kolom "sep", jadi begitu di-JOIN nama
    // kolom itu jadi ambigu kalau tidak di-qualify eksplisit.
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND bpr.status = ?'; params.push(status); }
    if (outcome) { where += ' AND bpr.outcome = ?'; params.push(outcome); }
    if (jenis_klaim) { where += ' AND bpr.jenis_klaim = ?'; params.push(jenis_klaim); }
    if (pending_file_id) { where += ' AND bpr.pending_file_id = ?'; params.push(pending_file_id); }
    if (search) {
      where += ' AND (bpr.sep LIKE ? OR bpr.nama_peserta LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like);
    }
    const totalResult = await db.prepare(`SELECT COUNT(*) as count FROM bpjs_pending_responses bpr ${where}`).get(...params);
    // claim_file_id (bukan cuma claim_record_id) diikutkan supaya FE bisa link
    // langsung ke halaman detail klaim (/results/:fileId) begitu diklik — tanpa
    // ini FE cuma tahu record-nya ada, tapi tidak tahu file mana yang harus dibuka.
    const rows = await db.prepare(`
      SELECT bpr.*, cr.file_id as claim_file_id
      FROM bpjs_pending_responses bpr
      LEFT JOIN claim_records cr ON cr.id = bpr.claim_record_id
      ${where}
      ORDER BY bpr.created_at DESC LIMIT ? OFFSET ?
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
 * Logic inti generate/regenerate draft klarifikasi AI untuk 1 baris pending —
 * dipakai baik oleh endpoint single (generate-draft) maupun bulk
 * (generate-all-drafts) supaya tidak ada logika ganda. Tidak menyentuh
 * req/res — cuma mengembalikan { success, error }.
 */
async function generateDraftForRow(db, existing) {
  if (!existing.alasan_raw) return { success: false, error: 'Tidak ada teks alasan pending untuk entri ini.' };

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
    FROM ai_training_examples
    ORDER BY confidence_score DESC NULLS LAST, created_at DESC LIMIT 3
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
    return { success: false, error: aiError || 'AI_PROVIDER_API_KEY belum disetel di server — draft harus diisi manual.' };
  }

  const alasanParsed = {
    kategori: aiResult.kategori_pending || null,
    detail: aiResult.alasan_ringkas || null,
    field: Array.isArray(aiResult.kolom_penyebab) ? aiResult.kolom_penyebab.filter(c => VALID_VCLAIM_COLUMNS.includes(c)) : [],
  };

  await db.prepare(`
    UPDATE bpjs_pending_responses SET alasan_parsed = ?, draft_klarifikasi = ? WHERE id = ?
  `).run(JSON.stringify(alasanParsed), aiResult.jawaban || null, existing.id);

  // Training (RAG) otomatis begitu draft berhasil dibuat — TIDAK menunggu
  // staf menandai status/outcome (lihat catatan di PATCH pending/:id/status
  // di atas). Best-effort, tidak di-await, tidak boleh gagalkan response
  // kalau Kimi lambat/error.
  recordKimiTrainingExample(db, existing.alasan_raw, aiResult.jawaban || '', alasanParsed.kategori)
    .catch(err => console.error('[bpjsPending] Kimi training error:', err.message));

  return { success: true };
}

async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

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

    const result = await generateDraftForRow(db, existing);
    if (!result.success) {
      return res.status(result.error?.includes('API_KEY') ? 400 : 502).json({ error: result.error });
    }

    const updated = await db.prepare('SELECT * FROM bpjs_pending_responses WHERE id = ?').get(req.params.id);
    res.json({ ...updated, alasan_parsed: updated.alasan_parsed ? JSON.parse(updated.alasan_parsed) : null });
  } catch (err) {
    console.error('[bpjsPending] generate-draft error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/records/pending-files/:id/generate-all-drafts
 * Generate draft untuk SEMUA baris pending dalam 1 file rekap yang belum
 * punya draft — dibutuhkan untuk testing skala besar (ratusan baris per
 * bulan) supaya tidak klik satu-satu di UI. Concurrency rendah (3, lebih
 * kecil dari upload batch) supaya tidak membanjiri AI provider. Sinkron
 * (1 request selama proses jalan) — sama seperti pola upload-pdf-batch.
 */
router.post('/pending-files/:id/generate-all-drafts', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare('SELECT id FROM bpjs_pending_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File pending tidak ditemukan.' });

    const rows = await db.prepare(`
      SELECT * FROM bpjs_pending_responses WHERE pending_file_id = ? AND draft_klarifikasi IS NULL
    `).all(req.params.id);

    let done = 0, error = 0;
    await runWithConcurrencyLimit(rows, 3, async (row) => {
      const result = await generateDraftForRow(db, row);
      if (result.success) done++; else error++;
    });

    res.json({ processed: rows.length, done, error });
  } catch (err) {
    console.error('[bpjsPending] generate-all-drafts error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/records/pending-files/:id/backfill-training
 * Isi ai_training_examples dari jawaban RS ASLI (jawaban_rs_manual, hasil
 * import Excel) — BEDA dari generate-all-drafts (itu bikin draft BARU pakai
 * AI, belum tentu sama dengan yang sungguhan dipakai RS dulu). Di sini kita
 * pakai pasangan alasan_raw + jawaban_rs_manual APA ADANYA (real ground
 * truth dari histori), diringkas Kimi K3 sama seperti alur draft biasa
 * (lihat recordKimiTrainingExample) — supaya RAG belajar dari kejadian
 * NYATA, bukan karangan AI yang belum terbukti manjur.
 * Cuma proses baris yang: sudah ke-link ke claim_record (claim_record_id
 * ada — perlu data klinis buat konteks), alasan_raw ada, dan jawaban_rs_manual
 * ada (kalau kosong, tidak ada yang bisa dipelajari dari baris itu).
 * Dedup: lewati kalau alasan_raw yang sama persis sudah pernah tercatat di
 * ai_training_examples (mis. file yang sama diproses ulang).
 */
router.post('/pending-files/:id/backfill-training', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare('SELECT id FROM bpjs_pending_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File pending tidak ditemukan.' });

    const rows = await db.prepare(`
      SELECT * FROM bpjs_pending_responses
      WHERE pending_file_id = ? AND claim_record_id IS NOT NULL
        AND alasan_raw IS NOT NULL AND alasan_raw != ''
        AND jawaban_rs_manual IS NOT NULL AND jawaban_rs_manual != ''
    `).all(req.params.id);

    let done = 0, skippedDuplicate = 0, error = 0;
    await runWithConcurrencyLimit(rows, 3, async (row) => {
      try {
        const dup = await db.prepare(`
          SELECT id FROM ai_training_examples WHERE alasan_bpjs = ? LIMIT 1
        `).get(row.alasan_raw);
        if (dup) { skippedDuplicate++; return; }

        await recordKimiTrainingExample(db, row.alasan_raw, row.jawaban_rs_manual, null);
        done++;
      } catch (err) {
        console.error('[bpjsPending] backfill-training gagal untuk row', row.id, ':', err.message);
        error++;
      }
    });

    res.json({ processed: rows.length, done, skipped_duplicate: skippedDuplicate, error });
  } catch (err) {
    console.error('[bpjsPending] backfill-training error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * DELETE /api/v1/records/pending-files/:id
 * Hapus 1 file rekap pending BPJS beserta semua baris di dalamnya — untuk
 * cleanup setelah testing. pending_file_id di bpjs_pending_responses TIDAK
 * punya FK/cascade (kolom TEXT biasa), jadi harus 2 langkah eksplisit dalam
 * 1 transaction.
 */
router.delete('/pending-files/:id', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare('SELECT id FROM bpjs_pending_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File pending tidak ditemukan.' });

    await db.transaction(async (tx) => {
      await tx.prepare('DELETE FROM bpjs_pending_responses WHERE pending_file_id = ?').run(req.params.id);
      await tx.prepare('DELETE FROM bpjs_pending_files WHERE id = ?').run(req.params.id);
    });

    res.json({ message: 'File pending berhasil dihapus.' });
  } catch (err) {
    console.error('[bpjsPending] delete pending-file error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * DELETE /api/v1/records/pending-files/bulk-delete-by-user/:userId
 * Hapus SEMUA file rekap pending BPJS (+ isinya) yang diupload oleh 1 user
 * tertentu (kolom uploaded_by) — dipakai untuk cleanup akhir sesi testing
 * multi-bulan, di mana file diupload manual lewat web sehingga tidak ada log
 * id untuk dihapus satu-satu. Tidak menyentuh ai_training_examples sama
 * sekali — hasil training Kimi tetap tersimpan meski data pending dihapus.
 */
router.delete('/pending-files/bulk-delete-by-user/:userId', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { userId } = req.params;
    const db = getDb();
    const files = await db.prepare('SELECT id FROM bpjs_pending_files WHERE uploaded_by = ?').all(userId);
    const fileIds = files.map(f => f.id);

    let deletedResponses = 0;
    if (fileIds.length > 0) {
      await db.transaction(async (tx) => {
        const respResult = await tx.run('DELETE FROM bpjs_pending_responses WHERE pending_file_id = ANY(?)', [fileIds]);
        deletedResponses = respResult.changes;
        await tx.run('DELETE FROM bpjs_pending_files WHERE id = ANY(?)', [fileIds]);
      });
    }

    res.json({ deletedFiles: fileIds.length, deletedResponses });
  } catch (err) {
    console.error('[bpjsPending] bulk-delete-by-user error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

module.exports = router;
