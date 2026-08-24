const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { parseClaimFile, normalizeColumnName } = require('../services/fileParser');
const { validateRecord, determineStatus } = require('../services/ruleEngine');
const { generateExcel } = require('../services/exportService');
const { logAudit } = require('../services/auditService');
const { estimatePromptTokens, estimateCompletionTokens } = require('../services/aiValidationService');
const { generateAiReview } = require('../services/aiReviewService');
const { getRelevantKnowledge, recordKnowledge, getRelevantBpjsExamples } = require('../services/errorKnowledgeService');
const { matchPrbCategory } = require('../services/prbRules');
const { linkPendingBpjsForSep } = require('../services/bpjsPendingLink');

const router = express.Router();

// OCR (tesseract.js) berat di CPU dan makan waktu tak terduga. Sebelumnya tiap
// panggilan ke /ocr-pages yang belum ada hasilnya langsung memicu proses baru
// dengan Promise.race + setTimeout — tapi setTimeout cuma membuat REQUEST-nya
// "gagal" duluan, proses tesseract di baliknya TETAP jalan tak bisa dibatalkan,
// dan hasilnya dibuang (tidak pernah disimpan). Akibatnya: tiap kali user buka
// ulang panel OCR (karena kelihatan gagal), proses baru menumpuk di atas yang
// lama tanpa henti — CPU 100%+ terus-menerus dan tidak pernah ada yang selesai.
// Map ini memastikan HANYA SATU proses OCR berjalan per record: request lain
// yang datang saat proses masih berjalan ikut menunggu proses YANG SAMA, dan
// hasilnya tetap disimpan ke DB begitu selesai — walau request HTTP asal yang
// memicunya sudah keburu timeout duluan di sisi client.
const ocrJobsInFlight = new Map(); // record_id -> Promise<ocrResult>

async function saveOcrResultsToDb(db, recordId, ocrResult) {
  if (!ocrResult.success || !ocrResult.pages || ocrResult.pages.length === 0) return;
  const insertOcrResult = db.prepare(`
    INSERT INTO ocr_results (id, record_id, page_number, ocr_text, confidence, block_count, processing_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id, page_number) DO UPDATE SET
      ocr_text = excluded.ocr_text,
      confidence = excluded.confidence,
      block_count = excluded.block_count,
      processing_duration_ms = excluded.processing_duration_ms
  `);
  for (const page of ocrResult.pages) {
    await insertOcrResult.run(
      uuidv4(), recordId, page.page_number,
      page.text || '', page.confidence || 0, page.block_count || 0,
      page.duration_ms || 0
    );
  }
}

// Jalankan (atau gabung ke) satu-satunya proses OCR aktif untuk record ini.
// Hasil SELALU disimpan ke DB begitu proses benar-benar selesai, terlepas dari
// apakah request HTTP yang memicunya masih menunggu atau sudah timeout duluan.
function runDedupedOcr(db, recordId, filePath, pageNumbers, ocrPdfPages) {
  let job = ocrJobsInFlight.get(recordId);
  if (!job) {
    job = ocrPdfPages(filePath, pageNumbers)
      .then(async (result) => {
        await saveOcrResultsToDb(db, recordId, result);
        return result;
      })
      .finally(() => ocrJobsInFlight.delete(recordId));
    ocrJobsInFlight.set(recordId, job);
  }
  return job;
}

/**
 * Kumpulkan bukti dokumen (OCR halaman scan + teks native non-klaim) untuk
 * satu record — dipakai AI review tahap kedua untuk verifikasi kode
 * diagnosis/prosedur. Sebelumnya logika ini ada di route /audit-suggestions
 * (dipicu manual oleh tombol UI yang sudah dihapus); sekarang dipanggil
 * langsung dari server sebagai bagian dari alur upload/validasi otomatis.
 */
async function gatherEvidencePool(db, recordId, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  // Toggle SKIP_OCR_EVIDENCE (default false = perilaku lama): kalau true,
  // lewati seluruh langkah OCR halaman scan — evidence pool tetap terisi dari
  // teks NATIVE (born-digital) yang murah, hanya verifikasi bukti dari halaman
  // scan yang tidak dilakukan. Dipakai untuk sesi testing massal di server
  // 4-core: OCR Tesseract adalah bottleneck CPU sejati saat banyak file ranap
  // diproses paralel (CPU bisa >1000%, semua core habis), dan OCR di sini hanya
  // memengaruhi saran kode sekunder, BUKAN data klaim inti maupun pencocokan
  // pending BPJS. Set env di docker-compose/.env server lalu restart container.
  if (process.env.SKIP_OCR_EVIDENCE === 'true') return [];

  let ocrResults = await db.prepare(`
    SELECT page_number, ocr_text, confidence FROM ocr_results
    WHERE record_id = ? ORDER BY page_number ASC
  `).all(recordId);

  // Kalau belum pernah di-OCR, coba jalankan sekarang (dibatasi waktu — kalau
  // lama, lanjut tanpa bukti OCR daripada bikin upload menggantung).
  // 180 detik (naik dari 120 — item 10): worker pool OCR sudah di-reuse (lihat
  // ocrService.js), jadi timeout di sini sekarang murni soal dokumen yang
  // BENAR-BENAR berat (banyak halaman/gambar padat), bukan lagi soal cold-start
  // worker. Kalau timeout tetap terlampaui, upload tetap lanjut tanpa bukti OCR
  // (evidence pool kosong) — tidak fatal, cuma saran kode/verifikasi bukti dari
  // OCR yang tidak muncul untuk record itu; data klaim inti tetap tersimpan benar.
  if (ocrResults.length === 0) {
    try {
      const { isAvailable, ocrPdfPages } = require('../services/ocrService');
      if (isAvailable()) {
        const ocrResult = await Promise.race([
          runDedupedOcr(db, recordId, filePath, 'auto-scan', ocrPdfPages),
          new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout')), 180000)),
        ]);
        if (ocrResult.success && ocrResult.pages?.length > 0) {
          ocrResults = await db.prepare(`
            SELECT page_number, ocr_text, confidence FROM ocr_results
            WHERE record_id = ? ORDER BY page_number ASC
          `).all(recordId);
        }
      }
    } catch (ocrErr) {
      console.warn(`[gatherEvidencePool] OCR gagal/timeout untuk record ${recordId}: ${ocrErr.message}`);
    }
  }

  let evidencePool = [...ocrResults];
  try {
    const { classifyPdfPages } = require('../services/pdfPageClassifier');
    const classified = await classifyPdfPages(filePath);
    if (classified.success) {
      const scanPageNumbers = new Set(ocrResults.map(o => o.page_number));
      // PENTING: kecualikan HANYA halaman "Berkas Klaim Individual" sungguhan
      // (is_primary_source) — itu SUMBER ASLI ekstraksi DIAGLIST/PROCLIST, kalau
      // ikut dimasukkan audit jadi sirkular (kode "terbukti" cuma karena
      // tertulis di halaman asalnya sendiri). SENGAJA BUKAN has_claim_data (itu
      // sengaja luas — mencakup halaman SEP/Resume Medis/SPRI supaya field
      // SEP/NOKARTU/DPJP ikut terbaca saat ekstraksi) — kalau exclude pakai
      // has_claim_data di sini, halaman Resume Medis/SPRI yang justru berisi
      // bukti klinis ASLI (diagnosa, tindakan) ikut ter-buang secara tidak
      // sengaja dari evidence pool, padahal bukan sumber sirkular.
      const nativePages = classified.pages
        .filter(p => p.type === 'NATIVE' && !p.is_primary_source && !scanPageNumbers.has(p.page_num) && p.text_length > 0)
        .map(p => ({ page_number: p.page_num, ocr_text: p.text_full, confidence: 100 }));
      evidencePool = [...evidencePool, ...nativePages];
    }
  } catch (classifyErr) {
    console.warn(`[gatherEvidencePool] Gagal ambil halaman NATIVE: ${classifyErr.message}`);
  }

  return evidencePool;
}

// Batasi jumlah panggilan AI review paralel saat upload bulk — evidence
// pool kosong untuk bulk (tanpa PDF) jadi ini murni field_notes, tapi tetap
// dibatasi supaya file besar dengan banyak record error tidak membanjiri
// provider AI sekaligus.
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

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
// Absolut & tidak bergantung CWD proses (pm2/systemd/docker): diresolusi dari
// lokasi file ini, bukan dari direktori aktif. Multer dan pencarian file (baik
// path baru maupun fallback) memakai basis yang sama.
const RESOLVED_UPLOAD_DIR = path.resolve(__dirname, '..', '..', UPLOAD_DIR);
if (!fs.existsSync(RESOLVED_UPLOAD_DIR)) {
  fs.mkdirSync(RESOLVED_UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RESOLVED_UPLOAD_DIR),
  filename: (req, file, cb) => {
    // path.basename meniadakan upaya traversal (..\ atau ../) lewat originalname.
    const uniqueName = `${Date.now()}-${uuidv4().substring(0, 8)}-${path.basename(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, 
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.txt', '.tsv', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file TXT, TSV, atau CSV yang diperbolehkan.'));
    }
  }
});


router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  const io = req.app.get('io');
  let fileId = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File tidak ditemukan.' });
    }

    const db = getDb();
    const { period, description } = req.body;
    fileId = req.body.fileId || uuidv4();

    await db.prepare(`
      INSERT INTO claim_files (id, hospital_code, file_name, file_path, period, status, uploaded_by, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, req.user.hospital_code, req.file.originalname, path.resolve(req.file.path), period || null, req.user.id, description || null);

    if (io) io.emit('validation:status', { fileId, status: 'parsing', progress: 10, message: 'Membaca file...' });

    await db.prepare('UPDATE claim_files SET status = ? WHERE id = ?').run('parsing', fileId);
    const parseResult = parseClaimFile(req.file.path);

    if (parseResult.errors.length > 0 && parseResult.records.length === 0) {
      await db.prepare('UPDATE claim_files SET status = ?, error_message = ? WHERE id = ?')
        .run('error', parseResult.errors.map(e => e.message).join('; '), fileId);

      if (io) io.emit('validation:error', { fileId, errors: parseResult.errors });
      return res.status(400).json({ file_id: fileId, status: 'error', errors: parseResult.errors });
    }

    if (io) io.emit('validation:status', { fileId, status: 'validating', progress: 15, message: 'Memproses validasi aturan...' });

    const detectedPeriod = period || parseResult.metadata.period;
    await db.prepare("UPDATE claim_files SET status = ?, total_records = ?, period = ?, column_count = ?, parsed_at = datetime('now') WHERE id = ?")
      .run('validating', parseResult.records.length, detectedPeriod, parseResult.metadata.columnCount, fileId);

    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();

    let validCount = 0;
    let errorCount = 0;
    let pendingCount = 0;

    await db.transaction(async (tx) => {
      const txInsertRecord = tx.prepare(`
        INSERT INTO claim_records (
          id, file_id, row_number, kode_rs, sep, nokartu, nama_pasien, mrn,
          birth_date, umur_tahun, umur_hari, gender, kelas_rawat, kelas_rs,
          admission_date, discharge_date, discharge_status, los,
          diagnosa_list, prosedur_list, inacbg_code, deskripsi_inacbg,
          tarif_inacbg, tarif_rs, total_tarif, tarif_poli_eks,
          icu_indikator, icu_los, vent_hour, birth_weight,
          dpjp_name, payor_id, coder_id, jenis_rawat,
          jenis_konsultasi, jumlah_episode_klaim, is_same_day,
          histori_obat_kronis_bulan_berturut, status_pasien, flag_rujuk_balik_prb,
          urutan_iterasi, jenis_klaim,
          validation_status, error_count, raw_data
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const txInsertError = tx.prepare(`
        INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let idx = 0; idx < parseResult.records.length; idx++) {
        const record = parseResult.records[idx];
        const recordId = uuidv4();
        const errors = validateRecord(record, activeRules);
        const status = determineStatus(errors);

        if (status === 'valid') validCount++;
        else if (status === 'error') errorCount++;
        else pendingCount++;

        await txInsertRecord.run(
          recordId, fileId, record._rowNumber || idx + 1,
          record.kode_rs || '', record.sep || '', record.nokartu || '',
          record.nama_pasien || '', record.mrn || '',
          record.birth_date || null,
          record.umur_tahun || 0, record.umur_hari || 0,
          record.gender || '', record.kelas_rawat || 0, record.kelas_rs || '',
          record.admission_date || null, record.discharge_date || null,
          record.discharge_status || 0, record.los || 0,
          record.diagnosa_list || '', record.prosedur_list || '',
          record.inacbg_code || '', record.deskripsi_inacbg || '',
          record.tarif_inacbg || 0, record.tarif_rs || 0,
          record.total_tarif || 0, record.tarif_poli_eks || 0,
          record.icu_indikator || 0, record.icu_los || 0,
          record.vent_hour || 0, record.birth_weight || 0,
          record.dpjp_name || '', record.payor_id || '',
          record.coder_id || '', record.jenis_rawat || '',
          record.jenis_konsultasi || '', record.jumlah_episode_klaim || 1,
          record.is_same_day || 0, record.histori_obat_kronis_bulan_berturut || 0,
          record.status_pasien || 'STABIL', record.flag_rujuk_balik_prb || 0,
          record.urutan_iterasi || 0, record.jenis_klaim || 'RAWAT_INAP',
          status, errors.length, JSON.stringify(record._rawData || {})
        );

        // Insert errors
        for (const err of errors) {
          await txInsertError.run(
            uuidv4(), recordId, err.rule_id, err.field_name,
            err.error_message, err.expected_value || '', err.actual_value || '',
            err.severity
          );
        }

        // Progress updates every 50 records (range 15% - 30%)
        if (io && idx % 50 === 0) {
          const progress = 15 + Math.round((idx / parseResult.records.length) * 15);
          io.emit('validation:status', { fileId, status: 'validating', progress, message: `Menjalankan validasi aturan: ${idx}/${parseResult.records.length} rekor` });
        }
      }
    });

    // Alur AI ekstraksi -> rule engine -> AI review — ONLY error/pending
    // records (skip valid, hemat token). Evidence pool selalu kosong di sini
    // (upload bulk TXT/CSV tidak punya PDF), jadi AI review cuma hasilkan
    // field_notes, bukan verifikasi kode diagnosa/prosedur.
    if (io) io.emit('validation:status', { fileId, status: 'ai_auditing', progress: 30, message: 'Menghubungkan ke AI Auditor...' });

    const allRecords = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(fileId);
    const recordsToAudit = allRecords.filter(r => r.validation_status !== 'valid');

    let totalAiTokens = 0;
    if (recordsToAudit.length > 0) {
      const allErrorsRaw = await db.prepare('SELECT * FROM validation_errors WHERE record_id IN (SELECT id FROM claim_records WHERE file_id = ?)').all(fileId);
      const errorsByRecordId = allErrorsRaw.reduce((acc, e) => {
        (acc[e.record_id] ||= []).push(e);
        return acc;
      }, {});

      let completedCount = 0;
      await runWithConcurrencyLimit(recordsToAudit, 5, async (record) => {
        try {
          const recordErrors = errorsByRecordId[record.id] || [];
          const knowledgeEntries = await getRelevantKnowledge(db, recordErrors.map(e => e.rule_id));
          const bpjsExamples = await getRelevantBpjsExamples(db);
          const aiReview = await generateAiReview(record, recordErrors, [], knowledgeEntries, bpjsExamples);
          if (aiReview) {
            totalAiTokens += aiReview.tokens_used || 0;
            await db.prepare('UPDATE claim_records SET ai_review = ? WHERE id = ?')
              .run(JSON.stringify(aiReview), record.id);
            recordKnowledge(db, aiReview.knowledge_updates).catch(kbErr =>
              console.warn(`[AI Review] Gagal simpan knowledge base: ${kbErr.message}`));
          }
        } catch (aiErr) {
          console.warn(`[AI Review] gagal untuk record ${record.id}: ${aiErr.message}`);
        } finally {
          completedCount++;
          if (io) {
            const progress = 30 + Math.round((completedCount / recordsToAudit.length) * 65);
            io.emit('validation:status', { fileId, status: 'ai_auditing', progress, message: `AI Review: ${completedCount}/${recordsToAudit.length} record` });
          }
        }
      });
    }

    // Save token usage
    if (totalAiTokens > 0) {
      await db.prepare(`
        UPDATE claim_files SET ai_total_tokens = ? WHERE id = ?
      `).run(totalAiTokens, fileId);
    }

    // Update file status to completed
    await db.prepare(`
      UPDATE claim_files
      SET status = 'completed', valid_count = ?, error_count = ?, pending_count = ?, validated_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(validCount, errorCount, pendingCount, fileId);

    // Cleanup uploaded file
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }

    // Audit log
    logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'upload_and_validate',
      resourceType: 'claim_file',
      resourceId: fileId,
      details: {
        fileName: req.file.originalname,
        totalRecords: parseResult.records.length,
        valid: validCount,
        error: errorCount,
        pending: pendingCount,
        columnCount: parseResult.metadata.columnCount
      },
      ipAddress: req.ip
    });

    if (io) {
      io.emit('validation:status', { fileId, status: 'completed', progress: 100, message: 'Validasi Selesai!' });
      io.emit('validation:complete', { fileId, summary: { valid: validCount, error: errorCount, pending: pendingCount } });
    }

    res.status(202).json({
      file_id: fileId,
      status: 'completed',
      message: 'File berhasil diproses',
      summary: {
        total_records: parseResult.records.length,
        valid: validCount,
        error: errorCount,
        pending: pendingCount
      }
    });
  } catch (err) {
    console.error('Upload error:', err);
    if (fileId) {
      try {
        const db = getDb();
        await db.prepare('UPDATE claim_files SET status = ?, error_message = ? WHERE id = ?')
          .run('error', err.message, fileId);
      } catch (e) { /* ignore */ }
    }
    res.status(500).json({ error: 'Gagal memproses file: ' + err.message });
  }
});

/**
 * GET /api/v1/claim-files
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 20, status, jenis_klaim, from_date, to_date, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];

    if (status) {
      where += ' AND cf.status = ?';
      params.push(status);
    }

    if (jenis_klaim) {
      where += ' AND cf.jenis_klaim = ?';
      params.push(jenis_klaim);
    }

    // from_date/to_date: filter berdasar tanggal upload (created_at), inklusif
    // kedua ujung — to_date ditambah 'T23:59:59' supaya hari itu ikut penuh
    // (bukan cuma sampai 00:00:00-nya).
    if (from_date) {
      where += ' AND cf.created_at >= ?';
      params.push(from_date);
    }
    if (to_date) {
      where += ' AND cf.created_at <= ?';
      params.push(to_date + 'T23:59:59');
    }

    // search: cocokkan nama pasien atau SEP. Untuk file PDF (1 file = 1 record)
    // ini selalu record itu sendiri, tapi file legacy TXT/Excel bisa berisi
    // RATUSAN record — subquery SEP/nama_pasien di bawah HARUS menampilkan
    // record yang BENAR-BENAR cocok dengan pencarian, bukan selalu record
    // pertama (row_number=1) seperti sebelumnya. Sebelumnya ini bug: cari SEP
    // manapun yang ada di dalam file itu tetap menampilkan SEP record #1 —
    // jadi kelihatan seperti "hasil pencarian salah" padahal filenya memang
    // benar ketemu, cuma kolomnya yang salah tampil.
    let displaySepSubquery = `(SELECT sep FROM claim_records WHERE file_id = cf.id ORDER BY row_number LIMIT 1) as sep`;
    let displayNamaSubquery = `(SELECT nama_pasien FROM claim_records WHERE file_id = cf.id ORDER BY row_number LIMIT 1) as nama_pasien`;

    if (search) {
      const like = `%${search}%`;
      where += ` AND cf.id IN (
        SELECT file_id FROM claim_records
        WHERE nama_pasien LIKE ? OR sep LIKE ?
      )`;
      params.push(like, like);

      displaySepSubquery = `(
        SELECT sep FROM claim_records WHERE file_id = cf.id
        ORDER BY CASE WHEN nama_pasien LIKE ? OR sep LIKE ? THEN 0 ELSE 1 END, row_number
        LIMIT 1
      ) as sep`;
      displayNamaSubquery = `(
        SELECT nama_pasien FROM claim_records WHERE file_id = cf.id
        ORDER BY CASE WHEN nama_pasien LIKE ? OR sep LIKE ? THEN 0 ELSE 1 END, row_number
        LIMIT 1
      ) as nama_pasien`;
    }

    const totalResult = await db.prepare(`SELECT COUNT(*) as count FROM claim_files cf ${where}`).get(...params);
    const total = Number(totalResult ? totalResult.count : 0);

    // Urutan parameter di SELECT list (subquery SEP dulu, baru nama_pasien)
    // harus PERSIS sama dengan urutan placeholder ? di string SQL-nya.
    const selectParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`] : [];

    const filesRaw = await db.prepare(`
      SELECT cf.*, u.full_name as uploaded_by_name,
        ${displaySepSubquery},
        ${displayNamaSubquery}
      FROM claim_files cf
      LEFT JOIN users u ON cf.uploaded_by = u.id
      ${where}
      ORDER BY cf.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...selectParams, ...params, parseInt(limit), offset);

    const files = filesRaw.map(f => ({
      ...f,
      total_records: Number(f.total_records || 0),
      valid_count: Number(f.valid_count || 0),
      error_count: Number(f.error_count || 0),
      pending_count: Number(f.pending_count || 0),
      ai_prompt_tokens: Number(f.ai_prompt_tokens || 0),
      ai_completion_tokens: Number(f.ai_completion_tokens || 0),
      ai_total_tokens: Number(f.ai_total_tokens || 0)
    }));

    res.json({ total, page: parseInt(page), limit: parseInt(limit), files });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const fileRaw = await db.prepare(`
      SELECT cf.*, u.full_name as uploaded_by_name, ua.full_name as approved_by_name
      FROM claim_files cf
      LEFT JOIN users u ON cf.uploaded_by = u.id
      LEFT JOIN users ua ON cf.approved_by = ua.id
      WHERE cf.id = ?
    `).get(req.params.id);

    if (!fileRaw) return res.status(404).json({ error: 'File tidak ditemukan.' });

    // PDF asli tersimpan & bisa disajikan ke halaman review (path valid, .pdf, ada di disk).
    const has_pdf = !!resolvePdfPath(fileRaw);

    const file = {
      ...fileRaw,
      has_pdf,
      total_records: Number(fileRaw.total_records || 0),
      valid_count: Number(fileRaw.valid_count || 0),
      error_count: Number(fileRaw.error_count || 0),
      pending_count: Number(fileRaw.pending_count || 0),
      ai_prompt_tokens: Number(fileRaw.ai_prompt_tokens || 0),
      ai_completion_tokens: Number(fileRaw.ai_completion_tokens || 0),
      ai_total_tokens: Number(fileRaw.ai_total_tokens || 0)
    };

    // Get error summary by rule
    const errorsByRuleRaw = await db.prepare(`
      SELECT ve.rule_id, vr.rule_name, ve.severity, COUNT(*) as count
      FROM validation_errors ve
      JOIN claim_records cr ON ve.record_id = cr.id
      JOIN validation_rules vr ON ve.rule_id = vr.id
      WHERE cr.file_id = ?
      GROUP BY ve.rule_id, vr.rule_name, ve.severity
      ORDER BY count DESC
    `).all(req.params.id);

    const errorsByRule = errorsByRuleRaw.map(e => ({
      ...e,
      count: Number(e.count)
    }));

    res.json({ ...file, error_summary: errorsByRule });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id/records
 */
router.get('/:id/records', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { status = 'all', page = 1, limit = 50, search, error_type } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE cr.file_id = ?';
    const params = [req.params.id];

    if (status !== 'all') {
      where += ' AND cr.validation_status = ?';
      params.push(status);
    }

    if (search) {
      where += ' AND (cr.nama_pasien ILIKE ? OR cr.sep ILIKE ? OR cr.nokartu ILIKE ? OR cr.inacbg_code ILIKE ?)';
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam, searchParam);
    }

    if (error_type) {
      where += ' AND cr.id IN (SELECT record_id FROM validation_errors WHERE rule_id = ?)';
      params.push(error_type);
    }

    const totalResult = await db.prepare(`SELECT COUNT(*) as count FROM claim_records cr ${where}`).get(...params);
    const total = Number(totalResult ? totalResult.count : 0);

    const records = await db.prepare(`
      SELECT cr.* FROM claim_records cr ${where}
      ORDER BY cr.row_number ASC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    // Attach errors to each record — satu query IN(...) untuk semua record di
    // halaman ini, bukan satu query per record (N+1 yang bikin loading lambat
    // untuk file dengan banyak record per halaman).
    let errorsByRecordId = {};
    if (records.length > 0) {
      const recordIds = records.map(r => r.id);
      const placeholders = recordIds.map(() => '?').join(',');
      const allErrors = await db.prepare(`
        SELECT ve.*, vr.rule_name FROM validation_errors ve
        JOIN validation_rules vr ON ve.rule_id = vr.id
        WHERE ve.record_id IN (${placeholders})
      `).all(...recordIds);

      errorsByRecordId = allErrors.reduce((acc, err) => {
        (acc[err.record_id] ||= []).push(err);
        return acc;
      }, {});
    }

    const recordsWithErrors = records.map(rec => ({
      ...rec,
      errors: errorsByRecordId[rec.id] || [],
    }));

    res.json({ total, page: parseInt(page), limit: parseInt(limit), records: recordsWithErrors });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// Helper to reconstruct fixed file content
async function getFixedFileContent(fileId, db) {
  const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(fileId);
  if (!file) throw new Error('File tidak ditemukan.');

  const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(fileId);
  if (records.length === 0) {
    throw new Error('Tidak ada rekor data untuk file ini.');
  }

  let headers = [];
  try {
    const firstRaw = JSON.parse(records[0].raw_data || '{}');
    headers = Object.keys(firstRaw);
  } catch (e) {
    headers = [
      'KODE_RS', 'KELAS_RS', 'KELAS_RAWAT', 'KODE_TARIF', 'PTD', 'ADMISSION_DATE', 'DISCHARGE_DATE',
      'BIRTH_DATE', 'BIRTH_WEIGHT', 'SEX', 'DISCHARGE_STATUS', 'DIAGLIST', 'PROCLIST', 'ADL1', 'ADL2',
      'IN_SP', 'IN_SR', 'IN_SI', 'IN_SD', 'INACBG', 'SUBACUTE', 'CHRONIC', 'SP', 'SR', 'SI', 'SD',
      'DESKRIPSI_INACBG', 'TARIF_INACBG', 'TARIF_SUBACUTE', 'TARIF_CHRONIC', 'DESKRIPSI_SP', 'TARIF_SP',
      'DESKRIPSI_SR', 'TARIF_SR', 'DESKRIPSI_SI', 'TARIF_SI', 'DESKRIPSI_SD', 'TARIF_SD', 'TOTAL_TARIF',
      'TARIF_RS', 'TARIF_POLI_EKS', 'LOS', 'ICU_INDIKATOR', 'ICU_LOS', 'VENT_HOUR', 'NAMA_PASIEN',
      'MRN', 'UMUR_TAHUN', 'UMUR_HARI', 'DPJP', 'SEP', 'NOKARTU', 'PAYOR_ID', 'CODER_ID', 'VERSI_INACBG',
      'VERSI_GROUPER', 'C1', 'C2', 'C3', 'C4'
    ];
  }

  const outputLines = [];
  outputLines.push(headers.join('\t'));

  records.forEach(rec => {
    let rawDataObj = {};
    try {
      rawDataObj = JSON.parse(rec.raw_data || '{}');
    } catch (e) { /* ignore */ }

    const sepKey = Object.keys(rawDataObj).find(k => normalizeColumnName(k) === 'sep') || 'SEP';
    rawDataObj[sepKey] = rec.sep;

    const nokartuKey = Object.keys(rawDataObj).find(k => normalizeColumnName(k) === 'nokartu') || 'NOKARTU';
    rawDataObj[nokartuKey] = rec.nokartu;

    const rowValues = headers.map(header => {
      const val = rawDataObj[header];
      return val !== undefined && val !== null ? val : '';
    });

    outputLines.push(rowValues.join('\t'));
  });

  const fileContent = outputLines.join('\r\n');
  const safeName = "PERBAIKAN_" + file.file_name.replace(/\.[^/.]+$/, "") + ".TXT";

  return { fileContent, fileName: safeName, file };
}

/**
 * POST /api/v1/claim-files/:id/approve
 */
router.post('/:id/approve', authenticate, authorize('supervisor', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });
    if (file.status !== 'completed') {
      return res.status(400).json({ error: 'File belum selesai divalidasi.' });
    }

    await db.prepare(`
      UPDATE claim_files SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(req.user.id, req.params.id);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'approve', resourceType: 'claim_file', resourceId: req.params.id,
      ipAddress: req.ip
    });

    // Check if SIMRS Callback URL is configured
    const callbackUrl = process.env.SIMRS_CALLBACK_URL;
    let callbackStatus = 'not_configured';
    let callbackError = null;

    if (callbackUrl) {
      try {
        const { fileContent, fileName } = await getFixedFileContent(req.params.id, db);
        
        const formData = new FormData();
        const fileBlob = new Blob([fileContent], { type: 'text/plain' });
        formData.append('file', fileBlob, fileName);
        formData.append('file_id', req.params.id);
        formData.append('original_name', file.file_name);
        formData.append('records_count', String(file.total_records));

        const callbackHeaders = {};
        if (process.env.SIMRS_CALLBACK_API_KEY) {
          callbackHeaders['X-API-Key'] = process.env.SIMRS_CALLBACK_API_KEY;
        }

        const response = await fetch(callbackUrl, {
          method: 'POST',
          body: formData,
          headers: callbackHeaders
        });

        if (!response.ok) {
          throw new Error(`SIMRS returned status ${response.status}: ${await response.text().catch(() => '')}`);
        }

        callbackStatus = 'sent';
        logAudit({
          userId: req.user.id, userEmail: req.user.email,
          action: 'callback_success', resourceType: 'claim_file', resourceId: req.params.id,
          details: { callbackUrl, status: response.status },
          ipAddress: req.ip
        });
      } catch (callbackErr) {
        callbackStatus = 'failed';
        callbackError = callbackErr.message;
        console.error(`❌ Failed to send approved claim file callback to SIMRS:`, callbackErr);
        
        logAudit({
          userId: req.user.id, userEmail: req.user.email,
          action: 'callback_failure', resourceType: 'claim_file', resourceId: req.params.id,
          details: { callbackUrl, error: callbackErr.message },
          ipAddress: req.ip
        });
      }
    }

    res.json({ 
      file_id: req.params.id, 
      status: 'approved', 
      approved_at: new Date().toISOString(), 
      approved_by: req.user.id, 
      message: 'File disetujui, siap dikirim ke vClaim',
      callback_status: callbackStatus,
      callback_error: callbackError
    });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id/export
 */
router.get('/:id/export', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const { filter = 'error' } = req.query;

    const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(req.params.id);
    const getErrors = db.prepare('SELECT * FROM validation_errors WHERE record_id = ?');

    const recordsWithErrors = [];
    for (const rec of records) {
      const errors = await getErrors.all(rec.id);
      recordsWithErrors.push({
        ...rec,
        errors
      });
    }

    const buffer = generateExcel(recordsWithErrors, file, filter);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'export', resourceType: 'claim_file', resourceId: req.params.id,
      details: { format: 'excel', filter },
      ipAddress: req.ip
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=validasi_${file.file_name || 'klaim'}_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/:id/ai-audit
 * Runs AI-assisted medical audit on all records of a claim file.
 */
router.post('/:id/ai-audit', authenticate, async (req, res) => {
  const io = req.app.get('io');
  const fileId = req.params.id;

  try {
    const db = getDb();
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(fileId);
    if (!file) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    // Get all records for this file
    const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(fileId);
    if (records.length === 0) {
      return res.status(400).json({ error: 'Tidak ada rekor data untuk diaudit.' });
    }

    // Emit start status
    if (io) io.emit('ai-audit:status', { fileId, status: 'auditing', progress: 0 });

    // Kalau file ini punya PDF asli, kumpulkan bukti dokumen sekali (dipakai
    // untuk semua record file ini — biasanya cuma 1 record untuk upload PDF).
    const pdfPath = resolvePdfPath(file);
    const evidencePoolCache = new Map(); // record_id -> evidencePool (reuse kalau lebih dari 1 record)

    const allErrorsRaw = await db.prepare('SELECT * FROM validation_errors WHERE record_id IN (SELECT id FROM claim_records WHERE file_id = ?)').all(fileId);
    const errorsByRecordId = allErrorsRaw.reduce((acc, e) => {
      (acc[e.record_id] ||= []).push(e);
      return acc;
    }, {});

    let completedCount = 0;
    await runWithConcurrencyLimit(records, 5, async (record) => {
      try {
        let evidencePool = [];
        if (pdfPath) {
          evidencePool = evidencePoolCache.get(record.id)
            || await gatherEvidencePool(db, record.id, pdfPath);
          evidencePoolCache.set(record.id, evidencePool);
        }
        const recordErrors = errorsByRecordId[record.id] || [];
        const knowledgeEntries = await getRelevantKnowledge(db, recordErrors.map(e => e.rule_id));
        const bpjsExamples = await getRelevantBpjsExamples(db);
        const aiReview = await generateAiReview(record, recordErrors, evidencePool, knowledgeEntries, bpjsExamples);
        if (aiReview) {
          await db.prepare('UPDATE claim_records SET ai_review = ? WHERE id = ?')
            .run(JSON.stringify(aiReview), record.id);
          recordKnowledge(db, aiReview.knowledge_updates).catch(kbErr =>
            console.warn(`[AI Review] Gagal simpan knowledge base: ${kbErr.message}`));
        }
      } catch (aiErr) {
        console.warn(`[AI Review] gagal untuk record ${record.id}: ${aiErr.message}`);
      } finally {
        completedCount++;
        if (io) {
          const progress = Math.round((completedCount / records.length) * 100);
          io.emit('ai-audit:status', { fileId, status: 'auditing', progress });
        }
      }
    });

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'ai_audit', resourceType: 'claim_file', resourceId: fileId,
      details: { totalRecords: records.length },
      ipAddress: req.ip
    });

    if (io) io.emit('ai-audit:complete', { fileId, totalRecords: records.length });

    res.json({
      message: `Audit AI berhasil diselesaikan untuk ${records.length} rekor.`,
      total_records: records.length
    });
  } catch (err) {
    console.error('AI Audit route error:', err);
    res.status(500).json({ error: 'Gagal menjalankan audit AI: ' + err.message });
  }
});

/**
 * DELETE /api/v1/claim-files/:id
 */
router.delete('/:id', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    await db.prepare('DELETE FROM claim_files WHERE id = ?').run(req.params.id);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'delete', resourceType: 'claim_file', resourceId: req.params.id,
      ipAddress: req.ip
    });

    res.json({ message: 'File berhasil dihapus.' });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/bulk-delete
 * Hapus banyak claim_files sekaligus dalam 1 request — dibutuhkan untuk
 * cleanup cepat setelah testing batch besar (mis. 10.000 file), karena
 * DELETE /:id satu-satu akan kena rate limiter global (100 req/menit,
 * lihat index.js) kalau dipanggil ribuan kali berturut-turut.
 * Body: { ids: string[] } (maks 500 per panggilan — sisanya di-chunk oleh
 * pemanggil, mis. scripts/bulkTestCleanup.js).
 */
router.post('/bulk-delete', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids wajib berupa array berisi minimal 1 file_id.' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: 'Maksimal 500 id per panggilan — bagi jadi beberapa batch.' });
    }
    const db = getDb();
    const result = await db.run('DELETE FROM claim_files WHERE id = ANY(?)', [ids]);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'bulk_delete', resourceType: 'claim_file', resourceId: ids.join(','),
      ipAddress: req.ip
    });

    res.json({ deleted: result.changes });
  } catch (err) {
    console.error('[claimFiles] bulk-delete error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * DELETE /api/v1/claim-files/bulk-delete-by-user/:userId
 * Hapus SEMUA claim_files yang diupload oleh 1 user tertentu (kolom
 * uploaded_by) — dipakai untuk cleanup akhir sesi testing multi-bulan di RS,
 * di mana file diupload manual lewat web (bukan lewat script), jadi tidak
 * ada log file_id untuk /bulk-delete biasa. Presisi berdasarkan akun
 * uploader, sehingga tidak pernah menyentuh data yang diupload staf lain.
 * Tidak menyentuh ai_training_examples sama sekali (tabel itu tidak punya
 * kolom user) — hasil training Kimi tetap tersimpan meski data claim/pending
 * dihapus dan diulang.
 */
router.delete('/bulk-delete-by-user/:userId', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { userId } = req.params;
    const db = getDb();
    const result = await db.run('DELETE FROM claim_files WHERE uploaded_by = ?', [userId]);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'bulk_delete_by_user', resourceType: 'claim_file', resourceId: userId,
      ipAddress: req.ip
    });

    res.json({ deleted: result.changes });
  } catch (err) {
    console.error('[claimFiles] bulk-delete-by-user error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id/ai-token-estimate
 * Estimate AI token usage for a file's error records
 */
router.get('/:id/ai-token-estimate', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const fileId = req.params.id;

    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? AND validation_status != ?').all(fileId, 'valid');

    if (records.length === 0) {
      return res.json({
        file_id: fileId,
        total_records: file.total_records,
        records_to_audit: 0,
        estimated_tokens: {
          prompt: 0,
          completion: 0,
          total: 0
        },
        per_record_avg: 0,
        cost_estimate_usd: 0,
        note: 'Semua record valid - tidak perlu AI audit'
      });
    }

    // Get error fields for estimation
    const errors = await db.prepare(`
      SELECT record_id, field_name FROM validation_errors
      WHERE record_id IN (SELECT id FROM claim_records WHERE file_id = ?)
    `).all(fileId);

    const errorFieldsByRecord = {};
    errors.forEach(err => {
      if (!errorFieldsByRecord[err.record_id]) {
        errorFieldsByRecord[err.record_id] = [];
      }
      if (!errorFieldsByRecord[err.record_id].includes(err.field_name)) {
        errorFieldsByRecord[err.record_id].push(err.field_name);
      }
    });

    const estimatedPrompt = estimatePromptTokens(records, errorFieldsByRecord);
    const estimatedCompletion = estimateCompletionTokens(records.length);
    const totalEstimate = estimatedPrompt + estimatedCompletion;

    // DeepSeek pricing: $0.014 per 1M input tokens, $0.042 per 1M output tokens
    const costEstimate = (estimatedPrompt * 0.014 + estimatedCompletion * 0.042) / 1_000_000;

    res.json({
      file_id: fileId,
      total_records: Number(file.total_records),
      records_to_audit: records.length,
      estimated_tokens: {
        prompt: estimatedPrompt,
        completion: estimatedCompletion,
        total: totalEstimate
      },
      per_record_avg: Math.round(totalEstimate / records.length),
      cost_estimate_usd: costEstimate.toFixed(6),
      cost_estimate_rp: Math.round(costEstimate * 16500),
      provider: 'deepseek-v4-flash'
    });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// PDF upload config — accept .pdf files
const pdfUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf') cb(null, true);
    else cb(new Error('Hanya file PDF yang diperbolehkan.'));
  }
});

// Field validation helper — keys match vClaim field names sent by FE (extract page)
function validateField(fieldName, value) {
  const rules = {
    NOKARTU: v => /^\d{13}$/.test((v || '').replace(/\D/g, '')) || 'Harus 13 digit angka',
    SEP: v => /^0170[A-Z0-9]{20}$/.test((v || '').toUpperCase()) || 'Format SEP invalid (0170...)',
    NAMA_PASIEN: v => (v || '').trim().length > 2 || 'Minimal 3 karakter',
    BIRTH_DATE: v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') || 'Format: YYYY-MM-DD',
    ADMISSION_DATE: v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') || 'Format: YYYY-MM-DD',
    DISCHARGE_DATE: v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') || 'Format: YYYY-MM-DD',
    KELAS_RAWAT: v => ['1', '2', '3'].includes(String(v || '')) || 'Hanya 1, 2, atau 3',
    SEX: v => ['L', 'P', 'Laki-laki', 'Perempuan', '1', '2'].includes(v || '') || 'L/P atau 1/2',
    DISCHARGE_STATUS: v => ['1', '2', '3', '4', '5'].includes(String(v || '')) || 'Hanya 1-5',
  };

  if (rules[fieldName] && value) {
    const result = rules[fieldName](value);
    return result === true ? null : result;
  }
  return null;
}

/**
 * POST /api/v1/claim-files/upload-pdf
 * Upload PDF dari SIMRS, extract field digital, SAVE immediately, return untuk user review
 */
// vClaim pakai DD/MM/YYYY; kolom tanggal di DB pakai YYYY-MM-DD.
function vclaimDateToISO(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((v || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Convert vClaim format (uppercase, vClaim field names) to database format (lowercase snake_case)
function vclaimToDbFormat(vclaimRecord) {
  const MAPPING = {
    'KODE_RS': 'kode_rs',
    'KELAS_RS': 'kelas_rs',
    'KELAS_RAWAT': 'kelas_rawat',
    'ADMISSION_DATE': 'admission_date',
    'DISCHARGE_DATE': 'discharge_date',
    'BIRTH_DATE': 'birth_date',
    'BIRTH_WEIGHT': 'birth_weight',
    'SEX': 'gender',
    'DISCHARGE_STATUS': 'discharge_status',
    'DIAGLIST': 'diagnosa_list',
    'PROCLIST': 'prosedur_list',
    'DESKRIPSI_INACBG': 'deskripsi_inacbg',
    'TARIF_INACBG': 'tarif_inacbg',
    'TARIF_RS': 'tarif_rs',
    'TARIF_POLI_EKS': 'tarif_poli_eks',
    'LOS': 'los',
    'ICU_INDIKATOR': 'icu_indikator',
    'ICU_LOS': 'icu_los',
    'VENT_HOUR': 'vent_hour',
    'NAMA_PASIEN': 'nama_pasien',
    'MRN': 'mrn',
    'UMUR_TAHUN': 'umur_tahun',
    'UMUR_HARI': 'umur_hari',
    'DPJP': 'dpjp_name',
    'SEP': 'sep',
    'NOKARTU': 'nokartu',
    'PAYOR_ID': 'payor_id',
    'CODER_ID': 'coder_id',
    'INACBG': 'inacbg_code',
    'TOTAL_TARIF': 'total_tarif',
    'KODE_TARIF': 'kode_tarif',
    'JENIS_RAWAT': 'jenis_rawat',
    'JENIS_KONSULTASI': 'jenis_konsultasi',
    'JUMLAH_EPISODE_KLAIM': 'jumlah_episode_klaim',
    'IS_SAME_DAY': 'is_same_day',
    'HISTORI_OBAT_KRONIS_BULAN_BERTURUT': 'histori_obat_kronis_bulan_berturut',
    'STATUS_PASIEN': 'status_pasien',
    'FLAG_RUJUK_BALIK_PRB': 'flag_rujuk_balik_prb',
    'URUTAN_ITERASI': 'urutan_iterasi',
    'JENIS_KLAIM': 'jenis_klaim',
    // POTENSI_PRB_SEP: BUKAN kolom vClaim resmi — flag "Potensi PRB" yang
    // dicetak sistem BPJS sendiri di halaman SEP (lihat pdfExtractionService.js
    // aturan 10a). Dipetakan ke kolom flag_rujuk_balik_prb yang SUDAH ADA di
    // skema DB (dipakai RV-15) tapi sebelum ini selalu kosong karena tidak ada
    // sumber datanya sama sekali — field ini baru dipetakan.
    'POTENSI_PRB_SEP': 'flag_rujuk_balik_prb',
    // KLINIK_SEP: nama klinik/poli dari SEP/Resume Medis (aturan 10c) — dipakai
    // detectInternalEpisodes() di bawah untuk cross-check RV-13/14.
    'KLINIK_SEP': 'klinik_poli',
  };

  const dbRecord = {};
  for (const [vclaimKey, dbKey] of Object.entries(MAPPING)) {
    const value = vclaimRecord[vclaimKey];
    if (value !== undefined && value !== null) {
      if (['admission_date', 'discharge_date', 'birth_date'].includes(dbKey)) {
        dbRecord[dbKey] = vclaimDateToISO(value);
      } else if (dbKey === 'flag_rujuk_balik_prb') {
        // Dari FLAG_RUJUK_BALIK_PRB (jarang diisi AI) ATAU POTENSI_PRB_SEP ("YA"/"").
        // MAPPING di-loop berurutan, jadi kalau kedua key ada di vclaimRecord,
        // yang terakhir menang — POTENSI_PRB_SEP ditaruh paling akhir supaya
        // sumber SEP (lebih dapat diandalkan) yang diprioritaskan.
        const truthy = /^(ya|yes|true|1)$/i.test(String(value).trim());
        dbRecord[dbKey] = truthy ? 1 : 0;
      } else if (['kelas_rawat', 'discharge_status', 'umur_tahun', 'umur_hari', 'los', 'icu_indikator', 'icu_los', 'vent_hour', 'birth_weight'].includes(dbKey)) {
        const num = parseInt(value, 10);
        dbRecord[dbKey] = isNaN(num) ? null : num;
      } else if (['tarif_rs', 'tarif_inacbg', 'tarif_poli_eks', 'total_tarif'].includes(dbKey)) {
        const num = parseFloat(value);
        dbRecord[dbKey] = isNaN(num) ? null : num;
      } else {
        dbRecord[dbKey] = String(value).trim();
      }
    }
  }
  return dbRecord;
}

/**
 * RV-13/14 (gabung episode konsul/rujukan internal) butuh tahu apakah 1
 * pasien (NOKARTU sama) punya >1 kunjungan pada TANGGAL yang sama — data ini
 * tidak ada di 1 dokumen PDF saja, tapi BISA disimpulkan dengan cross-check
 * ke record lain yang sudah ada di database untuk RS yang sama. Dipanggil
 * setelah tiap upload PDF berhasil disimpan (lihat processSinglePdfUpload).
 *
 * Kalau ditemukan >1 record NOKARTU+tanggal sama, DAN klinik/poli-nya BEDA
 * (indikasi kunjungan lintas-poli, bukan cuma duplikat/kunjungan susulan di
 * poli yang sama): tandai jenis_konsultasi='KONSUL_INTERNAL' di SEMUA record
 * dalam grup itu (termasuk yang sudah lama tersimpan, bukan cuma yang baru
 * diupload), lalu validasi ulang supaya RV-13/14 bisa benar-benar menyala.
 * Kalau klinik-nya SAMA (kemungkinan cuma kontrol ulang di poli yang sama),
 * jumlah_episode_klaim tetap diperbarui (angka faktual, bukan simpulan) tapi
 * jenis_konsultasi TIDAK diisi — hindari overclaim dari sinyal yang lemah.
 *
 * SENGAJA hanya menandai, bukan memblokir/otomatis-error tanpa dasar kuat —
 * konsisten dengan filosofi aplikasi ini (AI/sistem menyarankan, verifikator
 * yang memutuskan).
 */
async function detectAndFlagInternalEpisodes(db, { hospitalCode, nokartu, admissionDate }) {
  if (!nokartu || !admissionDate) return;
  try {
    const siblings = await db.prepare(`
      SELECT cr.id, cr.klinik_poli, cr.jenis_konsultasi, cr.raw_data, cr.kode_rs, cr.sep,
             cr.nokartu, cr.nama_pasien, cr.mrn, cr.birth_date, cr.gender, cr.kelas_rawat,
             cr.admission_date, cr.discharge_date, cr.discharge_status, cr.diagnosa_list,
             cr.prosedur_list, cr.dpjp_name, cr.tarif_rs, cr.jenis_klaim
      FROM claim_records cr
      JOIN claim_files cf ON cf.id = cr.file_id
      WHERE cr.nokartu = ? AND cr.admission_date = ? AND cf.hospital_code = ?
    `).all(nokartu, admissionDate, hospitalCode || '3371084');

    if (!siblings || siblings.length < 2) return; // cuma 1 kunjungan, tidak ada yang perlu digabung

    const klinikValues = [...new Set(siblings.map(s => (s.klinik_poli || '').trim()).filter(Boolean))];
    const isCrossPoli = klinikValues.length > 1;
    const episodeCount = siblings.length;

    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();

    for (const sib of siblings) {
      const dbRecord = {
        kode_rs: sib.kode_rs, sep: sib.sep, nokartu: sib.nokartu, nama_pasien: sib.nama_pasien,
        mrn: sib.mrn, birth_date: sib.birth_date, gender: sib.gender, kelas_rawat: sib.kelas_rawat,
        admission_date: sib.admission_date, discharge_date: sib.discharge_date,
        discharge_status: sib.discharge_status, diagnosa_list: sib.diagnosa_list,
        prosedur_list: sib.prosedur_list, dpjp_name: sib.dpjp_name, tarif_rs: sib.tarif_rs,
        jenis_klaim: sib.jenis_klaim,
        jumlah_episode_klaim: episodeCount,
        is_same_day: 1,
        jenis_konsultasi: isCrossPoli ? 'KONSUL_INTERNAL' : (sib.jenis_konsultasi || null),
      };

      const validationErrors = validateRecord(dbRecord, activeRules);
      const validationStatus = determineStatus(validationErrors);

      await db.transaction(async (tx) => {
        await tx.prepare(`
          UPDATE claim_records
          SET jumlah_episode_klaim = ?, is_same_day = ?, jenis_konsultasi = ?,
              validation_status = ?, error_count = ?
          WHERE id = ?
        `).run(episodeCount, 1, dbRecord.jenis_konsultasi, validationStatus, validationErrors.length, sib.id);

        await tx.prepare('DELETE FROM validation_errors WHERE record_id = ?').run(sib.id);
        if (validationErrors.length > 0) {
          const txInsertError = tx.prepare(`
            INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const err of validationErrors) {
            await txInsertError.run(
              uuidv4(), sib.id, err.rule_id, err.field_name,
              err.error_message, err.expected_value || '', err.actual_value || '', err.severity
            );
          }
        }
      });
    }
  } catch (err) {
    // Cross-check ini tambahan (best-effort) — kegagalannya TIDAK BOLEH
    // menggagalkan upload utama, cukup log.
    console.warn(`[detectAndFlagInternalEpisodes] gagal untuk nokartu=${nokartu}: ${err.message}`);
  }
}

/** "YYYY-MM-DD" (format DB) -> "DD/MM/YYYY" (format vClaim). Null kalau tidak sesuai. */
function isoDateToVclaim(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/**
 * Solusi sementara saat integrasi SIMRS bermasalah (data SIMRS sengaja
 * ditunda — lihat catatan sebelumnya di sesi ini): kalau field administratif
 * (NOKARTU/NAMA_PASIEN/BIRTH_DATE/SEX/KELAS_RAWAT-khusus-inap) kosong dari
 * AI ekstraksi, isi dari kunjungan TERAKHIR pasien yang sama (MRN sama) yang
 * SUDAH pernah diupload ke sistem ini — query LANGSUNG ke claim_records
 * (bukan tabel patient_episodes terpisah, pola sama dengan detectAndFlagPRB).
 * Tidak pernah menimpa field yang sudah terisi AI. Setiap field yang kena
 * autofill ditandai `_autofill_<FIELDNAME> = 'mrn_history'` di extractedData
 * (ikut tersimpan ke raw_data, dipakai UI untuk badge "dari riwayat").
 */
async function autofillFromMrn(db, { hospitalCode, extractedData, jenisKlaim }) {
  if (!extractedData.MRN) return; // tidak ada kunci untuk cari riwayat
  try {
    const prev = await db.prepare(`
      SELECT cr.nokartu, cr.nama_pasien, cr.kelas_rawat, cr.birth_date, cr.gender
      FROM claim_records cr
      JOIN claim_files cf ON cf.id = cr.file_id
      WHERE cr.mrn = ? AND cf.hospital_code = ?
      ORDER BY cr.admission_date DESC
      LIMIT 1
    `).get(extractedData.MRN, hospitalCode || '3371084');
    if (!prev) return;

    const candidates = [
      ['NOKARTU', prev.nokartu],
      ['NAMA_PASIEN', prev.nama_pasien],
      ['BIRTH_DATE', isoDateToVclaim(prev.birth_date)],
      ['SEX', prev.gender],
      // KELAS_RAWAT cuma untuk RAWAT_INAP — rawat jalan/IGD punya aturan
      // sendiri (Kelas Hak, bukan Kelas Rawat, lihat jenisKlaimFieldRules.js).
      ...(jenisKlaim === 'RAWAT_INAP' ? [['KELAS_RAWAT', prev.kelas_rawat != null ? String(prev.kelas_rawat) : null]] : []),
    ];

    for (const [field, value] of candidates) {
      if (!extractedData[field] && value) {
        extractedData[field] = value;
        extractedData[`_autofill_${field}`] = 'mrn_history';
        console.log(`[autofillFromMrn] Mengisi ${field} dari riwayat MRN=${extractedData.MRN}.`);
      }
    }
  } catch (err) {
    console.warn(`[autofillFromMrn] gagal untuk mrn=${extractedData.MRN}: ${err.message}`);
  }
}

/** claim_records.admission_date tersimpan "YYYY-MM-DD" (lihat vclaimDateToISO) -> "MM/YYYY". */
function periodeBulanFromAdmissionDate(admissionDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(admissionDate || '').trim());
  if (!m) return null;
  return `${m[2]}/${m[1]}`;
}

/** Jumlah bulan-kalender antara 2 "MM/YYYY" (selalu >= 0). */
function monthsBetweenPeriode(a, b) {
  const [am, ay] = a.split('/').map(Number);
  const [bm, by] = b.split('/').map(Number);
  return Math.abs((ay * 12 + am) - (by * 12 + bm));
}

/**
 * RV-15 & RV-16 (BA 1247/2024) — deteksi lintas-record diagnosis kronis PRB
 * untuk 1 pasien (nokartu) di RS yang sama. Query LANGSUNG ke claim_records
 * (bukan tabel duplikat terpisah) supaya tidak ada 2 sumber data yang bisa
 * tidak sinkron — pola sama seperti detectAndFlagInternalEpisodes() di atas.
 *
 * RV-15: histori_obat_kronis_bulan_berturut = jumlah bulan KALENDER BERTURUT
 * (bukan cuma distinct count) kategori diagnosis PRB yang sama muncul, sampai
 * & termasuk periode record ini. Kalau >=3 dan pasien tidak ada di
 * prb_exemption_list -> RV-15 menyala di ruleEngine.js.
 *
 * RV-16 (PROXY, bukan data pasti): urutan_iterasi = jumlah kunjungan kategori
 * PRB yang sama dalam periode_bulan yang SAMA (bulan berjalan) — dokumen PDF
 * tidak pernah mencantumkan nomor iterasi resep eksplisit, jadi dihitung dari
 * frekuensi kunjungan tercatat. Pesan error RV-16 di ruleEngine.js sudah
 * menjelaskan ini estimasi, bukan kepastian.
 *
 * Sama seperti detectAndFlagInternalEpisodes: cuma mendeteksi pola dari
 * record yang SUDAH pernah diupload ke sistem ini (bukan riwayat SIMRS
 * lengkap) — best-effort, tidak boleh menggagalkan upload utama.
 */
async function detectAndFlagPRB(db, { hospitalCode, mrn, nokartu, admissionDate, diagnosaList }) {
  const category = matchPrbCategory(diagnosaList);
  const periodeIni = periodeBulanFromAdmissionDate(admissionDate);
  if (!category || !nokartu || !periodeIni) return; // bukan diagnosis kronis PRB / data tanggal tidak lengkap

  try {
    const rows = await db.prepare(`
      SELECT cr.id, cr.admission_date, cr.diagnosa_list, cr.flag_rujuk_balik_prb
      FROM claim_records cr
      JOIN claim_files cf ON cf.id = cr.file_id
      WHERE cr.nokartu = ? AND cf.hospital_code = ?
    `).all(nokartu, hospitalCode || '3371084');

    // Cuma record dengan kategori PRB yang SAMA, dikelompokkan per periode_bulan.
    const byPeriode = new Map(); // periode -> [record ids]
    for (const r of rows) {
      if (matchPrbCategory(r.diagnosa_list) !== category) continue;
      const p = periodeBulanFromAdmissionDate(r.admission_date);
      if (!p) continue;
      if (!byPeriode.has(p)) byPeriode.set(p, []);
      byPeriode.get(p).push(r.id);
    }
    if (byPeriode.size === 0) return;

    // RV-15: hitung mundur dari periode terbaru yang ADA datanya, berapa
    // bulan kalender BERTURUT-TURUT (gap 1 bulan = putus, bukan cuma "3 bulan
    // manapun" seperti draf awal brief) kategori ini muncul.
    const periodesSorted = [...byPeriode.keys()].sort((a, b) => {
      const [am, ay] = a.split('/').map(Number);
      const [bm, by] = b.split('/').map(Number);
      return (by * 12 + bm) - (ay * 12 + am);
    });
    let consecutiveMonths = 1;
    for (let i = 0; i < periodesSorted.length - 1; i++) {
      if (monthsBetweenPeriode(periodesSorted[i], periodesSorted[i + 1]) === 1) consecutiveMonths++;
      else break;
    }

    // RV-16 (proxy): jumlah kunjungan kategori sama di periode BERJALAN ini saja.
    const urutanIterasi = (byPeriode.get(periodeIni) || []).length;

    // Cek daftar exempt (aktif = berlaku_sampai kosong ATAU >= hari ini).
    let exemptReason = null;
    if (mrn) {
      const exempt = await db.prepare(`
        SELECT alasan_exempt FROM prb_exemption_list
        WHERE hospital_code = ? AND mrn = ?
          AND (berlaku_sampai IS NULL OR berlaku_sampai >= CURRENT_DATE)
        ORDER BY created_at DESC LIMIT 1
      `).get(hospitalCode || '3371084', mrn);
      if (exempt) exemptReason = exempt.alasan_exempt;
    }

    // Update SEMUA record kategori-sama pasien ini (semua periode yang
    // terkumpul di byPeriode), re-validate, ganti validation_errors-nya.
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const allIds = [...byPeriode.values()].flat();
    const fullRows = await db.prepare(`
      SELECT * FROM claim_records WHERE id IN (${allIds.map(() => '?').join(',')})
    `).all(...allIds);

    for (const rec of fullRows) {
      const dbRecord = {
        ...rec,
        histori_obat_kronis_bulan_berturut: consecutiveMonths,
        urutan_iterasi: urutanIterasi,
        prb_exempt_reason: exemptReason,
      };
      const validationErrors = validateRecord(dbRecord, activeRules);
      const validationStatus = determineStatus(validationErrors);

      await db.transaction(async (tx) => {
        await tx.prepare(`
          UPDATE claim_records
          SET histori_obat_kronis_bulan_berturut = ?, urutan_iterasi = ?, prb_exempt_reason = ?,
              validation_status = ?, error_count = ?
          WHERE id = ?
        `).run(consecutiveMonths, urutanIterasi, exemptReason, validationStatus, validationErrors.length, rec.id);

        await tx.prepare('DELETE FROM validation_errors WHERE record_id = ?').run(rec.id);
        if (validationErrors.length > 0) {
          const txInsertError = tx.prepare(`
            INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const err of validationErrors) {
            await txInsertError.run(
              uuidv4(), rec.id, err.rule_id, err.field_name,
              err.error_message, err.expected_value || '', err.actual_value || '', err.severity
            );
          }
        }
      });
    }
  } catch (err) {
    console.warn(`[detectAndFlagPRB] gagal untuk nokartu=${nokartu}: ${err.message}`);
  }
}

// Kategori pelayanan yang bisa dipilih user di halaman Extract PDF. Dulu
// jenis_klaim SELALU di-hardcode 'RAWAT_INAP' untuk upload PDF, tak peduli
// isi dokumennya rawat jalan/IGD - akibatnya rule RV-17 (odontektomi) salah
// nyala untuk klaim rawat jalan, dan AI review menyarankan hal-hal rawat
// inap (ruangan, dst) untuk klaim yang sebenarnya rawat jalan.
const JENIS_KLAIM_OPTIONS = ['RAWAT_JALAN', 'RAWAT_INAP', 'GAWAT_DARURAT'];

/**
 * Proses SATU PDF end-to-end: AI extraction -> rule engine -> simpan DB ->
 * AI review (+ basis pengetahuan). Dipakai bersama oleh /upload-pdf (1 file)
 * dan /upload-pdf-batch (banyak file, 1 kategori pelayanan yang sama untuk
 * semua file — verifikator diasumsikan sudah memisahkan file per kategori
 * sebelum upload batch).
 * @returns {Promise<{success:boolean, original_name:string, error?:string, file_id?, record_id?, vclaimFormat?, validation_status?, validation_errors?, ai_review?, metadata?}>}
 *   Selalu resolve (tidak throw) — kegagalan 1 file ditandai success:false supaya
 *   tidak menghentikan file lain dalam batch.
 */
async function processSinglePdfUpload(db, { filePath, originalName, jenisKlaim: fixedJenisKlaim, allowedJenisKlaim, userId, hospitalCode }) {
  try {
    const { extractFromPDF } = require('../services/pdfExtractionPipeline');
    const result = await extractFromPDF(filePath, { jenisKlaim: fixedJenisKlaim, allowedJenisKlaim, originalName });

    if (!result.success) {
      // Detail teknis hanya untuk log server, tidak dikirim ke pengguna.
      console.error('[upload-pdf] gagal:', originalName, JSON.stringify(result.errors));
      return { success: false, original_name: originalName, error: result.pesan };
    }

    // jenisKlaim final: dipilih manual (upload 1 file) ATAU hasil deteksi
    // otomatis dari isi dokumen (upload batch kategori-campur, lihat
    // detectJenisKlaim di pdfPageClassifier.js + resolusinya di
    // extractFromPDF). Semua pemakaian jenisKlaim di bawah ini otomatis
    // pakai nilai final ini.
    const jenisKlaim = fixedJenisKlaim || result.jenisKlaimDetection?.value || 'RAWAT_INAP';

    const fileId = uuidv4();
    const recordId = uuidv4();
    const resolvedFilePath = path.resolve(filePath);

    // Record vClaim lengkap 60 kolom (urutan & format sesuai output vClaim asli).
    // jenis_klaim ditambahkan dari pilihan user (AI ekstraksi tidak pernah
    // menghasilkan field ini) - jadi konteks "memory" untuk AI review nanti.
    const extractedData = { ...result.record, JENIS_KLAIM: jenisKlaim };

    // KODE_RS & KELAS_RS TIDAK PERNAH tercetak di SEP/Resume Medis pasien —
    // keduanya atribut RS itu sendiri, bukan per-klaim, jadi AI ekstraksi wajar
    // mengembalikannya kosong. Isi dari profil RS, bukan minta verifikator
    // mengetik ulang tiap klaim:
    // - KODE_RS = hospitalCode (users.hospital_code), sudah dipakai sejak awal
    //   untuk memisahkan data antar RS — identik dengan KODE_RS vClaim.
    // - KELAS_RS = hospital_settings.kelas_rs, diisi sekali oleh admin di
    //   halaman Aturan Validasi > Profil Rumah Sakit.
    if (!extractedData.KODE_RS && hospitalCode) {
      extractedData.KODE_RS = hospitalCode;
    }
    if (!extractedData.KELAS_RS) {
      const hospitalSettings = await db.prepare('SELECT kelas_rs FROM hospital_settings WHERE hospital_code = ?').get(hospitalCode || '3371084');
      if (hospitalSettings?.kelas_rs) extractedData.KELAS_RS = hospitalSettings.kelas_rs;
    }

    // Isi field administratif yang kosong dari riwayat kunjungan MRN yang sama
    // (solusi sementara saat integrasi SIMRS bermasalah — lihat autofillFromMrn).
    await autofillFromMrn(db, { hospitalCode, extractedData, jenisKlaim });

    // Convert vClaim format to database format for validation
    const dbRecord = vclaimToDbFormat(extractedData);
    dbRecord.jenis_klaim = jenisKlaim;
    // has_bpjs_page bukan field vClaim resmi (tidak lewat MAPPING di
    // vclaimToDbFormat) — dihitung terpisah di pdfExtractionPipeline.js dari
    // teks mentah dokumen. Default true kalau tidak diset (dokumen lama/jalur
    // non-PDF) supaya tidak melonggarkan validasi RV-01/RV-02 tanpa sengaja.
    dbRecord.has_bpjs_page = result.record.has_bpjs_page !== false;

    // Run validation on extracted record
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const validationErrors = validateRecord(dbRecord, activeRules);
    const validationStatus = determineStatus(validationErrors);

    // Save file record with status='uploaded' (data extraction complete)
    await db.prepare(`
      INSERT INTO claim_files (id, hospital_code, file_name, file_path, status, uploaded_by, total_records, description, jenis_klaim)
      VALUES (?, ?, ?, ?, 'uploaded', ?, 1, 'Extracted from PDF', ?)
    `).run(fileId, hospitalCode || '3371084', originalName, resolvedFilePath, userId, jenisKlaim);

    // Save extracted record with validation results using transaction
    await db.transaction(async (tx) => {
      const txInsertRecord = tx.prepare(`
        INSERT INTO claim_records (
          id, file_id, row_number, kode_rs, sep, nokartu, nama_pasien, mrn,
          birth_date, gender, kelas_rawat, admission_date, discharge_date,
          discharge_status, diagnosa_list, prosedur_list, dpjp_name,
          tarif_rs, jenis_klaim, validation_status, error_count, raw_data, klinik_poli, has_bpjs_page
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      await txInsertRecord.run(
        recordId, fileId, extractedData.KODE_RS, extractedData.SEP, extractedData.NOKARTU,
        extractedData.NAMA_PASIEN, extractedData.MRN,
        vclaimDateToISO(extractedData.BIRTH_DATE), extractedData.SEX,
        /^\d+$/.test(extractedData.KELAS_RAWAT) ? parseInt(extractedData.KELAS_RAWAT) : null,
        vclaimDateToISO(extractedData.ADMISSION_DATE), vclaimDateToISO(extractedData.DISCHARGE_DATE),
        /^\d+$/.test(extractedData.DISCHARGE_STATUS) ? parseInt(extractedData.DISCHARGE_STATUS) : 1,
        extractedData.DIAGLIST, extractedData.PROCLIST,
        extractedData.DPJP,
        /^\d+$/.test(extractedData.TARIF_RS) ? parseInt(extractedData.TARIF_RS) : null, jenisKlaim,
        validationStatus, validationErrors.length, JSON.stringify(extractedData), extractedData.KLINIK_SEP || null,
        dbRecord.has_bpjs_page
      );

      // Save validation errors if any
      if (validationErrors.length > 0) {
        const txInsertError = tx.prepare(`
          INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const err of validationErrors) {
          await txInsertError.run(
            uuidv4(), recordId, err.rule_id, err.field_name,
            err.error_message, err.expected_value || '', err.actual_value || '',
            err.severity
          );
        }
      }
    });

    // Cross-check RV-13/14 (episode konsul/rujukan internal) terhadap record
    // lain yang sudah ada di DB untuk NOKARTU+tanggal yang sama — lihat
    // dokumentasi lengkap di detectAndFlagInternalEpisodes(). Best-effort,
    // tidak menggagalkan upload kalau error.
    await detectAndFlagInternalEpisodes(db, {
      hospitalCode,
      nokartu: extractedData.NOKARTU,
      admissionDate: vclaimDateToISO(extractedData.ADMISSION_DATE),
    });

    // RV-15 (PRB) & RV-16 (iterasi obat kronis) — lihat dokumentasi lengkap
    // di detectAndFlagPRB(). Best-effort, tidak menggagalkan upload.
    await detectAndFlagPRB(db, {
      hospitalCode,
      mrn: extractedData.MRN,
      nokartu: extractedData.NOKARTU,
      admissionDate: vclaimDateToISO(extractedData.ADMISSION_DATE),
      diagnosaList: extractedData.DIAGLIST,
    });

    // Sinkronkan ke Pending BPJS — kalau ada baris pending yang SEP-nya sama
    // tapi tadinya "belum ditemukan" (diimpor sebelum klaim ini diupload),
    // otomatis ke-link sekarang. Lihat bpjsPendingLink.js.
    await linkPendingBpjsForSep(db, extractedData.SEP, recordId);

    // Alur AI ekstraksi -> rule engine -> AI review: setelah record tersimpan
    // (dibutuhkan supaya ocr_results punya record_id valid untuk FK), kumpulkan
    // bukti dokumen dan jalankan AI review sekali, simpan hasilnya supaya saat
    // halaman hasil dibuka nanti tidak perlu AI call lagi.
    let aiReview = null;
    try {
      const evidencePool = await gatherEvidencePool(db, recordId, resolvedFilePath);
      const knowledgeEntries = await getRelevantKnowledge(db, validationErrors.map(e => e.rule_id));
      const bpjsExamples = await getRelevantBpjsExamples(db);
      aiReview = await generateAiReview(extractedData, validationErrors, evidencePool, knowledgeEntries, bpjsExamples);
      if (aiReview) {
        await db.prepare('UPDATE claim_records SET ai_review = ? WHERE id = ?')
          .run(JSON.stringify(aiReview), recordId);
        recordKnowledge(db, aiReview.knowledge_updates).catch(kbErr =>
          console.warn(`[upload-pdf] Gagal simpan knowledge base: ${kbErr.message}`));
      }
    } catch (aiErr) {
      console.warn(`[upload-pdf] AI review gagal untuk record ${recordId}: ${aiErr.message}`);
    }

    return {
      success: true,
      file_id: fileId,
      record_id: recordId,
      original_name: originalName,
      vclaimFormat: extractedData,
      validation_status: validationStatus,
      validation_errors: validationErrors,
      ai_review: aiReview,
      // jenis_klaim final + info deteksi (cuma ada kalau lewat jalur
      // allowedJenisKlaim/batch kategori-campur) — dipakai FE untuk
      // menampilkan status "IGD" dkk setelah proses selesai, dan flag
      // confident:false kalau harus dicek manual (ambigu/gagal terdeteksi).
      jenis_klaim: jenisKlaim,
      jenis_klaim_detection: result.jenisKlaimDetection,
      metadata: result.metadata,
    };
  } catch (err) {
    console.error('[upload-pdf] error tak terduga:', originalName, err);
    return { success: false, original_name: originalName, error: 'Terjadi gangguan saat memproses berkas. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' };
  }
}

router.post('/upload-pdf', authenticate, pdfUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Belum ada berkas yang dipilih. Silakan pilih berkas PDF terlebih dahulu.' });
  }

  const jenisKlaim = JENIS_KLAIM_OPTIONS.includes(req.body?.jenis_klaim) ? req.body.jenis_klaim : 'RAWAT_INAP';
  const db = getDb();

  const result = await processSinglePdfUpload(db, {
    filePath: req.file.path,
    originalName: req.file.originalname,
    jenisKlaim,
    userId: req.user.id,
    hospitalCode: req.user.hospital_code,
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ status: 'success', ...result });
});

// PDF batch upload config — sama seperti pdfUpload (single) tapi terima banyak file sekaligus.
// Naik dari 30 ke 100 (atas permintaan user). Server requestTimeout & timeout
// fetch FE sudah dinaikkan mengikuti (lihat index.js & lib/api.ts) supaya
// batch besar tidak keputusan di tengah.
const MAX_BATCH_PDF_FILES = 100;
// Concurrency pemrosesan file dalam 1 batch (naik dari 5 → 15): hampir semua
// waktu per file adalah menunggu respons provider AI eksternal (gpt-5.6-luna),
// bukan kerja CPU lokal, jadi paralelisme tinggi aman & mempercepat linear.
// Prasyarat yang sudah dipenuhi: DB pool >= nilai ini (DB_POOL_MAX default 30,
// lihat database/init.js). Ubah lewat env BATCH_AI_CONCURRENCY kalau provider
// AI mulai sering rate-limit (tiap file tetap retry 3x sendiri).
const BATCH_AI_CONCURRENCY = Math.max(1, parseInt(process.env.BATCH_AI_CONCURRENCY || '15', 10));
const pdfUploadBatch = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf') cb(null, true);
    else cb(new Error('Hanya file PDF yang diperbolehkan.'));
  }
});

/**
 * POST /api/v1/claim-files/upload-pdf-batch
 * Upload banyak PDF sekaligus, SATU kategori pelayanan untuk semua file dalam
 * batch (verifikator upload PDF yang sudah dipisah per kategori). Tiap file
 * diproses lewat pipeline yang SAMA PERSIS dengan upload single-PDF
 * (processSinglePdfUpload) — konsisten, tanpa infrastruktur queue terpisah.
 * Concurrency dibatasi (bukan Promise.all semua sekaligus) supaya provider AI
 * (extraction + review, tiap file 2 kali panggil AI) & OCR (CPU-heavy) tidak
 * kebanjiran request paralel. Progress per file di-emit lewat socket supaya
 * FE bisa tampilkan status real-time tanpa polling.
 */
router.post('/upload-pdf-batch', authenticate, pdfUploadBatch.array('files', MAX_BATCH_PDF_FILES), async (req, res) => {
  const io = req.app.get('io');
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Belum ada berkas yang dipilih. Silakan pilih minimal satu berkas PDF.' });
    }

    // Kategori bisa CAMPUR dalam 1 batch — verifikator toggle di awal kategori
    // mana saja yang MUNGKIN ada di batch ini (1, 2, atau 3 kategori), lalu
    // tiap file dideteksi otomatis dari isi dokumennya (lihat detectJenisKlaim
    // di pdfPageClassifier.js) dan divalidasi terhadap daftar yang ditoggle
    // itu. Verifikator TIDAK perlu pilih kategori satu-satu per file lagi.
    // `jenis_klaim` tunggal (lama) tetap didukung sebagai fallback kalau
    // `allowed_jenis_klaim` tidak dikirim (klien lama / cuma 1 kategori).
    let allowedJenisKlaim = [];
    try {
      const parsed = req.body?.allowed_jenis_klaim ? JSON.parse(req.body.allowed_jenis_klaim) : null;
      if (Array.isArray(parsed)) allowedJenisKlaim = parsed.filter(v => JENIS_KLAIM_OPTIONS.includes(v));
    } catch { /* biarkan kosong, jatuh ke fallback di bawah */ }
    const fallbackJenisKlaim = JENIS_KLAIM_OPTIONS.includes(req.body?.jenis_klaim) ? req.body.jenis_klaim : null;
    if (allowedJenisKlaim.length === 0 && fallbackJenisKlaim) allowedJenisKlaim = [fallbackJenisKlaim];
    if (allowedJenisKlaim.length === 0) {
      return res.status(400).json({ error: 'Pilih minimal satu kategori pelayanan yang mungkin ada di batch ini.' });
    }

    const db = getDb();
    const batchId = uuidv4();
    const total = req.files.length;
    let completed = 0;

    if (io) io.emit('pdf-batch:status', { batchId, status: 'processing', total, completed: 0 });

    // Tiap file = 2 AI call berurutan (ekstraksi + review), masing-masing sudah
    // ada retry otomatis (3x percobaan + jeda) kalau provider AI rate-limit —
    // lihat pdfExtractionService.js & aiReviewService.js.
    //
    // Concurrency BISA dinaikkan jauh karena hampir seluruh waktunya adalah
    // MENUNGGU respons provider AI (network-bound), bukan kerja CPU lokal —
    // model AI-nya eksternal (gpt-5.6-luna via API), jadi jumlah file paralel
    // tidak membebani CPU server sama sekali. Yang perlu dijaga:
    // - DB pool harus >= nilai ini (lihat DB_POOL_MAX di database/init.js).
    // - Rate-limit provider: tiap file sudah retry sendiri 3x, jadi kalau
    //   kena limit dia antre ulang, bukan gagal total.
    // Default 15 (naik dari 5): 100 file selesai ~3x lebih cepat, terukur
    // di testing produksi. Bisa diubah lewat env BATCH_AI_CONCURRENCY.
    const results = await runWithConcurrencyLimit(req.files, BATCH_AI_CONCURRENCY, async (file) => {
      // Sinyal "mulai diproses" per file — SEBELUMNYA tidak ada, jadi FE cuma
      // bisa tahu status 'waiting' lalu langsung 'done'/'failed' (file-done),
      // baris di UI tidak pernah sempat tampil "Memproses..." walau backend
      // benar-benar sedang mengerjakannya (antrean concurrency 5 sudah ada,
      // cuma progresnya tidak kelihatan). Lihat UploadJobContext.tsx di FE.
      if (io) io.emit('pdf-batch:file-start', { batchId, fileName: file.originalname });
      const result = await processSinglePdfUpload(db, {
        filePath: file.path,
        originalName: file.originalname,
        // jenisKlaim TIDAK diisi manual di sini — biarkan processSinglePdfUpload
        // & extractFromPDF mendeteksi otomatis dari allowedJenisKlaim, KECUALI
        // cuma 1 kategori yang ditoggle (tidak ambigu, langsung pasti).
        jenisKlaim: allowedJenisKlaim.length === 1 ? allowedJenisKlaim[0] : undefined,
        allowedJenisKlaim,
        userId: req.user.id,
        hospitalCode: req.user.hospital_code,
      });
      completed++;
      if (io) {
        io.emit('pdf-batch:file-done', {
          batchId, fileName: file.originalname, success: result.success,
          error: result.success ? null : result.error, file_id: result.file_id || null,
          // Kategori yang terdeteksi/dipakai untuk file ini + info keyakinan
          // deteksinya — FE tampilkan sebagai status ("✓ Selesai — IGD") dan
          // kasih tanda kalau confident:false (verifikator perlu cek manual).
          jenis_klaim: result.jenis_klaim || null,
          jenis_klaim_detection: result.jenis_klaim_detection || null,
        });
        io.emit('pdf-batch:status', { batchId, status: 'processing', total, completed });
      }
      return result;
    });

    const successCount = results.filter(r => r.success).length;
    if (io) io.emit('pdf-batch:status', { batchId, status: 'completed', total, completed: total, successful: successCount, failed: total - successCount });

    res.json({
      status: 'success',
      batch_id: batchId,
      total_files: total,
      successful: successCount,
      failed: total - successCount,
      results,
    });
  } catch (err) {
    console.error('[upload-pdf-batch] error tak terduga:', err);
    res.status(500).json({ error: 'Terjadi gangguan saat memproses batch. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:file_id/extracted
 * Fetch extracted data dari database (untuk review halaman)
 */
router.get('/:file_id/extracted', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare(`
      SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC LIMIT 1
    `).get(req.params.file_id);

    if (!record) {
      return res.status(404).json({ error: 'Record tidak ditemukan' });
    }

    // Parse raw_data jika ada
    const data = record.raw_data ? JSON.parse(record.raw_data) : record;
    res.json(data);
  } catch (err) {
    console.error('Fetch extracted error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// Batasi akses antar rumah sakit: file milik RS lain dianggap "tidak ditemukan"
// (tidak bocorkan keberadaan). Data lama tanpa hospital_code tetap diizinkan.
function canAccessFile(file, user) {
  if (!file || !user) return false;
  if (!file.hospital_code || !user.hospital_code) return true;
  return file.hospital_code === user.hospital_code;
}

// Bantu validasi/penyajian PDF asli: kembalikan path absolut jika file valid
// (path-nya ada, ekstensi .pdf, dan benar-benar ada di disk), selain itu null.
// Data lama bisa menyimpan path relatif (mis. "./uploads/x.pdf") dari sebelum
// commit ini — fallback ke RESOLVED_UPLOAD_DIR + basename biar tetap ketemu
// walau CWD proses sudah berubah sejak file di-upload.
function resolvePdfPath(file) {
  if (!file || !file.file_path) return null;
  let filePath = String(file.file_path);
  if (path.extname(filePath).toLowerCase() !== '.pdf') return null;
  if (fs.existsSync(filePath)) return path.resolve(process.cwd(), filePath);
  const fallback = path.join(RESOLVED_UPLOAD_DIR, path.basename(filePath));
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

/**
 * GET /api/v1/claim-files/:file_id/file
 * Sajikan file PDF asli yang di-upload agar bisa ditampilkan berdampingan
 * dengan data klaim yang sudah diekstrak di halaman review.
 */
router.get('/:file_id/file', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare(`
      SELECT * FROM claim_files WHERE id = ?
    `).get(req.params.file_id);

    if (!file) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    if (!canAccessFile(file, req.user)) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    const pdfPath = resolvePdfPath(file);
    if (!pdfPath) {
      return res.status(404).json({ error: 'Dokumen PDF tidak ditemukan di sistem.' });
    }

    // Nama file asli dipakai di Content-Disposition — buang karakter kontrol dan
    // kutip supaya tidak bisa dipakai untuk injeksi header; fallback ke nama netral.
    let safeFileName = String(file.file_name || '').replace(/[\x00-\x1f\x7f"]+/g, '');
    if (!safeFileName) safeFileName = 'file.pdf';

    res.sendFile(pdfPath, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${safeFileName}"`
      }
    }, (err) => {
      // File bisa saja dihapus antara pengecekan dan pengiriman (TOCTOU) — tangani
      // dengan JSON 404 yang sama, bukan halaman error default Express.
      if (err && err.code === 'ENOENT') {
        if (!res.headersSent) {
          return res.status(404).json({ error: 'Dokumen PDF tidak ditemukan di sistem.' });
        }
      }
      if (err && !res.headersSent) {
        console.error('[claimFiles] error:', err);
        return res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
      }
    });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:file_id/pdf-info
 * Diagnostik untuk debugging di VPS: status file PDF (path mentah vs ter-resolve,
 * apakah benar-benar ada di disk). Dipakai tim IT bila tombol PDF tidak muncul.
 */
router.get('/:file_id/pdf-info', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare(`
      SELECT * FROM claim_files WHERE id = ?
    `).get(req.params.file_id);

    if (!file) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    if (!canAccessFile(file, req.user)) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    const raw = file.file_path ? String(file.file_path) : null;
    const resolved = resolvePdfPath(file);
    res.json({
      file_id: file.id,
      file_name: file.file_name,
      file_path_raw: raw,
      file_path_resolved: resolved,
      exists: !!resolved,
      extension: raw ? path.extname(raw).toLowerCase() : null,
      upload_dir: RESOLVED_UPLOAD_DIR,
      cwd: process.cwd(),
      has_pdf: !!resolved,
    });
  } catch (err) {
    console.error('[claimFiles] pdf-info error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:record_id/validation-errors
 * Fetch validation errors untuk record (form verifikasi berbasis eksepsi)
 * Response format:
 * {
 *   validation_status: 'valid' | 'error' | 'pending',
 *   error_count: number,
 *   errors_by_field: {
 *     field_name: [
 *       { rule_id, error_message, expected_value, actual_value, severity }
 *     ]
 *   },
 *   all_errors: [...]
 * }
 */
router.get('/:record_id/validation-errors', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare(`
      SELECT id, validation_status, error_count FROM claim_records WHERE id = ?
    `).get(req.params.record_id);

    if (!record) {
      return res.status(404).json({ error: 'Record tidak ditemukan' });
    }

    // Fetch all validation errors for this record
    const errors = await db.prepare(`
      SELECT rule_id, field_name, error_message, expected_value, actual_value, severity
      FROM validation_errors
      WHERE record_id = ?
      ORDER BY severity DESC, field_name ASC
    `).all(req.params.record_id);

    // Group errors by field
    const errorsByField = {};
    errors.forEach(err => {
      if (!errorsByField[err.field_name]) {
        errorsByField[err.field_name] = [];
      }
      errorsByField[err.field_name].push({
        rule_id: err.rule_id,
        error_message: err.error_message,
        expected_value: err.expected_value,
        actual_value: err.actual_value,
        severity: err.severity
      });
    });

    res.json({
      validation_status: record.validation_status,
      error_count: record.error_count,
      errors_by_field: errorsByField,
      all_errors: errors
    });
  } catch (err) {
    console.error('Fetch validation errors:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/:record_id/update-values
 * Simpan perubahan field dari form verifikasi, lalu validasi ulang.
 * Body: { updates: { NAMA_PASIEN: 'Baru', SEP: '...', ... } } — key = nama kolom vClaim (uppercase)
 */
router.post('/:record_id/update-values', authenticate, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Data perubahan tidak valid.' });
    }

    const db = getDb();
    const existing = await db.prepare(`
      SELECT id, file_id, raw_data, kode_rs, sep, nokartu, nama_pasien, mrn,
        birth_date, gender, kelas_rawat, admission_date, discharge_date,
        discharge_status, diagnosa_list, prosedur_list, dpjp_name, tarif_rs, has_bpjs_page
      FROM claim_records WHERE id = ?
    `).get(req.params.record_id);

    if (!existing) {
      return res.status(404).json({ error: 'Record tidak ditemukan' });
    }

    // raw_data adalah salinan PRISTINE dari upload asli (dipakai untuk perbandingan
    // auto-fix) — bukan status terkini record. Kolom-kolom yang punya field
    // tersendiri di claim_records (dpjp_name, dst.) bisa saja sudah dikoreksi
    // sejak upload dan tidak ada/berbeda di raw_data. Kalau merge langsung dari
    // raw_data, field yang tidak ikut di-edit verifikator bisa ke-null-kan.
    // Jadi: mulai dari raw_data (sumber untuk ~44 kolom yang cuma ada di JSON),
    // timpa dengan nilai kolom terkini punya field khusus, baru terapkan updates.
    // Tanggal SENGAJA tidak ikut ditimpa di sini: kolom DB menyimpannya dalam
    // format ISO (YYYY-MM-DD), sedangkan vclaimDateToISO() di bawah hanya
    // mengerti format vClaim asli (DD/MM/YYYY) dari raw_data — kalau ISO ikut
    // dioper ke sana hasilnya null dan tanggal malah hilang.
    const CURRENT_FIELD_KEY_MAP = {
      kode_rs: 'KODE_RS', sep: 'SEP', nokartu: 'NOKARTU', nama_pasien: 'NAMA_PASIEN', mrn: 'MRN',
      gender: 'SEX', kelas_rawat: 'KELAS_RAWAT', discharge_status: 'DISCHARGE_STATUS',
      diagnosa_list: 'DIAGLIST', prosedur_list: 'PROCLIST', dpjp_name: 'DPJP', tarif_rs: 'TARIF_RS',
    };
    const currentColumnValues = {};
    for (const [dbField, vclaimKey] of Object.entries(CURRENT_FIELD_KEY_MAP)) {
      if (existing[dbField] !== null && existing[dbField] !== undefined) {
        currentColumnValues[vclaimKey] = existing[dbField];
      }
    }

    const pristineData = existing.raw_data ? JSON.parse(existing.raw_data) : {};
    const mergedData = { ...pristineData, ...currentColumnValues, ...updates };

    // Convert ke format database, lalu validasi ulang dengan rule engine
    const dbRecord = vclaimToDbFormat(mergedData);
    // has_bpjs_page bukan field vClaim (tidak lewat MAPPING) — bawa nilai
    // yang sudah tersimpan dari upload awal, edit form tidak mengubahnya.
    dbRecord.has_bpjs_page = existing.has_bpjs_page !== false;
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const validationErrors = validateRecord(dbRecord, activeRules);
    const validationStatus = determineStatus(validationErrors);

    await db.transaction(async (tx) => {
      const txUpdateRecord = tx.prepare(`
        UPDATE claim_records SET
          kode_rs = ?, sep = ?, nokartu = ?, nama_pasien = ?, mrn = ?,
          birth_date = ?, gender = ?, kelas_rawat = ?, admission_date = ?, discharge_date = ?,
          discharge_status = ?, diagnosa_list = ?, prosedur_list = ?, dpjp_name = ?,
          tarif_rs = ?, validation_status = ?, error_count = ?, raw_data = ?
        WHERE id = ?
      `);

      await txUpdateRecord.run(
        mergedData.KODE_RS, mergedData.SEP, mergedData.NOKARTU,
        mergedData.NAMA_PASIEN, mergedData.MRN,
        vclaimDateToISO(mergedData.BIRTH_DATE), mergedData.SEX,
        /^\d+$/.test(mergedData.KELAS_RAWAT) ? parseInt(mergedData.KELAS_RAWAT) : null,
        vclaimDateToISO(mergedData.ADMISSION_DATE), vclaimDateToISO(mergedData.DISCHARGE_DATE),
        /^\d+$/.test(mergedData.DISCHARGE_STATUS) ? parseInt(mergedData.DISCHARGE_STATUS) : 1,
        mergedData.DIAGLIST, mergedData.PROCLIST, mergedData.DPJP,
        /^\d+$/.test(mergedData.TARIF_RS) ? parseInt(mergedData.TARIF_RS) : null,
        validationStatus, validationErrors.length, JSON.stringify(mergedData),
        req.params.record_id
      );

      // Ganti seluruh validation_errors lama dengan hasil validasi baru
      await tx.prepare('DELETE FROM validation_errors WHERE record_id = ?').run(req.params.record_id);

      if (validationErrors.length > 0) {
        const txInsertError = tx.prepare(`
          INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const err of validationErrors) {
          await txInsertError.run(
            uuidv4(), req.params.record_id, err.rule_id, err.field_name,
            err.error_message, err.expected_value || '', err.actual_value || '',
            err.severity
          );
        }
      }
    });

    res.json({
      status: 'success',
      record_id: req.params.record_id,
      vclaimFormat: mergedData,
      validation_status: validationStatus,
      validation_errors: validationErrors,
    });
  } catch (err) {
    console.error('[update-values] error tak terduga:', err);
    res.status(500).json({ error: 'Terjadi gangguan saat menyimpan perubahan. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/validate-pdf
 * Validate data dari PDF (after user review/input handwritten fields)
 * Body: { file_id, fields: { NOKARTU, NAMA_PASIEN, ... } }
 */
router.post('/validate-pdf', authenticate, async (req, res) => {
  try {
    const { file_id, fields } = req.body;
    if (!file_id || !fields) return res.status(400).json({ error: 'file_id dan fields wajib.' });

    const db = getDb();

    // Validate each field with rules
    const fieldErrors = [];
    for (const [key, value] of Object.entries(fields)) {
      const err = validateField(key, value);
      if (err) fieldErrors.push({ field: key, message: err });
    }

    // Map fields to record format
    const record = {
      kode_rs: fields.KODE_RS || '3371084',
      sep: (fields.SEP || '').toUpperCase(),
      nokartu: (fields.NOKARTU || '').replace(/\D/g, ''),
      nama_pasien: fields.NAMA_PASIEN || '',
      mrn: fields.MRN || '',
      birth_date: fields.BIRTH_DATE || '',
      admission_date: fields.ADMISSION_DATE || '',
      discharge_date: fields.DISCHARGE_DATE || '',
      kelas_rawat: fields.KELAS_RAWAT ? parseInt(fields.KELAS_RAWAT) : null, // Don't default - let validator catch empty
      discharge_status: fields.DISCHARGE_STATUS ? parseInt(fields.DISCHARGE_STATUS) : null, // Don't default - let validator catch empty
      diagnosa_list: fields.DIAGLIST || '',
      prosedur_list: fields.PROCLIST || '',
      dpjp_name: fields.DPJP || '',
      gender: fields.SEX || '', // Don't default - let validator catch empty
      tarif_rs: fields.TARIF_RS ? parseInt(fields.TARIF_RS) : null, // Allow NULL for optional
    };

    // Validate with rule engine
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const ruleErrors = validateRecord(record, activeRules);
    const allErrors = [...fieldErrors.map(e => ({ ...e, rule_id: 'FIELD_VALIDATION' })), ...ruleErrors];
    const status = allErrors.length === 0 ? 'valid' : 'error';

    // Get existing record ID
    const existingRecord = await db.prepare('SELECT id FROM claim_records WHERE file_id = ?').get(file_id);
    const recordId = existingRecord?.id;

    if (!recordId) {
      return res.status(404).json({ error: 'Record tidak ditemukan, lakukan upload PDF terlebih dahulu.' });
    }

    // UPDATE existing record
    await db.prepare(`
      UPDATE claim_records SET
        sep = ?, nokartu = ?, nama_pasien = ?, mrn = ?,
        birth_date = ?, gender = ?, kelas_rawat = ?, admission_date = ?, discharge_date = ?,
        discharge_status = ?, diagnosa_list = ?, prosedur_list = ?, dpjp_name = ?,
        tarif_rs = ?, validation_status = ?, error_count = ?, raw_data = ?
      WHERE id = ?
    `).run(
      record.sep, record.nokartu, record.nama_pasien, record.mrn,
      record.birth_date, record.gender, record.kelas_rawat, record.admission_date, record.discharge_date,
      record.discharge_status, record.diagnosa_list, record.prosedur_list, record.dpjp_name,
      record.tarif_rs, status, allErrors.length, JSON.stringify(record),
      recordId
    );

    // Delete old errors & insert new
    await db.prepare('DELETE FROM validation_errors WHERE record_id = ?').run(recordId);
    for (const err of allErrors) {
      await db.prepare(`
        INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), recordId, err.rule_id || 'FIELD_VALIDATION', err.field || err.field_name,
        err.message || err.error_message, err.expected_value || '', err.actual_value || '', err.severity || 'major'
      );
    }

    // Update file status
    await db.prepare(`
      UPDATE claim_files SET status = ?, valid_count = ?, error_count = ?, validated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status === 'valid' ? 'completed' : 'error', status === 'valid' ? 1 : 0, allErrors.length, file_id);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'validate_pdf', resourceType: 'claim_file', resourceId: file_id,
      ipAddress: req.ip, details: { status, error_count: allErrors.length }
    });

    // ruleEngine reports lowercase DB column names — map back to vClaim field keys used by FE
    const FIELD_KEY_MAP = {
      sep: 'SEP', nokartu: 'NOKARTU', nama_pasien: 'NAMA_PASIEN', mrn: 'MRN',
      birth_date: 'BIRTH_DATE', gender: 'SEX', kelas_rawat: 'KELAS_RAWAT',
      admission_date: 'ADMISSION_DATE', discharge_date: 'DISCHARGE_DATE',
      discharge_status: 'DISCHARGE_STATUS', diagnosa_list: 'DIAGLIST',
      prosedur_list: 'PROCLIST', dpjp_name: 'DPJP', tarif_rs: 'TARIF_RS', kode_rs: 'KODE_RS',
    };
    res.json({
      file_id,
      record_id: recordId,
      status,
      error_count: allErrors.length,
      errors: allErrors.map(e => {
        const rawField = e.field_name || e.field || '';
        return {
          rule_id: e.rule_id || 'FIELD_VALIDATION',
          field_name: FIELD_KEY_MAP[rawField] || rawField,
          severity: e.severity || 'major',
          error_message: e.error_message || e.message,
          expected: e.expected_value || '', actual: e.actual_value || '',
        };
      }),
    });
  } catch (err) {
    console.error('PDF validate error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/scan-episodes
 * Scan ulang manual RV-13/RV-15/RV-16 untuk semua nokartu unik pada 1
 * periode_bulan ("MM/YYYY"). Perlu karena deteksi lintas-record cuma
 * otomatis nyala saat file BARU diupload — kalau pola baru muncul dari
 * kombinasi file-file LAMA yang sudah lebih dulu ada (mis. backlog yang
 * baru selesai diupload semua), tidak ada yang men-trigger ulang
 * deteksinya kecuali di-scan manual di sini.
 */
router.post('/scan-episodes', authenticate, async (req, res) => {
  try {
    const { periode_bulan } = req.body; // "MM/YYYY"
    const m = /^(\d{2})\/(\d{4})$/.exec(String(periode_bulan || '').trim());
    if (!m) return res.status(400).json({ error: 'Format periode_bulan harus MM/YYYY, contoh: 06/2026.' });
    const isoPrefix = `${m[2]}-${m[1]}`; // "YYYY-MM"

    const db = getDb();
    const patients = await db.prepare(`
      SELECT DISTINCT cr.nokartu, cr.mrn, cr.admission_date, cr.diagnosa_list
      FROM claim_records cr
      JOIN claim_files cf ON cf.id = cr.file_id
      WHERE cf.hospital_code = ? AND cr.admission_date LIKE ? AND cr.nokartu IS NOT NULL
    `).all(req.user.hospital_code, `${isoPrefix}%`);

    let scanned = 0;
    for (const p of patients) {
      await detectAndFlagInternalEpisodes(db, {
        hospitalCode: req.user.hospital_code, nokartu: p.nokartu, admissionDate: p.admission_date,
      });
      await detectAndFlagPRB(db, {
        hospitalCode: req.user.hospital_code, mrn: p.mrn, nokartu: p.nokartu,
        admissionDate: p.admission_date, diagnosaList: p.diagnosa_list,
      });
      scanned++;
    }

    res.json({ message: `Scan selesai untuk periode ${periode_bulan}.`, pasien_discan: scanned });
  } catch (err) {
    console.error('[scan-episodes] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

module.exports = router;
module.exports.vclaimToDbFormat = vclaimToDbFormat;
module.exports.vclaimDateToISO = vclaimDateToISO;
module.exports.resolvePdfPath = resolvePdfPath;
module.exports.RESOLVED_UPLOAD_DIR = RESOLVED_UPLOAD_DIR;
