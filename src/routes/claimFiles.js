const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { parseClaimFile, normalizeColumnName } = require('../services/fileParser');
const { determineStatus } = require('../services/ruleEngine');
const { generateExcel } = require('../services/exportService');
const { buatDaftarKerja, namaBerkasDaftarKerja } = require('../services/daftarKerjaExportService');
const { buatSiapSubmit, namaBerkasSiapSubmit } = require('../services/siapSubmitExportService');
const { logAudit } = require('../services/auditService');
const konteksAi = require('../services/konteksPenggunaanAiService');
const { estimatePromptTokens, estimateCompletionTokens } = require('../services/aiValidationService');
const { generateAiReview, hitungInacbgDanTarif, getAnyResumeMedisPageNumbers, tentukanKunjunganIgd } = require('../services/aiReviewService');
const { susunPemeriksaanPenunjang } = require('../services/pemeriksaanPenunjangService');
const { catatPolaBeda, ringkasPola } = require('../services/polaBedaCasemixService');
const { pelajari: pelajariCasemix } = require('../services/pembelajaranCasemixService');
const { susunFaktaKlinis } = require('../services/faktaKlinisService');
const { susunLaporanCasemix } = require('../services/agenCasemixService');
const { susunKronologi } = require('../services/kronologiService');
const { tanyaAgenCasemix } = require('../services/agenCasemixInteraktifService');
const { simpanKeputusan, ambilKeputusan, pelajaranRelevan } = require('../services/keputusanCasemixService');
const { kodeFinal } = require('../services/pemeriksaKritisService');
const { tinjauDiagnosis } = require('../services/tinjauanDiagnosisService');
const { tinjauLanjutan } = require('../services/tinjauanLanjutanService');
const { getRelevantKnowledge, recordKnowledge, getRelevantBpjsExamples } = require('../services/errorKnowledgeService');
const { matchPrbCategory } = require('../services/prbRules');
const { linkPendingBpjsForSep } = require('../services/bpjsPendingLink');
const { isiPeriodeUntukFile } = require('../services/periodeKlaimService');
const { tentukanProsedurDariTemuan } = require('../services/aturanKodingRsService');
const { ekstrakKotakKata } = require('../services/pdfWordBoxService');
const { bacaLabelHalaman } = require('../services/pasanganLabelPosisiService');
const { pastikanDiagnosisWho } = require('../services/pastikanDiagnosisWhoService');
const { galatKamusRecord, periksaKode, tandaiStatusKamusEvidence } = require('../services/validasiKamusService');
const { susunTarifGanda } = require('../services/tarifGandaService');
const { validasiRecordDenganKamus } = require('../services/validasiRecordKamusService');
const { simpanAiReview } = require('../services/simpanAiReviewService');

const { kegawatdaruratanMemicuPending } = require('../services/kegawatdaruratanAggregation');
const { segarkanAlasanValidasi } = require('../services/putusanPendingService');
const { susunSaranKoding } = require('../services/saranKodingService');
const { isLembarGrouper } = require('../services/lembarGrouperService');
const { perbaruiRisikoTampilan } = require('../services/risikoKlaimTampilanService');
const { nilaiKelengkapanAnalisis, masalahAnalisisRecord } = require('../services/kelengkapanAnalisisService');

const router = express.Router();
router.use(async (req, res, next) => {
  if (!['POST','PUT','PATCH'].includes(req.method)) return next();
  const ids = req.path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig) || [];
  if (typeof req.body?.file_id === 'string') ids.push(req.body.file_id);
  if (!ids.length) return next();
  try {
    for (const id of ids) {
      const test = await getDb().get(`SELECT cf.id FROM claim_files cf
        WHERE cf.is_testing = TRUE AND (cf.id = ? OR cf.id IN (SELECT file_id FROM claim_records WHERE id = ?))`, [id,id]);
      if (test) return res.status(409).json({ error: 'Berkas testing hanya untuk pengujian. Ubah hasil acuan melalui Testing Pending.' });
    }
    next();
  } catch (err) { next(err); }
});


// UI uses the same age-specific reference as lookupBand, including existing records.
router.get('/reference/vital-ranges', authenticate, (req, res) => {
  const { THRESHOLD_TABLE } = require('../services/kegawatdaruratanReference');
  res.json({ thresholds: THRESHOLD_TABLE });
});

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
    INSERT INTO ocr_results (id, record_id, page_number, ocr_text, confidence, block_count, processing_duration_ms, sumber)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id, page_number) DO UPDATE SET
      ocr_text = excluded.ocr_text,
      confidence = excluded.confidence,
      block_count = excluded.block_count,
      processing_duration_ms = excluded.processing_duration_ms,
      sumber = excluded.sumber
  `);
  for (const page of ocrResult.pages) {
    await insertOcrResult.run(
      uuidv4(), recordId, page.page_number,
      page.text || '', page.confidence || 0, page.block_count || 0,
      page.duration_ms || 0, page.source === 'native_text' ? 'native_text' : 'ocr'
    );
  }
}

/**
 * Simpan halaman yang teksnya berasal dari lapisan teks asli PDF.
 *
 * Ditandai sumber 'native_text' supaya bisa dibedakan dari hasil OCR: teks asli
 * sempurna tanpa salah huruf, sedangkan hasil OCR selalu punya kemungkinan
 * keliru baca. Perbedaan itu penting saat menilai seberapa jauh sebuah kutipan
 * bisa dipercaya.
 *
 * Tidak menimpa baris yang sudah ada dari OCR — kalau sebuah halaman pernah
 * di-OCR, hasil itulah yang dipakai sistem, dan menimpanya diam-diam akan
 * mengubah bukti di bawah kaki temuan yang sudah tercatat.
 */
async function simpanHalamanNative(db, recordId, nativePages) {
  const simpan = db.prepare(`
    INSERT INTO ocr_results (id, record_id, page_number, ocr_text, confidence, block_count, processing_duration_ms, sumber)
    VALUES (?, ?, ?, ?, ?, 0, 0, 'native_text')
    ON CONFLICT(record_id, page_number) DO NOTHING
  `);
  for (const hal of nativePages) {
    await simpan.run(uuidv4(), recordId, hal.page_number, hal.ocr_text || '', 100);
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
/**
 * Halaman RESUME dari PDF digital diberi `nilai_label` (isi kolom Tindakan,
 * Diagnosa, dst) yang dipasangkan dari POSISI kata, karena urutan baca gagal
 * pada tabel resume SIMRS (label terpusat vertikal, isi di atas sel).
 * Best-effort: PDF scan (tanpa lapisan teks), mupdf gagal, atau tidak ada
 * pasangan -> halaman dibiarkan apa adanya dan jalur teks lama yang dipakai.
 */
async function lampirkanNilaiLabelPosisi(filePath, halamanNative) {
  try {
    const { classifyPageDocumentType } = require('../services/pdfPageClassifier');
    const resume = halamanNative.filter(h => classifyPageDocumentType(h.ocr_text) === 'resume_medis');
    if (resume.length === 0) return;
    const kotak = await ekstrakKotakKata(fs.readFileSync(filePath), resume.map(h => h.page_number));
    for (const h of resume) {
      const nilai = bacaLabelHalaman(kotak.get(h.page_number), 'resume_medis');
      if (Object.keys(nilai).length > 0) h.nilai_label = nilai;
    }
  } catch (err) {
    console.warn(`[gatherEvidencePool] pasangan label posisi dilewati: ${err.message}`);
  }
}

async function gatherEvidencePool(db, recordId, filePath, classification = null) {
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
  if (ocrResults.length === 0 && (!classification || classification.pages?.some(p=>p.type!=='NATIVE'))) {
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
    const classified = classification || await classifyPdfPages(filePath);
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
        .filter(p => p.type === 'NATIVE' && !p.is_primary_source && !p.is_lembar_grouper && !scanPageNumbers.has(p.page_num) && p.text_length > 0)
        .map(p => ({ page_number: p.page_num, ocr_text: p.text_full, confidence: 100 }));
      evidencePool = [...evidencePool, ...nativePages];
      await lampirkanNilaiLabelPosisi(filePath, nativePages);

      // Halaman teks asli ikut DISIMPAN, bukan cuma dipakai sekali lalu dibuang.
      // Sebelumnya halaman ini dibaca ulang dari PDF tiap kali dibutuhkan dan
      // tidak pernah masuk basis data, sehingga klaim dari PDF digital penuh
      // punya nol halaman tersimpan — dan analisis belakangan (penambangan
      // aturan dari rekap pending, pemeriksaan ulang konsistensi) buta terhadap
      // klaim seperti itu. Best-effort: kegagalan menyimpan tidak boleh
      // menggagalkan audit yang sedang berjalan.
      if (nativePages.length > 0) {
        try {
          await simpanHalamanNative(db, recordId, nativePages);
        } catch (simpanErr) {
          console.warn(`[gatherEvidencePool] Gagal menyimpan halaman teks asli: ${simpanErr.message}`);
        }
      }
    }
  } catch (classifyErr) {
    console.warn(`[gatherEvidencePool] Gagal ambil halaman NATIVE: ${classifyErr.message}`);
  }

  // Lembar grouper E-Klaim (hasil casemix) tidak pernah menjadi bukti, dari
  // jalur mana pun. Hasil OCR tersimpan juga memuat halaman teks asli (tahap
  // OCR memakai teks asli PDF lalu menyimpannya), jadi penyaring is_primary_source
  // di atas saja tidak cukup.
  return evidencePool.filter(p => !isLembarGrouper(p && p.ocr_text));
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

    // TXT mempunyai jenis layanan per baris (PTD); jangan memberi RAWAT_INAP
    // kepada seluruh ekspor rawat jalan. Berkas lama tanpa kolom jenis harus
    // mendapat pilihan pengguna, bukan disimpulkan dari kode CBG pembanding.
    const masalahJenis = parseResult.errors.filter(e => e.type === 'jenis_layanan');
    const pilihanJenis = require('../services/jenisLayananKlaimService').normalJenis(req.body.jenis_klaim);
    for (const rec of parseResult.records) {
      if (!rec.jenis_klaim) {
        if (pilihanJenis) rec.jenis_klaim = pilihanJenis;
        else masalahJenis.push({ type: 'jenis_layanan', row: rec._rowNumber, message: 'Jenis layanan tidak tersedia. Pilih rawat inap atau rawat jalan untuk berkas ini.' });
      }
    }
    if (masalahJenis.length) {
      await db.prepare('UPDATE claim_files SET status = ?, error_message = ? WHERE id = ?')
        .run('error', masalahJenis[0].message, fileId);
      if (io) io.emit('validation:error', { fileId, errors: masalahJenis });
      try { fs.unlinkSync(req.file.path); } catch (_) { /* berkas sementara */ }
      return res.status(422).json({ file_id: fileId, status: 'error', errors: masalahJenis });
    }
    const jenisDalamFile = [...new Set(parseResult.records.map(r => r.jenis_klaim))];
    if (jenisDalamFile.length === 1) await db.prepare('UPDATE claim_files SET jenis_klaim = ? WHERE id = ?').run(jenisDalamFile[0], fileId);

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
        const errors = await validasiRecordDenganKamus(db, record, activeRules);
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
          record.urutan_iterasi || 0, record.jenis_klaim,
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

    // Periode diisi di sini, setelah record tersimpan, supaya pengelompokan
    // dan arsip per bulan ikut terbentuk untuk berkas yang baru masuk.
    try {
      await isiPeriodeUntukFile(db, fileId);
    } catch (e) {
      // periode bukan syarat berkas dianggap berhasil diproses
      console.warn('[periode] gagal mengisi periode:', e.message);
    }

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
          const bpjsExamples = await getRelevantBpjsExamples(db, { ...record, validationErrors: recordErrors });
          const aiReview = await generateAiReview(record, recordErrors, [], knowledgeEntries, bpjsExamples);
          if (aiReview) {
            totalAiTokens += aiReview.tokens_used || 0;
            await simpanAiReview(db, record.id, aiReview);
            // Kode saran yang sudah terverifikasi kamus ICD-10 langsung mengisi
            // DIAGLIST/PROCLIST yang masih kosong -- koder tidak perlu mengetik
            // ulang. Best-effort: kegagalan di sini tidak menggagalkan review.
            await isiKodeDariSaranTervalidasi(db, record.id, record, aiReview).catch(errIsi =>
              console.warn(`[AutoIsi] gagal untuk record ${record.id}: ${errIsi.message || errIsi}`));
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
 * GET /api/v1/claim-files/kelompok
 *
 * Ringkasan pengelompokan Periode & Kategori untuk Riwayat Upload: satu baris
 * per (periode, kategori) beserta jumlah klaim, yang perlu dikerjakan, dan
 * yang siap. Baris klaimnya sendiri dimuat terpisah saat kelompok dibuka,
 * lewat GET / dengan filter periode — daftar tidak pernah dimuat seluruhnya.
 *
 * Periode diambil dari nomor SEP (lihat periodeKlaimService), BUKAN tanggal
 * unggah: berkas Agustus yang baru diunggah September tetap masuk Agustus.
 *
 * Ini rute satu segmen, jadi HARUS didaftarkan sebelum GET /:id — kalau
 * tidak, kata "kelompok" ditelan sebagai id berkas.
 */
router.get('/kelompok', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { arsip, jenis_klaim } = req.query;

    let where = arsip === '1' ? 'WHERE cf.diarsipkan_pada IS NOT NULL' : 'WHERE cf.diarsipkan_pada IS NULL';
    where += ' AND cf.is_testing = FALSE';
    const params = [];
    if (jenis_klaim) { where += ' AND cf.jenis_klaim = ?'; params.push(jenis_klaim); }

    const rows = await db.prepare(`
      SELECT r.periode AS periode, cf.jenis_klaim AS jenis_klaim,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE (cf.pending_count + cf.error_count) > 0) AS perlu,
             COUNT(*) FILTER (WHERE (cf.pending_count + cf.error_count) = 0) AS siap
      FROM claim_files cf
      LEFT JOIN LATERAL (
        SELECT periode FROM claim_records WHERE file_id = cf.id ORDER BY row_number LIMIT 1
      ) r ON TRUE
      ${where}
      GROUP BY r.periode, cf.jenis_klaim
      ORDER BY r.periode DESC NULLS LAST, cf.jenis_klaim
    `).all(...params);

    res.json({
      kelompok: rows.map(r => ({
        periode: r.periode || null,
        jenis_klaim: r.jenis_klaim || null,
        total: Number(r.total),
        perlu: Number(r.perlu),
        siap: Number(r.siap),
      })),
    });
  } catch (err) {
    console.error('[claimFiles] kelompok error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 20, status, jenis_klaim, from_date, to_date, search, arsip, periode, tampilan } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE cf.is_testing = FALSE';
    const params = [];

    // Berkas terarsip disembunyikan dari daftar aktif secara bawaan — itulah
    // gunanya arsip. Dengan ?arsip=1 justru HANYA yang terarsip yang tampil,
    // sehingga ada tempat untuk melihat dan mengembalikannya. Tanpa tampilan
    // itu, arsip tidak berbeda dari penghapusan.
    where += arsip === '1' ? ' AND cf.diarsipkan_pada IS NOT NULL' : ' AND cf.diarsipkan_pada IS NULL';

    // Pengelompokan per periode. Periode sebuah berkas = periode record
    // pertamanya — definisi yang SAMA dengan /kelompok, supaya jumlah di header
    // kelompok selalu sama dengan jumlah baris yang tampil saat dibuka.
    // 'tanpa' = berkas yang periodenya belum bisa ditentukan.
    const SQL_PERIODE_BERKAS = "(SELECT periode FROM claim_records WHERE file_id = cf.id ORDER BY row_number LIMIT 1)";
    if (periode) {
      if (periode === 'tanpa') {
        where += ` AND ${SQL_PERIODE_BERKAS} IS NULL`;
      } else {
        where += ` AND ${SQL_PERIODE_BERKAS} = ?`;
        params.push(String(periode));
      }
    }

    // Tampilan tersimpan. "Perlu dikerjakan" = masih ada masalah atau pending;
    // "Siap submit" = bersih. Diturunkan dari hitungan yang sudah ada, bukan
    // dari kolom status baru, supaya tidak ada dua sumber kebenaran.
    if (tampilan === 'perlu') where += ' AND (cf.pending_count + cf.error_count) > 0';
    else if (tampilan === 'siap') where += ' AND (cf.pending_count + cf.error_count) = 0';
    else if (tampilan === 'bulan_ini') {
      const sekarang = new Date();
      const bulanIni = `${sekarang.getFullYear()}-${String(sekarang.getMonth() + 1).padStart(2, '0')}`;
      where += ` AND ${SQL_PERIODE_BERKAS} = ?`;
      params.push(bulanIni);
    }

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
        ${displayNamaSubquery},
        (
          SELECT string_agg(DISTINCT ve.error_message, '; ')
          FROM validation_errors ve
          JOIN claim_records cr ON ve.record_id = cr.id
          WHERE cr.file_id = cf.id
        ) as pending_reason
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
      pending_reason: f.pending_reason || null,
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
// Didaftarkan sebelum GET /:id agar tidak tertangkap sebagai id berkas.
// Status proses unggah RS ini (aktif + baru selesai yang belum ditutup) beserta perkiraan sisa waktu.
router.get('/proses-unggah', authenticate, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await require('../services/prosesUnggahService').daftar(getDb(), { hospitalCode: req.user.hospital_code, batasParalel: BATCH_AI_CONCURRENCY }));
  } catch (error) {
    console.error('[proses-unggah] gagal:', error);
    res.status(500).json({ error: 'Status unggahan belum dapat dimuat.' });
  }
});

// Ringkasan pola beda aplikasi vs casemix: kategori terbanyak + contoh kode
// (tanpa identitas pasien) -- daftar aturan yang paling perlu ditambahkan.
router.get('/pola-beda-casemix', authenticate, async (req, res) => {
  try {
    res.json(await ringkasPola(getDb(), { batas: Number(req.query.batas) || 20 }));
  } catch (error) {
    console.error('[pola-beda-casemix] gagal:', error);
    res.status(500).json({ error: 'Ringkasan pola beda belum dapat disusun.' });
  }
});

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

    const pendingReasonRow = await db.prepare(`
      SELECT string_agg(DISTINCT ve.error_message, '; ') as pending_reason
      FROM validation_errors ve
      JOIN claim_records cr ON ve.record_id = cr.id
      WHERE cr.file_id = ?
    `).get(fileRaw.id);

    const file = {
      ...fileRaw,
      has_pdf,
      total_records: Number(fileRaw.total_records || 0),
      valid_count: Number(fileRaw.valid_count || 0),
      error_count: Number(fileRaw.error_count || 0),
      pending_count: Number(fileRaw.pending_count || 0),
      pending_reason: pendingReasonRow?.pending_reason || null,
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
    const file = await db.prepare('SELECT id, hospital_code,file_name,ai_anggaran_id FROM claim_files WHERE id = ?').get(req.params.id);
    if (!canAccessFile(file, req.user)) return res.status(404).json({ error:'File tidak ditemukan.' });
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
      SELECT cr.*, cf.file_path AS source_file_path, cf.file_name AS source_file_name
      FROM claim_records cr JOIN claim_files cf ON cf.id = cr.file_id ${where}
      ORDER BY cr.row_number ASC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    // Attach errors to each record — satu query IN(...) untuk semua record di
    // halaman ini, bukan satu query per record (N+1 yang bikin loading lambat
    // untuk file dengan banyak record per halaman).
    let errorsByRecordId = {};
    const recordIds = records.map(r => r.id);
    if (records.length > 0) {
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

    // Record lama dibuat sebelum penanda kunjungan_igd ada: lengkapi sekali
    // dari halaman berkas tersimpan (tanpa AI) supaya tanda vital & K1-K5
    // disembunyikan untuk poli/ranap yang bukan IGD, lalu simpan.
    for (const rec of records) {
      try {
        await lengkapiKunjunganIgd(db, rec);
      } catch (e) {
        console.warn(`[kunjungan_igd] gagal melengkapi record ${rec.id}: ${e.message}`);
      }
    }

    const profil = await require('../services/profilKlaimRsService').muatProfil(db, req.user?.hospital_code);
    const halamanById = new Map();
    let halamanTersedia = true;
    if (recordIds.length) {
      try {
        const pages = await db.prepare(`SELECT record_id,page_number,ocr_text FROM ocr_results
          WHERE record_id IN (${recordIds.map(() => '?').join(',')}) ORDER BY record_id,page_number`).all(...recordIds);
        for (const p of pages) { const a=halamanById.get(p.record_id) || []; a.push(p); halamanById.set(p.record_id,a); }
      } catch (e) { halamanTersedia=false; }
    }
    const budget=file.ai_anggaran_id ? await require('../services/anggaranAiService').ringkasan(db,
      {id:file.ai_anggaran_id,hospital_code:file.hospital_code}) : null;
    const recordsWithErrors = records.map(rec => {
      const errors = (errorsByRecordId[rec.id] || []).filter(e => e.rule_id !== 'RV-17');
      const review = perbaruiRisikoTampilan({ ...rec, hospital_code:file.hospital_code,source_file_name:file.file_name }, errors,
        { profil, ...(halamanTersedia ? {pages:halamanById.get(rec.id) || []} : {}) });
      if (!halamanTersedia) review.referensi_klaim = { status:'belum_dapat_dinilai', temuan:[], catatan:'Bukti tersimpan belum berhasil dimuat. Pemeriksaan referensi belum selesai.' };
      if(budget) review.anggaran_ai=budget;
      return { ...rec, errors, ai_review: typeof rec.ai_review === 'string' ? JSON.stringify(review) : review };
    });

    res.json({ total, page: parseInt(page), limit: parseInt(limit), records: recordsWithErrors });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

async function lengkapiKunjunganIgd(db, rec) {
  let review = rec.ai_review;
  const teks = typeof review === 'string';
  if (teks) { try { review = JSON.parse(review); } catch (_) { return; } }
  const asesmen = review && review.kegawatdaruratan_assessment;
  if (!asesmen || Array.isArray(asesmen) || typeof asesmen.kunjungan_igd === 'boolean') return;
  const pages = await db.prepare('SELECT page_number, ocr_text FROM ocr_results WHERE record_id = ? ORDER BY page_number').all(rec.id);
  if (!pages.length) return; // tanpa halaman tersimpan tidak bisa dipastikan -- biarkan tampil
  asesmen.kunjungan_igd = tentukanKunjunganIgd(pages);
  if (!asesmen.kunjungan_igd && asesmen.has_data && typeof asesmen.ringkasan === 'string'
    && !/bukan IGD|bukan dari IGD/i.test(asesmen.ringkasan)) {
    asesmen.ringkasan += /INAP/i.test(String(rec.jenis_klaim || ''))
      ? ' Rawat inap bukan dari IGD: kriteria kegawatdaruratan dan tanda vital bukan fokus penilaian klaim ini dan tidak membuat klaim pending.'
      : ' Kunjungan poli (bukan IGD): penilaian ini hanya informasi dan tidak membuat klaim pending.';
  }
  await db.prepare('UPDATE claim_records SET ai_review = ? WHERE id = ?').run(JSON.stringify(review), rec.id);
  rec.ai_review = teks ? JSON.stringify(review) : review;
}

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

    const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ?').all(req.params.id);
    for (const record of records) {
      const analisis = masalahAnalisisRecord(record, file);
      if (analisis) return res.status(409).json({ error: 'Persetujuan ditunda: analisis berkas belum lengkap. Periksa hasil dan baca ulang berkas.', kelengkapan_analisis: analisis });
      const errors = await galatKamusRecord(db, record);
      if (errors.length) return res.status(errors.some(e => e.dictionary_status === 'unavailable') ? 503 : 409)
        .json({ error: 'Klaim belum siap dikirim: pemeriksaan kamus belum lolos.', errors });
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
 * GET /api/v1/claim-files/export/daftar-kerja
 *
 * Lembar kerja harian koder: klaim yang ditandai bermasalah oleh medaudit.
 * Cakupannya mengikuti tampilan yang sedang dibuka (periode & kategori),
 * bukan seluruh basis data — dan cakupan itu ikut tertulis di nama berkas
 * serta di lembar Ringkasan supaya tidak ada salah paham saat beredar.
 *
 * Berisi PENDING INTERNAL saja. Pending BPJS punya arti yang jauh berbeda
 * dan sengaja tidak pernah dicampur ke berkas ini.
 */
router.get('/export/daftar-kerja', authenticate, authorize('admin', 'verifikator', 'supervisor'), async (req, res) => {
  try {
    const db = getDb();
    const { periode, kategori, from_date, to_date, search, arsip } = req.query;

    const syarat = ["cr.validation_status <> 'valid'", "cf.is_testing = FALSE"];
    // Klaim yang berkasnya sudah diarsipkan tidak muncul di lembar kerja
    // harian — kalau ikut, koder akan mengerjakan ulang yang sudah sengaja
    // disingkirkan.
    syarat.push(arsip === '1' ? 'cf.diarsipkan_pada IS NOT NULL' : 'cf.diarsipkan_pada IS NULL');
    const nilai = [];
    if (periode) { syarat.push('cr.periode = ?'); nilai.push(periode); }
    if (kategori) { syarat.push('cr.jenis_klaim = ?'); nilai.push(kategori); }
    if (from_date) { syarat.push('cf.created_at >= ?'); nilai.push(from_date); }
    if (to_date) { syarat.push('cf.created_at <= ?'); nilai.push(to_date + 'T23:59:59'); }
    if (search) {
      syarat.push('(cr.nama_pasien LIKE ? OR cr.sep LIKE ?)');
      nilai.push(`%${search}%`, `%${search}%`);
    }

    const records = await db.prepare(
      'SELECT cr.* FROM claim_records cr JOIN claim_files cf ON cf.id = cr.file_id WHERE ' + syarat.join(' AND ') +
      ' ORDER BY cr.periode DESC, cr.nama_pasien ASC'
    ).all(...nilai);

    const getErrors = db.prepare('SELECT * FROM validation_errors WHERE record_id = ?');
    const klaim = [];
    for (const rec of records) {
      klaim.push({ ...rec, errors: await getErrors.all(rec.id) });
    }

    const namaDisamarkan = req.user.role === 'supervisor' || ['1', 'true'].includes(String(req.query.samarkan_nama || '').toLowerCase());
    const cakupan = {
      periode: periode || null,
      kategori: kategori || null,
      filter: [
        'Klaim berstatus perlu dikerjakan',
        search ? 'hasil pencarian' : null,
        from_date || to_date ? `tanggal upload ${from_date || 'awal'}—${to_date || 'akhir'}` : null,
        arsip === '1' ? 'arsip' : 'aktif',
      ].filter(Boolean).join('; '),
      diexportOleh: req.user.email,
      samarkanNama: namaDisamarkan,
    };
    const buffer = await buatDaftarKerja(klaim, cakupan);

    // Begitu berkas diunduh, medaudit kehilangan kendali atasnya — isinya
    // nama pasien, nomor kartu BPJS, dan diagnosis. Setiap export dicatat
    // supaya selalu bisa ditelusuri siapa mengeluarkan data apa, kapan.
    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'export', resourceType: 'daftar_kerja', resourceId: null,
      details: { format: 'excel', periode: periode || 'semua', kategori: kategori || 'semua', jumlah_klaim: klaim.length, nama_disamarkan: namaDisamarkan },
      ipAddress: req.ip,
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${namaBerkasDaftarKerja(cakupan)}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[daftar-kerja] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/** Export klaim bersih, satu lembar data dalam urutan field vClaim. */
router.get('/export/siap-submit', authenticate, authorize('admin', 'verifikator'), async (req, res) => {
  try {
    const db = getDb();
    const { periode, kategori, from_date, to_date, search, arsip } = req.query;
    const where = ["cr.validation_status = 'valid'", 'cf.pending_count = 0', 'cf.error_count = 0', 'cf.is_testing = FALSE'];
    const params = [];
    where.push(arsip === '1' ? 'cf.diarsipkan_pada IS NOT NULL' : 'cf.diarsipkan_pada IS NULL');
    if (periode) {
      const sqlPeriode = '(SELECT periode FROM claim_records WHERE file_id = cf.id ORDER BY row_number LIMIT 1)';
      if (periode === 'tanpa') where.push(`${sqlPeriode} IS NULL`);
      else { where.push(`${sqlPeriode} = ?`); params.push(String(periode)); }
    }
    if (kategori) { where.push('cf.jenis_klaim = ?'); params.push(String(kategori)); }
    if (from_date) { where.push('cf.created_at >= ?'); params.push(from_date); }
    if (to_date) { where.push('cf.created_at <= ?'); params.push(`${to_date}T23:59:59`); }
    if (search) {
      where.push('(cr.nama_pasien LIKE ? OR cr.sep LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const klaim = await db.prepare(
      `SELECT cr.*, cf.file_path AS source_file_path, cf.file_name AS source_file_name FROM claim_records cr JOIN claim_files cf ON cf.id = cr.file_id WHERE ${where.join(' AND ')} ORDER BY cr.periode DESC, cr.nama_pasien ASC`,
    ).all(...params);
    const cakupan = {
      periode: periode || null,
      kategori: kategori || null,
      from_date: from_date || null,
      to_date: to_date || null,
      search: search || null,
      arsip: arsip === '1',
      filter: [
        'Klaim bersih (valid, tanpa masalah)',
        search ? 'hasil pencarian' : null,
        from_date || to_date ? `tanggal upload ${from_date || 'awal'}—${to_date || 'akhir'}` : null,
        arsip === '1' ? 'arsip' : 'aktif',
      ].filter(Boolean).join('; '),
      diexportOleh: req.user.email,
    };
    for (const record of klaim) {
      const analisis = masalahAnalisisRecord(record);
      if (analisis) return res.status(409).json({ error: 'Ekspor siap submit ditunda: analisis berkas belum lengkap. Periksa hasil dan baca ulang berkas.', kelengkapan_analisis: analisis });
      const errors = await galatKamusRecord(db, record);
      if (errors.length) return res.status(errors.some(e => e.dictionary_status === 'unavailable') ? 503 : 409)
        .json({ error: 'Ekspor siap submit ditunda: pemeriksaan kamus belum lolos.', errors });
    }
    const buffer = await buatSiapSubmit(klaim, cakupan);
    logAudit({
      userId: req.user.id, userEmail: req.user.email, action: 'export',
      resourceType: 'siap_submit', resourceId: null,
      details: { format: 'excel', periode: periode || 'semua', kategori: kategori || 'semua', jumlah_klaim: klaim.length },
      ipAddress: req.ip,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${namaBerkasSiapSubmit(cakupan)}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[siap-submit] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id/export
 */
router.get('/:id/export', authenticate, authorize('admin', 'verifikator'), async (req, res) => {
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
        const bpjsExamples = await getRelevantBpjsExamples(db, { ...record, validationErrors: recordErrors });
        const aiReview = await generateAiReview(record, recordErrors, evidencePool, knowledgeEntries, bpjsExamples);
        if (aiReview) {
          await simpanAiReview(db, record.id, aiReview);
          // Kode saran yang sudah terverifikasi kamus ICD-10 langsung mengisi
          // DIAGLIST/PROCLIST yang masih kosong -- koder tidak perlu mengetik
          // ulang. Best-effort: kegagalan di sini tidak menggagalkan review.
          await isiKodeDariSaranTervalidasi(db, record.id, record, aiReview).catch(errIsi =>
            console.warn(`[AutoIsi] gagal untuk record ${record.id}: ${errIsi.message || errIsi}`));
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
 * POST /api/v1/claim-files/bulk-archive
 *
 * Arsip massal — pengganti hapus massal untuk merapikan daftar.
 *
 * Daftar harian jadi bersih tanpa kehilangan data. Ini bukan sekadar lebih
 * aman: pengukuran recall bergantung pada klaim lama yang masih ada saat
 * rekap pending BPJS datang sekitar tiga bulan kemudian. Klaim yang sudah
 * dihapus tidak bisa dipakai membuktikan apa pun.
 *
 * Bisa dibatalkan lewat /bulk-restore, dan tercatat di Audit Log.
 */
router.post('/bulk-archive', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids wajib berupa array berisi minimal 1 file_id.' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: 'Maksimal 500 id per panggilan — bagi jadi beberapa batch.' });
    }
    const db = getDb();
    // Yang sudah diarsipkan dilewati, supaya mengarsipkan dua kali tidak
    // menimpa catatan siapa yang pertama mengarsipkan.
    const hasil = await db.run(
      'UPDATE claim_files SET diarsipkan_pada = CURRENT_TIMESTAMP, diarsipkan_oleh = ? WHERE id = ANY(?) AND diarsipkan_pada IS NULL',
      [req.user.id, ids]
    );

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'bulk_archive', resourceType: 'claim_file', resourceId: ids.join(','),
      details: { jumlah_diminta: ids.length, jumlah_diarsipkan: hasil.changes },
      ipAddress: req.ip,
    });

    res.json({ archived: hasil.changes });
  } catch (err) {
    console.error('[claimFiles] bulk-archive error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/bulk-restore
 *
 * Kembalikan dari arsip. Pengarsipan harus bisa dibatalkan — kalau tidak,
 * ia cuma penghapusan dengan nama yang lebih ramah.
 */
router.post('/bulk-restore', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids wajib berupa array berisi minimal 1 file_id.' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: 'Maksimal 500 id per panggilan — bagi jadi beberapa batch.' });
    }
    const db = getDb();
    const hasil = await db.run(
      'UPDATE claim_files SET diarsipkan_pada = NULL, diarsipkan_oleh = NULL WHERE id = ANY(?) AND diarsipkan_pada IS NOT NULL',
      [ids]
    );

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'bulk_restore', resourceType: 'claim_file', resourceId: ids.join(','),
      details: { jumlah_diminta: ids.length, jumlah_dikembalikan: hasil.changes },
      ipAddress: req.ip,
    });

    res.json({ restored: hasil.changes });
  } catch (err) {
    console.error('[claimFiles] bulk-restore error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/bulk-delete
 *
 * Penghapusan PERMANEN. Untuk merapikan daftar, pakai /bulk-archive —
 * jalur ini disisakan hanya untuk kekeliruan upload yang memang harus
 * lenyap, dan untuk cleanup setelah testing batch besar.
 *
 * Panggilan tanpa `konfirmasi: true` TIDAK menghapus apa pun; ia
 * mengembalikan rincian apa yang akan hilang (berapa berkas, berapa baris
 * klaim, periode apa saja) supaya konfirmasi di layar bisa menyebutkannya.
 * Sebelumnya permintaan hapus langsung dieksekusi tanpa pernah menyatakan
 * cakupannya — dan di Audit Log tersisa beberapa aksi hapus massal berisi
 * ratusan UUID tanpa keterangan isi sama sekali.
 *
 * Body: { ids: string[], konfirmasi?: boolean, alasan?: string }
 * Maks 500 per panggilan.
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

    // Selalu hitung dulu apa yang akan hilang — dipakai untuk pratinjau
    // maupun untuk dicatat di Audit Log saat penghapusan benar dijalankan.
    const rincian = await db.prepare(
      'SELECT count(DISTINCT cf.id) AS berkas, count(cr.id) AS baris_klaim, ' +
      "coalesce(string_agg(DISTINCT cr.periode, ', ' ORDER BY cr.periode), '-') AS periode " +
      'FROM claim_files cf LEFT JOIN claim_records cr ON cr.file_id = cf.id WHERE cf.id = ANY(?)'
    ).get([ids]);

    if (req.body.konfirmasi !== true) {
      return res.status(409).json({
        error: 'Penghapusan permanen perlu konfirmasi.',
        perlu_konfirmasi: true,
        akan_hilang: rincian,
        saran: 'Untuk sekadar merapikan daftar, pakai arsip massal — datanya tetap tersimpan dan bisa dikembalikan.',
      });
    }

    const result = await db.run('DELETE FROM claim_files WHERE id = ANY(?)', [ids]);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'bulk_delete', resourceType: 'claim_file', resourceId: ids.join(','),
      details: { jumlah_berkas: rincian.berkas, jumlah_baris_klaim: rincian.baris_klaim, periode: rincian.periode, alasan: req.body.alasan || null },
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
    if (!canAccessFile(file,req.user)) return res.status(404).json({ error: 'File tidak ditemukan.' });

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
        note: 'Tidak ada record dengan masalah validasi data. Status ini tidak menyatakan seluruh analisis klinis sudah selesai.'
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

    const route=await require('../services/routerModelService').resolve(db,'baca_berkas');
    const cost=require('../services/biayaModelService').estimasiBiaya(route.model,{prompt_tokens:estimatedPrompt,completion_tokens:estimatedCompletion,total_tokens:totalEstimate,cached_tokens:0,cache_write_tokens:estimatedPrompt},route.penyedia);
    const budget=file.ai_anggaran_id ? await require('../services/anggaranAiService').ringkasan(db,{id:file.ai_anggaran_id,hospital_code:file.hospital_code}) : null;

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
      cost_estimate_usd: cost?.usd ?? null,
      cost_estimate_rp: cost?.idr ?? null,
      provider: route.penyedia,model:route.model,anggaran_ai:budget,
      note:'Estimasi satu review berdasarkan record; bukan biaya seluruh tahap PDF. Pemakaian terukur terdapat pada halaman Penggunaan AI.'
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
      WHERE cr.nokartu = ? AND cr.admission_date = ? AND cf.hospital_code = ? AND cf.is_testing = FALSE
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

      const validationErrors = await validasiRecordDenganKamus(db, dbRecord, activeRules);
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
      WHERE cr.mrn = ? AND cf.hospital_code = ? AND cf.is_testing = FALSE
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

/**
 * Sinkronkan cache valid_count/error_count/pending_count di claim_files dari
 * validation_status claim_records AKTUAL (agregasi ulang, bukan asumsi 1
 * record/file) -- WAJIB dipanggil setiap kali validation_status SATU record
 * di file itu berubah di luar alur upload awal (reread, update-values),
 * supaya panel ringkasan atas ("VALID X% / PENDING Y%") tidak jadi cache basi
 * yang bertentangan dgn badge status per-record di bawahnya (temuan K-2,
 * evaluasi 14 Sep 2026 -- sebelum ini reread MENIMPA count SELURUH file
 * dengan pola 1/0 dari status SATU record yang baru dibaca ulang, salah utk
 * file multi-record; update-values malah TIDAK menyentuh count sama sekali).
 * Terima db ATAU tx (sama-sama punya .prepare(), dipanggil di dalam
 * transaction kalau pemanggilnya sudah dalam satu).
 */
async function recomputeFileCounts(db, fileId) {
  const counts = await db.prepare(`
    SELECT
      SUM(CASE WHEN validation_status = 'valid' THEN 1 ELSE 0 END) AS valid_count,
      SUM(CASE WHEN validation_status = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN validation_status = 'pending' THEN 1 ELSE 0 END) AS pending_count
    FROM claim_records WHERE file_id = ?
  `).get(fileId);
  await db.prepare(`
    UPDATE claim_files SET valid_count = ?, error_count = ?, pending_count = ?
    WHERE id = ?
  `).run(Number(counts?.valid_count || 0), Number(counts?.error_count || 0), Number(counts?.pending_count || 0), fileId);
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
      WHERE cr.nokartu = ? AND cf.hospital_code = ? AND cf.is_testing = FALSE
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
      const validationErrors = await validasiRecordDenganKamus(db, dbRecord, activeRules);
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
// GAWAT_DARURAT dihapus 21 Sep 2026: kunjungan IGD ternyata termasuk
// rawat jalan, dan mengategorikannya tersendiri membuat kategori
// RAWAT_JALAN nyaris tidak pernah terisi.
const JENIS_KLAIM_OPTIONS = ['RAWAT_JALAN', 'RAWAT_INAP'];

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
/**
 * Isi DIAGLIST/PROCLIST otomatis dari saran AI (21 Sep 2026, permintaan
 * klien: "tidak usah ada tombol terapkan, langsung saja ditampilkan").
 *
 * HANYA kode dengan kamus_valid === true yang dipakai. Batasan ini bukan
 * kehati-hatian berlebihan: fitur saran ini pernah menghasilkan kode
 * ICD-10-CM (Amerika) alih-alih ICD-10 WHO yang dipakai BPJS -- itulah
 * sebabnya tombol "Terapkan" dulu dimatikan total (lihat annotateKamusValid
 * di aiReviewService.js). Kode yang belum terverifikasi kamus TIDAK diisi,
 * tetap jadi saran yang diketik manual koder.
 *
 * TIDAK pernah menimpa isian yang sudah ada -- kalau koder sudah mengetik
 * kode sendiri, itu yang menang.
 *
 * Validasi dijalankan ULANG setelah pengisian: tanpa itu, error "DIAGLIST
 * wajib diisi" tetap menempel padahal kolomnya sudah terisi.
 */
/**
 * Entri code_evidence untuk kode yang sudah diganti otomatis diberi
 * `diganti_menjadi`, supaya layar menjelaskan "J45.3 tercetak di dokumen,
 * diganti J45.9" alih-alih hanya menampilkan kode lama tanpa penjelasan.
 */
function tandaiEvidenceDiganti(aiReview, penggantian) {
  const ev = Array.isArray(aiReview.code_evidence) ? aiReview.code_evidence : [];
  for (const p of penggantian || []) {
    for (const e of ev) {
      if (e && e.type === 'diagnosis' && String(e.code || '').trim().toUpperCase() === p.kode_asal) {
        e.diganti_menjadi = p.kode_baru;
      }
    }
  }
}

async function isiKodeDariSaranTervalidasi(db, recordId, record, aiReview) {
  let hasil;
  if (typeof db.transaction === 'function') {
    hasil = await db.transaction(async tx => {
      await tx.prepare('SELECT id FROM claim_records WHERE id = ? FOR UPDATE').get(recordId);
      return isiKodeDariSaranDalamTransaksi(tx, recordId, record, aiReview);
    });
  } else {
    hasil = await isiKodeDariSaranDalamTransaksi(db, recordId, record, aiReview);
  }
  await catatPolaBedaUntukRecord(db, recordId);
  return hasil;
}

// Pola beda hasil aplikasi vs casemix (lembar grouper) -- bahan aturan baru.
// Best-effort: kegagalan pencatatan tidak boleh menggagalkan review.
async function catatPolaBedaUntukRecord(db, recordId) {
  try {
    const rec = await db.prepare('SELECT id, diagnosa_list, prosedur_list, jenis_klaim, kelas_rawat, ai_review FROM claim_records WHERE id = ?').get(recordId);
    if (!rec) return;
    const ai = typeof rec.ai_review === 'string' ? JSON.parse(rec.ai_review) : rec.ai_review;
    if (!ai || !ai.lembar_grouper) return;
    const saran = susunSaranKoding(rec, ai, hitungInacbgDanTarif);
    await catatPolaBeda(db, rec.id, rec.jenis_klaim, saran.casemix);
    // Belajar: pasangan istilah resume -> kode casemix dari berkas yang sudah diklaim.
    const pages = await db.prepare('SELECT page_number, ocr_text FROM ocr_results WHERE record_id = ? ORDER BY page_number').all(rec.id);
    await pelajariCasemix(db, rec.id, rec.jenis_klaim, pages, ai.lembar_grouper);
    // Riwayat disimpan untuk perbandingan; tidak mengkalibrasi severity pasien lain.
  } catch (e) {
    console.warn(`[PolaBeda] gagal mencatat record ${recordId}: ${e.message}`);
  }
}

const { penunjangBerhasil } = require('../services/konvensiKodingRs');

async function isiKodeDariSaranDalamTransaksi(db, recordId, record, aiReview) {
  aiReview = aiReview && typeof aiReview === 'object' ? aiReview : {};
  const saran = Array.isArray(aiReview && aiReview.suggested_codes) ? aiReview.suggested_codes : [];
  const tindakanTerbaca = Array.isArray(aiReview && aiReview.temuan_tindakan) ? aiReview.temuan_tindakan : [];
  // Berhenti hanya kalau KEDUA sumbernya kosong. Sebelumnya cukup saran kode
  // yang kosong untuk membuat fungsi ini berhenti — dan tindakan yang jelas
  // tertulis di berkas tidak akan pernah sampai ke daftar prosedur.
  // Diagnosis divalidasi WHO sebelum kemungkinan keluar lebih awal.

  const ambil = (tipe) => [...new Set(
    // boleh_isi_otomatis === false dipasang pagarPascaAiService pada saran yang
    // disangkal berkas atau hanya berupa saran_diagnosis dari anamnesis; saran
    // lama tanpa penanda itu berperilaku persis seperti sebelumnya.
    saran.filter(s => s && s.type === tipe && s.code && !s.disangkal && !s.belum_who && s.kamus_valid === true && s.boleh_isi_otomatis !== false).map(s => String(s.code).trim())
  )];

  const kosong = (v) => !v || String(v).trim() === '';
  const perubahan = {};
  // Kode di DIAGLIST yang tidak ada di ICD-10 WHO diganti dengan padanannya.
  //
  // Ditemukan pada klaim SEP 0170R0110826V003045: DIAGLIST berisi "r10.84"
  // (ICD-10-CM Amerika) dan tampil "Valid". BPJS hanya mengenal ICD-10 WHO,
  // padanannya R10.4. Penggantinya sudah dihitung saat saran kode dianotasi
  // (aiReviewService.annotateKamusValid) dan tercatat di kode_asal — di sini
  // tinggal dicocokkan dengan kode yang sudah tertulis.
  //
  // Yang diganti HANYA kode yang tidak ada di kamus dan punya padanan pasti;
  // kode sah dan isian lain di kolom yang sama tidak disentuh.
  const koreksiWho = new Map(
    saran
      .filter(s => s && s.type === 'diagnosis' && s.kode_asal && s.kamus_valid === true && s.code && s.boleh_isi_otomatis !== false)
      .map(s => [String(s.kode_asal).trim().toUpperCase(), String(s.code).trim().toUpperCase()])
  );
  const diaglistSaatIni = String(record.DIAGLIST || record.diagnosa_list || '');
  aiReview.ekstraksi_kode_asli = aiReview.ekstraksi_kode_asli || { DIAGLIST: diaglistSaatIni, PROCLIST: record.PROCLIST || record.prosedur_list || '', waktu: new Date().toISOString() };
  const teksDiagnosis = saran.filter(s => s && s.type === 'diagnosis')
    .map(s => s.quotation || s.text || '').filter(Boolean).join(' ');
  // Konteks pemetaan PER KODE dari kutipan dokumen tempat kode itu tercetak
  // (kasus Eifelin: "J45.3 - Asthma with Exacerbation (IM)"). Tanpa ini, kode
  // yang tidak disarankan AI dipetakan tanpa konteks apa pun dan, kalau
  // kandidatnya lebih dari satu, tidak pernah terpetakan.
  const konteksPerKode = {};
  const buktiPerKode = {};
  for (const e of (Array.isArray(aiReview.code_evidence) ? aiReview.code_evidence : [])) {
    if (!e || e.type !== 'diagnosis' || !e.code || !e.found || !e.quotation) continue;
    const k = String(e.code).trim().toUpperCase();
    konteksPerKode[k] = [konteksPerKode[k], String(e.quotation)].filter(Boolean).join(' ');
    buktiPerKode[k] = [...(buktiPerKode[k] || []), { halaman: e.page_number, kutipan: e.quotation }];
  }
  const identitasDb = await db.prepare('SELECT nama_pasien, nokartu, mrn, sep FROM claim_records WHERE id = ?').get(recordId) || {};
  const dikenal = { nama: [identitasDb.nama_pasien, record.nama_pasien, record.NAMA_PASIEN].filter(Boolean),
    nomor_kartu: [identitasDb.nokartu, record.nokartu, record.NOKARTU].filter(Boolean),
    no_rm: [identitasDb.mrn, record.mrn, record.MRN].filter(Boolean),
    sep: [identitasDb.sep, record.sep, record.SEP].filter(Boolean),
    nik: record.nik || record.NIK, alamat: record.alamat || record.ALAMAT, telepon: record.telepon || record.TELEPON };
  const hasilWho = await pastikanDiagnosisWho(db, diaglistSaatIni, teksDiagnosis, { konteksPerKode, buktiPerKode, dikenal });
  // Saran lama tidak boleh menimpa hasil pemetaan baru atau mengubah kode WHO sah.
  const cekAsal = koreksiWho.size ? await periksaKode(db, [...koreksiWho.keys()], 'diagnosis') : { hasil: {} };
  const cekTujuan = koreksiWho.size ? await periksaKode(db, [...koreksiWho.values()], 'diagnosis') : { hasil: {} };
  for (const [asal, tujuan] of koreksiWho) {
    if (hasilWho.statusKamus !== 'tersedia' || cekAsal.hasil[asal] !== 'not_found'
      || cekTujuan.hasil[tujuan] !== 'valid' || asal.slice(0, 3) !== tujuan.slice(0, 3)
      || hasilWho.penggantian.some(p => p.kode_asal === asal)) koreksiWho.delete(asal);
  }
  // Jejak audit setiap penggantian otomatis -- ditambahkan, tidak menimpa
  // riwayat dari pembacaan sebelumnya.
  if (hasilWho.penggantian && hasilWho.penggantian.length > 0) {
    const lama = Array.isArray(aiReview.penggantian_kode) ? aiReview.penggantian_kode : [];
    aiReview.penggantian_kode = [...lama, ...hasilWho.penggantian];
    tandaiEvidenceDiganti(aiReview, hasilWho.penggantian);
    console.log(`[AutoIsi] record ${recordId}: ${hasilWho.penggantian.map(p => `${p.kode_asal} -> ${p.kode_baru} (${p.sumber})`).join(', ')}`);
  }
  aiReview.status_kamus = {
    ...(aiReview.status_kamus || {}),
    diagnosis: { status: hasilWho.statusKamus, alasan: hasilWho.alasanKamus || null, dataset: hasilWho.dataset || null },
  };
  const evidence = Array.isArray(aiReview.code_evidence) ? aiReview.code_evidence : [];
  if (evidence.length) {
    const diagnosis = await periksaKode(db, evidence.filter(e => e.type === 'diagnosis').map(e => e.code), 'diagnosis');
    const prosedur = await periksaKode(db, evidence.filter(e => e.type === 'procedure').map(e => e.code), 'prosedur');
    tandaiStatusKamusEvidence(evidence, { diagnosis, prosedur });
  }
  if (hasilWho.diaglist && hasilWho.diaglist !== diaglistSaatIni) {
    perubahan.diagnosa_list = hasilWho.diaglist;
    record.DIAGLIST = hasilWho.diaglist;
    record.diagnosa_list = hasilWho.diaglist;
    try {
      const baris = await db.prepare('SELECT raw_data FROM claim_records WHERE id = ?').get(recordId);
      const raw = baris && baris.raw_data
        ? (typeof baris.raw_data === 'string' ? JSON.parse(baris.raw_data) : { ...baris.raw_data }) : {};
      raw.DIAGLIST = hasilWho.diaglist;
      await db.prepare('UPDATE claim_records SET raw_data = ? WHERE id = ?').run(JSON.stringify(raw), recordId);
    } catch (errRaw) {
      throw errRaw;
    }
  }
  // kode_luar_kamus juga diisi aiReviewService untuk PROSEDUR dan dibaca
  // putusanPendingService (jenis, pesan). Yang diganti di sini hanya entri
  // diagnosis; entri prosedur dibiarkan, dan bentuk entrinya sama dengan aslinya.
  const luarKamusLain = (Array.isArray(aiReview.kode_luar_kamus) ? aiReview.kode_luar_kamus : [])
    .filter(k => k && k.jenis !== 'diagnosis');
  aiReview.kode_luar_kamus = [...hasilWho.kodeLuarKamus, ...luarKamusLain];
  await simpanAiReview(db, recordId, aiReview);
  if (koreksiWho.size > 0 && diaglistSaatIni.trim() !== '') {
    const pecah = (perubahan.diagnosa_list || diaglistSaatIni).split(/[;,]/).map(s => s.trim()).filter(Boolean);
    const dikoreksi = [];
    const hasilKode = pecah.map(k => {
      const ganti = koreksiWho.get(k.toUpperCase());
      if (!ganti) return k;
      dikoreksi.push(`${k} -> ${ganti}`);
      return ganti;
    });
    if (dikoreksi.length > 0) {
      const baru = [...new Set(hasilKode)].join(';');
      perubahan.diagnosa_list = baru;
      record.DIAGLIST = baru;
      record.diagnosa_list = baru;
      const waktu = new Date().toISOString();
      const jejak = pecah
        // Kode yang sudah diganti & dicatat pastikanDiagnosisWho tidak dicatat dua kali.
        .filter(k => koreksiWho.has(k.toUpperCase())
          && !(hasilWho.penggantian || []).some(p => p.kode_asal === k.toUpperCase()))
        .map(k => ({ kode_asal: k.toUpperCase(), kode_baru: koreksiWho.get(k.toUpperCase()), sumber: 'saran_kode', konteks: null, kamus: 'ICD-10 WHO 2010', waktu }));
      aiReview.penggantian_kode = [...(Array.isArray(aiReview.penggantian_kode) ? aiReview.penggantian_kode : []), ...jejak];
      tandaiEvidenceDiganti(aiReview, jejak);
      aiReview.kode_luar_kamus = aiReview.kode_luar_kamus.filter(k => !koreksiWho.has(k.kode));
      await simpanAiReview(db, recordId, aiReview);
      // raw_data ikut diperbarui: tampilan membaca dari sana, dan tanpa ini
      // kolom basis data sudah benar tetapi layar masih menunjukkan kode lama.
      try {
        const baris = await db.prepare('SELECT raw_data FROM claim_records WHERE id = ?').get(recordId);
        const raw = baris && baris.raw_data
          ? (typeof baris.raw_data === 'string' ? JSON.parse(baris.raw_data) : { ...baris.raw_data }) : {};
        if (raw && typeof raw === 'object') {
          raw.DIAGLIST = baru;
          await db.prepare('UPDATE claim_records SET raw_data = ? WHERE id = ?').run(JSON.stringify(raw), recordId);
        }
      } catch (errRaw) {
        throw errRaw;
      }
      console.log(`[AutoIsi] record ${recordId}: kode di luar ICD-10 WHO diganti ${dikoreksi.join(', ')}`);
    }
  }
  if (kosong(record.DIAGLIST || record.diagnosa_list)) {
    const d = require('../services/tinjauanDiagnosisService').urutkanDiagnosisTerverifikasi(ambil('diagnosis'), aiReview.tinjauan_diagnosis);
    if (d.length > 0) {
      perubahan.diagnosa_list = d.join(';');
    } else {
      // Belum ada padanan WHO: kandidat tetap terlihat untuk koder, tetapi
      // tidak mengisi DIAGLIST dan tidak ikut perhitungan grouper/severity.
      const belumWho = [...new Set(saran
        .filter(s => s && s.type === 'diagnosis' && s.code && s.belum_who === true && s.disangkal !== true)
        .map(s => String(s.code).trim().toUpperCase()))];
      if (belumWho.length > 0) {
        aiReview.kode_belum_who = belumWho.map(kode => ({ kode, waktu: new Date().toISOString() }));
        aiReview.kode_luar_kamus = [
          ...(Array.isArray(aiReview.kode_luar_kamus) ? aiReview.kode_luar_kamus.filter(k => !belumWho.includes(String(k.kode).toUpperCase())) : []),
          ...belumWho.map(kode => ({
            kode, jenis: 'diagnosis', keparahan: 'sedang', asal: 'saran_aplikasi',
            pesan: `Kode "${kode}" belum mempunyai padanan ICD-10 WHO yang terverifikasi. Tersimpan sebagai kandidat untuk koder dan tidak digunakan dalam kode klaim atau perhitungan tarif.`,
          })),
        ];
        await simpanAiReview(db, recordId, aiReview);
      }
    }
  }
  // Tahap KODING (aturanKodingRsService): temuan tindakan + aturan RS opsional
  // -> usulan daftar prosedur. Tanpa aturan RS perilakunya SAMA dengan
  // sebelumnya (tidak ada gerbang baru); yang bertambah hanya penanda
  // belum_ada_aturan_rs. Dihitung walau PROCLIST sudah terisi, supaya usulan
  // dan alasannya tetap tercatat di ai_review.
  let usulanProsedur = null;
  if (tindakanTerbaca.length > 0) {
    try {
      usulanProsedur = await tentukanProsedurDariTemuan(db, recordId, tindakanTerbaca);
      aiReview.usulan_prosedur = usulanProsedur.usulan;
      await simpanAiReview(db, recordId, aiReview);
    } catch (errUsulan) {
      console.warn(`[AutoIsi] usulan prosedur gagal untuk record ${recordId}: ${errUsulan.message || errUsulan}`);
    }
  }

  if (kosong(record.PROCLIST || record.prosedur_list)) {
    const p = ambil('procedure');

    // Tindakan yang terbaca dari berkas ikut mengisi daftar prosedur.
    //
    // Saran kode dari AI sering tidak memuat tindakan yang jelas-jelas tertulis
    // di resume: nebulisasi tertulis tiga kali di berkas 0170R0110926V001943
    // dan daftar prosedurnya tetap kosong. Pembacaan tindakan bersifat
    // deterministik — kata "Nebulisasi" pada kolom Tindakan resume, bukan
    // tebakan model — sehingga kodenya layak diisikan.
    //
    // Tiga pembatas, karena isi kolom ini ikut terkirim ke BPJS dan mengklaim
    // tindakan yang tidak dilakukan adalah temuan serius terhadap rumah sakit:
    //   1. Hanya tindakan yang kodenya SUDAH PASTI (kode_usulan terisi).
    //      Pemasangan infus tidak ikut — kodenya belum ditentukan koder.
    //   2. Hanya yang terbaca dari resume medis atau triase. Resep saja tidak
    //      cukup: obat nebul di resep belum tentu berarti tindakannya dilakukan.
    //   3. Tidak pernah menimpa isian koder (dijaga kosong() di atas).
    // Aturan RS (kalau ada) boleh menahan sebuah tindakan; tanpa aturan, ketiga
    // pembatas di atas berlaku persis seperti sebelumnya.
    const dariTindakan = usulanProsedur
      ? usulanProsedur.kode
      : (Array.isArray(aiReview && aiReview.temuan_tindakan) ? aiReview.temuan_tindakan : [])
        .filter(t => t && t.kode_usulan
          && (t.bukti || []).some(b => b.sumber === 'resume_medis' || b.sumber === 'triase_igd'))
        .map(t => String(t.kode_usulan).trim());

    // Penunjang yang punya LEMBAR HASIL di berkas (lab -> 90.59, rontgen ->
    // 87.44, EKG -> 89.52, CTG eksternal -> 75.34) ikut diisi: hasilnya bukti pemeriksaan
    // benar dilakukan, dan casemix RS mengodekannya (KHOIRIYAH, YETY, ANNISA,
    // MUSTAKIMAH). Penunjang yang hanya disebut di resume/resep tidak ikut.
    const dariPenunjang = penunjangBerhasil(aiReview);
    // Konvensi casemix RS: tindakan rutin (injeksi, infus, IV cath, kateter, oksigen) tidak dikode.
    const { PROSEDUR_RUTIN_TIDAK_DIKODE } = require('../services/konvensiKodingRs');
    const gabungan = [...new Set([...p, ...dariTindakan, ...dariPenunjang])].filter(k => !PROSEDUR_RUTIN_TIDAK_DIKODE.has(k));
    if (gabungan.length > 0) perubahan.prosedur_list = gabungan.join(';');
  }

  // Catatan AI ("DIAGLIST kosong, ...") ditulis SEBELUM kolom ini diisi
  // otomatis di atas, jadi begitu terisi catatan itu jadi basi dan
  // membingungkan (kartu klaim sudah menampilkan kode valid, tapi masih ada
  // kotak AI menyuruh mengisi DIAGLIST). Ditemukan pada SEP 0170R0110826V003045
  // (SUMIDAH). Dibuang di sini, sesudah nilai akhir perubahan diketahui.
  let catatanBasiDibuang = false;
  if (aiReview && aiReview.field_notes && typeof aiReview.field_notes === 'object') {
    // field_notes memakai NAMA KOLOM basis data sebagai kunci ("diagnosa_list",
    // bukan "DIAGLIST") -- lihat field_name di rule RV-05/RV-06 (seed.js) dan
    // errorFieldNames di aiReviewService.js yang menyaringnya dari situ.
    if (perubahan.diagnosa_list && aiReview.field_notes.diagnosa_list) {
      delete aiReview.field_notes.diagnosa_list;
      catatanBasiDibuang = true;
    }
    if (perubahan.prosedur_list && aiReview.field_notes.prosedur_list) {
      delete aiReview.field_notes.prosedur_list;
      catatanBasiDibuang = true;
    }
  }

  // Prosedur "jangan pernah kosong DIAM-DIAM": kalau PROCLIST masih kosong
  // setelah semua sumber di atas, catat ALASANNYA secara eksplisit beserta
  // kandidat yang terdeteksi tapi kodenya belum pasti atau tertahan aturan RS
  // (mis. pemasangan infus) -- supaya koder tinggal klik, bukan menebak dari
  // nol kenapa kosong. TIDAK PERNAH mengisi kode yang belum pasti ke PROCLIST
  // -- prosedur yang tidak pernah dilakukan adalah temuan fraud, bukan
  // sekadar kesalahan koding. Kandidatnya diambil dari usulan_prosedur yang
  // sudah dihitung di atas (tahap KODING); tidak menghitung ulang apa pun.
  if (aiReview) {
    const proclistAkhir = perubahan.prosedur_list || record.PROCLIST || record.prosedur_list;
    if (kosong(proclistAkhir)) {
      const kandidat = Array.isArray(aiReview.usulan_prosedur)
        ? aiReview.usulan_prosedur.filter(u => u && !u.masuk_proclist)
        : [];
      aiReview.proclist_kosong = {
        alasan: kandidat.length > 0
          ? `${kandidat.length} tindakan terdeteksi di berkas, tapi kodenya belum pasti atau tertahan aturan RS.`
          : 'Tidak ada tindakan yang terbaca dari berkas ini.',
        kandidat: kandidat.map(k => ({
          nama: k.nama, kode_usulan: k.kode_usulan, alasan: k.alasan,
          sumber_bukti: k.sumber_bukti, halaman_bukti: k.halaman_bukti,
        })),
      };
      catatanBasiDibuang = true;
    } else if (aiReview.proclist_kosong) {
      // Terisi (di sini atau sebelumnya) -- catatan lama jadi basi.
      delete aiReview.proclist_kosong;
      catatanBasiDibuang = true;
    }
  }

  if (catatanBasiDibuang) {
    await simpanAiReview(db, recordId, aiReview);
  }

  // AI yang MEMUTUSKAN pending, bukan rule engine. Rule engine (validateRecord)
  // cuma memeriksa format field (SEP, DIAGLIST berformat ICD-10, dst) -- ia
  // buta terhadap kegawatdaruratan klinis, kode di luar kamus, dan
  // konsistensi data, yang semuanya cuma dinilai lewat putusan_pending.
  // Tanpa langkah ini, klaim yang AI sendiri sudah tandai "berisiko dipending"
  // bisa tetap tampil VALID kalau format fieldnya bersih -- casemix mengunggah
  // klaim yang sudah pernah dipending BPJS, dan aplikasi bilang "lolos".
  // Dijalankan SELALU, sebelum "if (Object.keys(perubahan)...) return" di
  // bawah, supaya berlaku juga untuk klaim yang DIAGLIST/PROCLIST-nya sudah
  // terisi sejak awal (tidak ada yang perlu diisi otomatis) -- justru itu
  // kasus paling umum saat casemix mengunggah ulang klaim lama untuk diuji.
  //
  // Hanya menaikkan, tidak pernah menurunkan: kalau status saat ini sudah
  // 'pending' atau 'error', dibiarkan.
  let aiBilangPending = aiReview && aiReview.putusan_pending
    && aiReview.putusan_pending.status === 'berisiko_pending';
  if (aiBilangPending) {
    try {
      const barisSaatIni = await db.prepare('SELECT validation_status, file_id FROM claim_records WHERE id = ?').get(recordId);
      if (barisSaatIni && barisSaatIni.validation_status !== 'error' && barisSaatIni.validation_status !== 'pending') {
        await db.prepare('UPDATE claim_records SET validation_status = ? WHERE id = ?').run('pending', recordId);
        if (barisSaatIni.file_id) await recomputeFileCounts(db, barisSaatIni.file_id);
      }
    } catch (errStatusAi) {
      console.warn(`[AutoIsi] Gagal menaikkan status pending dari putusan AI record ${recordId}: ${errStatusAi.message}`);
    }
  }

  // Grouping INA-CBG & tarif (di dalam generateAiReview) dihitung dari kode
  // yang ada SAAT AI review dijalankan -- sering masih kosong kalau DIAGLIST
  // baru terisi di FUNGSI INI. Akibatnya panel FE menampilkan "Pending
  // verifikasi" terus walau DIAGLIST/PROCLIST akhirnya valid (ditemukan pada
  // SEP 0170R0110826V003045 / SUMIDAH). Dihitung ulang di sini dengan kode
  // FINAL (setelah perubahan di atas), hanya kalau belum pernah berhasil
  // (aiReview.inacbg_result masih null) -- tidak pernah menimpa hasil yang
  // sudah ada, dan tidak pernah mengarang tarif (hitungInacbgDanTarif hanya
  // membaca tabel referensi PMK 3/2023, sama seperti generateAiReview).
  // Dijalankan SELALU (sebelum "if (Object.keys(perubahan)...) return" di
  // bawah), supaya berlaku juga saat DIAGLIST/PROCLIST sudah lengkap sejak
  // awal dan tidak ada yang perlu diisi otomatis.
  // Hasil grouper Agen Casemix dihitung dari kode final rekomendasi; bila kode
  // yang baru diisi sama persis, hasil agen dipertahankan (tidak dihitung ulang
  // dengan aturan berbeda).
  const grouperAgen = aiReview && aiReview.agen_casemix && aiReview.agen_casemix.grouper;
  const daftarKode = v => String(v || '').split(/[;,]/).map(k => k.trim().toUpperCase()).filter(Boolean).join(';');
  const samaDenganAgen = Boolean(grouperAgen && grouperAgen.kode && aiReview.inacbg_result
    && daftarKode(perubahan.diagnosa_list || record.DIAGLIST || record.diagnosa_list) === daftarKode((grouperAgen.dx || []).join(';'))
    && daftarKode(perubahan.prosedur_list || record.PROCLIST || record.prosedur_list) === daftarKode((grouperAgen.px || []).join(';')));
  if ((perubahan.diagnosa_list || perubahan.prosedur_list) && !samaDenganAgen) {
    aiReview.inacbg_result = null;
    aiReview.tariff_result = null;
    aiReview.suggested_inacbg = '';
    aiReview.suggested_tarif = null;
  }
  if (aiReview && !aiReview.inacbg_result) {
    try {
      const diaglistAkhir = perubahan.diagnosa_list || record.DIAGLIST || record.diagnosa_list || '';
      const proclistAkhir = perubahan.prosedur_list || record.PROCLIST || record.prosedur_list || '';
      const final = kodeFinal({ ...record, DIAGLIST: diaglistAkhir, PROCLIST: proclistAkhir }, aiReview);
      const diagnosisAkhir = final.dx;
      if (diagnosisAkhir.length > 0) {
        const prosedurAkhir = final.px;
        const jenisKlaimAkhir = record.JENIS_KLAIM || record.jenis_klaim;
        const kelasRawatAkhir = require('../services/kelasPerawatanService').kelasTarif(record);
        const { inacbgCodeForLookup, inacbgResult, tarifResult } = hitungInacbgDanTarif(
          diagnosisAkhir, prosedurAkhir, jenisKlaimAkhir, kelasRawatAkhir, aiReview.suggested_inacbg,
        );
        if (inacbgResult) {
          aiReview.kode_final = final;
          aiReview.inacbg_result = inacbgResult;
          aiReview.tariff_result = tarifResult;
          if (inacbgCodeForLookup) {
            aiReview.suggested_inacbg = inacbgCodeForLookup;
            aiReview.suggested_tarif = tarifResult ? tarifResult.amount : null;
          }
          await simpanAiReview(db, recordId, aiReview);
        }
      }
    } catch (errInacbg) {
      console.warn(`[AutoIsi] Gagal menghitung ulang INA-CBG/tarif record ${recordId}: ${errInacbg.message}`);
    }
  }

  for (const [kolom, nilai] of Object.entries(perubahan)) {
    await db.prepare(`UPDATE claim_records SET ${kolom} = ? WHERE id = ?`).run(nilai, recordId);
    console.log(`[AutoIsi] record ${recordId}: ${kolom} diisi dari saran tervalidasi kamus -> ${nilai}`);
  }

  // Hitung ulang validasi supaya error lama tidak menempel.
  try {
    const barisTerbaru = await db.prepare('SELECT * FROM claim_records WHERE id = ?').get(recordId);
    if (!barisTerbaru) return;
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const errorBaru = await validasiRecordDenganKamus(db, barisTerbaru, activeRules);
    await db.prepare('DELETE FROM validation_errors WHERE record_id = ?').run(recordId);
    if (errorBaru.length > 0) {
      const insert = db.prepare(`
        INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const e of errorBaru) {
        await insert.run(uuidv4(), recordId, e.rule_id, e.field_name, e.error_message, e.expected_value || '', e.actual_value || '', e.severity);
      }
    }
    // Putusan pending disusun saat kolom kode mungkin masih kosong. Alasan
    // validasi yang sudah teratasi oleh pengisian di atas (mis. RV-05 DIAGLIST
    // kosong) dibuang supaya tidak tetap tampil dan tidak tetap menahan klaim
    // di status pending -- lihat segarkanAlasanValidasi.
    const putusanSegar = segarkanAlasanValidasi(aiReview && aiReview.putusan_pending, errorBaru);
    if (putusanSegar) {
      aiReview.putusan_pending = putusanSegar;
      aiBilangPending = putusanSegar.status === 'berisiko_pending';
      await db.prepare('UPDATE claim_records SET ai_review = ? WHERE id = ?').run(JSON.stringify(aiReview), recordId);
    }

    // Jangan pernah MENURUNKAN status balik ke 'valid' hanya karena rule
    // engine (format field) sekarang bersih -- AI bisa saja sudah menaikkan
    // status ke 'pending' di atas (aiBilangPending) karena alasan yang rule
    // engine buta terhadapnya (kegawatdaruratan, kode di luar kamus, dst).
    // Ambil yang lebih parah dari keduanya, bukan menimpa begitu saja.
    const statusRuleEngine = determineStatus(errorBaru);
    const URUTAN_STATUS = { valid: 0, pending: 1, error: 2 };
    const statusSaatIni = Object.keys(perubahan).length > 0
      ? (aiBilangPending ? 'pending' : 'valid') : barisTerbaru.validation_status;
    const statusAkhir = (URUTAN_STATUS[statusSaatIni] || 0) > (URUTAN_STATUS[statusRuleEngine] || 0)
      ? statusSaatIni
      : statusRuleEngine;
    await db.prepare('UPDATE claim_records SET validation_status = ?, error_count = ? WHERE id = ?')
      .run(statusAkhir, errorBaru.length, recordId);

    // Cache ringkasan di claim_files (dibaca panel "Hasil Validasi" & Riwayat
    // Upload) dihitung SEBELUM fungsi ini mengisi DIAGLIST/PROCLIST otomatis
    // dan mengubah validation_status record ini -- tanpa baris ini, klaim yang
    // baru saja jadi valid tetap terhitung pending/error di ringkasan atas
    // walau badge per-baris sudah benar. Ditemukan pada SEP 0170R0110826V003045
    // (SUMIDAH): kartu klaim menampilkan "VALID" tapi ringkasan atas
    // menampilkan "100% PENDING".
    if (barisTerbaru.file_id) await recomputeFileCounts(db, barisTerbaru.file_id);
  } catch (errValidasi) {
    console.warn(`[AutoIsi] Gagal hitung ulang validasi record ${recordId}: ${errValidasi.message || errValidasi}`);
    throw errValidasi;
  }
}

/**
 * P1-6: cek apakah SEP yang baru diekstrak SUDAH ada di claim_records
 * manapun (lintas file_id -- bukan cuma dalam batch/file yang sama). Dipakai
 * untuk MEMPERINGATKAN upload duplikat (sejak 21 Sep 2026 tidak lagi menolak,
 * lihat pemakaiannya): kasus nyata SEP yang sama sempat ke-upload 2x
 * sebagai kategori berbeda (IGD & Rawat Jalan) di hari yang sama, risiko
 * klaim ganda kalau lolos ke vClaim. Scoped per hospital_code sama seperti
 * detectAndFlagInternalEpisodes() -- SEP BPJS pada praktiknya cuma relevan
 * dibandingkan dalam RS yang sama.
 * @returns {Promise<{jenis_klaim: string, created_at: string, file_name: string}|null>}
 */
async function findExistingRecordBySep(db, { hospitalCode, sep }) {
  if (!sep) return null;
  const existing = await db.prepare(`
    SELECT cr.jenis_klaim, cr.created_at, cf.file_name
    FROM claim_records cr
    JOIN claim_files cf ON cf.id = cr.file_id
    WHERE cr.sep = ? AND cf.hospital_code = ? AND cf.is_testing = FALSE
    ORDER BY cr.created_at ASC
    LIMIT 1
  `).get(sep, hospitalCode || '3371084');
  return existing || null;
}

async function processSinglePdfUpload(db, options) {
  const fileId=options.fileId||uuidv4(),recordId=options.recordId||uuidv4();
  const hospitalCode=options.hospitalCode||'3371084';
  const anggaran=require('../services/anggaranAiService');
  const scope=await anggaran.untukBerkas(db,{filePath:options.filePath,hospitalCode,
    jenis:options.allowedJenisKlaim||[options.jenisKlaim],recordId});
  return konteksAi.jalankan({hospital_code:hospitalCode,record_id:recordId,file_id:fileId,anggaran_ai:scope},
    async()=>{
      const existing=await db.get(`SELECT cr.*,cf.file_path,cf.file_name FROM claim_records cr
        JOIN claim_files cf ON cf.id=cr.file_id WHERE cr.id=? AND cf.id=? AND cf.hospital_code=?`,[recordId,fileId,hospitalCode]);
      if(existing) return lanjutkanAnalisisTersimpan(db,existing,{...options,fileId,recordId,hospitalCode});
      return processSinglePdfUploadDenganKonteks(db,{...options,fileId,recordId});
    });
}

/** Sesudah restart/gangguan DB, lanjutkan dari record & bukti tersimpan. */
async function lanjutkanAnalisisTersimpan(db, record, {fileId,recordId,hospitalCode,originalName,onTahap}) {
  const stage=async(t,info={})=>{if(onTahap) await onTahap(t,info);};
  await stage('membaca_berkas',{file_id:fileId,record_id:recordId,pesan:'Melanjutkan tahap tersimpan tanpa membaca PDF dari awal.'});
  const pages=await db.prepare('SELECT page_number,ocr_text,confidence FROM ocr_results WHERE record_id=? ORDER BY page_number').all(recordId);
  const errors=await db.prepare('SELECT * FROM validation_errors WHERE record_id=?').all(recordId);
  let ai;
  let classification;
  let gangguanKode=false;
  try {ai=typeof record.ai_review==='string'?JSON.parse(record.ai_review):record.ai_review;} catch {ai=null;}
  if(Array.isArray(ai?.pembacaan_pdf?.halaman_wajib)) {
    classification={pages:ai.pembacaan_pdf.halaman_wajib.map(page_num=>({page_num}))};
  }
  const {nilaiKelengkapanAnalisis}=require('../services/kelengkapanAnalisisService');
  if(nilaiKelengkapanAnalisis(ai,{evidencePool:pages,wajibTahap:true}).status!=='lengkap') {
    let raw={};try{raw=JSON.parse(record.raw_data||'{}');}catch{/* Bukti dan record tetap dipertahankan. */}
    const [knowledge,examples]=await Promise.all([
      getRelevantKnowledge(db,errors.map(e=>e.rule_id)),getRelevantBpjsExamples(db,{...record,validationErrors:errors})]);
    await stage('review_ai');
    ai=await generateAiReview({...raw,...record,id:recordId,JENIS_KLAIM:record.jenis_klaim},errors,pages,knowledge,examples);
    if(ai) {
      await stage('mengisi_kode');await simpanAiReview(db,recordId,ai);
      await isiKodeDariSaranTervalidasi(db,recordId,record,ai).catch(()=>{gangguanKode=true;});
    }
  }
  const result=await finalisasiAnalisisPdf(db,{recordId,fileId,review:ai,evidencePool:pages,classification,gangguanKode});
  return {success:true,file_id:fileId,record_id:recordId,original_name:originalName||record.file_name,
    jenis_klaim:record.jenis_klaim,dilanjutkan:true,...result};
}

async function finalisasiAnalisisPdf(db, { recordId, fileId, review, evidencePool, classification, gangguanKode }) {
  const latest = await db.prepare('SELECT * FROM claim_records WHERE id = ?').get(recordId);
  if (!latest) throw new Error('Hasil tersimpan tidak ditemukan.');
  let saved = review;
  if (review && latest.ai_review) {
    try { saved = typeof latest.ai_review === 'string' ? JSON.parse(latest.ai_review) : latest.ai_review; } catch (_) { /* pakai hasil saat ini */ }
  }
  if (!saved) saved = { analisis_tidak_tersedia: true };
  if(classification?.pages) saved.pembacaan_pdf={halaman_wajib:classification.pages
    .filter(p=>!p.is_lembar_grouper && !p.is_primary_source).map(p=>Number(p.page_num))};
  saved.kelengkapan_analisis = nilaiKelengkapanAnalisis(saved, { evidencePool, classification, gangguanKode, wajibTahap: true });
  const scope=konteksAi.saatIni().anggaran_ai;
  if(scope) {
    saved.anggaran_ai=await require('../services/anggaranAiService').ringkasan(db,scope);
    await db.prepare('UPDATE claim_files SET ai_anggaran_id=? WHERE id=?').run(scope.id,fileId);
  }
  await simpanAiReview(db, recordId, saved);
  const errors = await db.prepare('SELECT * FROM validation_errors WHERE record_id = ?').all(recordId);
  const belumLengkap = saved.kelengkapan_analisis.status !== 'lengkap';
  const status = belumLengkap && latest.validation_status !== 'error' ? 'pending' : latest.validation_status;
  await db.prepare('UPDATE claim_records SET validation_status = ?, error_count = ? WHERE id = ?').run(status, errors.length, recordId);
  await recomputeFileCounts(db, fileId);
  const usage=await db.prepare(`SELECT COUNT(*) AS calls,COUNT(*) FILTER(WHERE total_tokens>0) AS measured,
    SUM(prompt_tokens) AS input,SUM(completion_tokens) AS output,SUM(total_tokens) AS total
    FROM catatan_panggilan_model WHERE hospital_code=? AND record_id IN
    (SELECT id FROM claim_records WHERE file_id=?)`).get(konteksAi.saatIni().hospital_code||latest?.kode_rs,fileId);
  if(Number(usage?.measured)>0) await db.prepare(`UPDATE claim_files SET ai_prompt_tokens=?,ai_completion_tokens=?,ai_total_tokens=? WHERE id=?`)
    .run(Number(usage.input)||0,Number(usage.output)||0,Number(usage.total)||0,fileId);
  await db.prepare("UPDATE claim_files SET status='completed',validated_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(fileId);
  return { ai_review: saved, validation_status: status, validation_errors: errors,
    analysis_status: saved.kelengkapan_analisis.status,
    analysis_warning: belumLengkap ? 'Berkas tersimpan, tetapi ada tahap analisis yang belum selesai. Buka hasil untuk melihat tahap dan bukti yang perlu ditinjau.' : null };
}

async function processSinglePdfUploadDenganKonteks(db, { filePath, originalName, jenisKlaim: fixedJenisKlaim, allowedJenisKlaim, userId, hospitalCode, isTesting = false, onTahap = null, fileId: plannedFileId,recordId: plannedRecordId }) {
  // Pencatat tahap (status proses unggah tersimpan); kegagalannya tidak pernah menghentikan proses.
  const tahap = (nama, info) => { if (typeof onTahap === 'function') Promise.resolve().then(() => onTahap(nama, info)).catch(() => {}); };
  let fileIdDibuat = null; // dibersihkan bila gagal di tengah, supaya percobaan ulang tidak menggandakan berkas
  try {
    tahap('membaca_berkas');
    const { extractFromPDF } = require('../services/pdfExtractionPipeline');
    const result = await extractFromPDF(filePath, { jenisKlaim: fixedJenisKlaim, allowedJenisKlaim,
      onPages: jumlah => tahap('membaca_berkas', { jumlah_halaman: jumlah }),
      originalName: isTesting ? 'berkas-klaim.pdf' : originalName });

    if (!result.success) {
      // Detail teknis hanya untuk log server, tidak dikirim ke pengguna.
      console.error('[upload-pdf] gagal:', originalName, JSON.stringify(result.errors));
      return { success: false, original_name: originalName, error: result.pesan, error_code:result.error_code,
        // Timeout/keluaran AI yang belum sah tidak memicu permintaan berbayar kedua.
        dapat_diulang: !result.error_code && (!result.pesan || /coba lagi|tidak dapat dibaca/i.test(result.pesan)) };
    }

    // jenisKlaim final: dipilih manual (upload 1 file) ATAU hasil deteksi
    // otomatis dari isi dokumen (upload batch kategori-campur, lihat
    // detectJenisKlaim di pdfPageClassifier.js + resolusinya di
    // extractFromPDF). Semua pemakaian jenisKlaim di bawah ini otomatis
    // pakai nilai final ini.
    const jenisKlaim = fixedJenisKlaim || result.jenisKlaimDetection?.value || 'RAWAT_INAP';

    const fileId = plannedFileId || uuidv4();
    fileIdDibuat = fileId;
    const recordId = plannedRecordId || uuidv4();
    tahap('menyimpan', { jumlah_halaman: result.metadata?.pagesProcessed || result.classification?.totalPages || null, file_id: fileId, record_id: recordId });
    const resolvedFilePath = path.resolve(filePath);

    // Record vClaim lengkap 60 kolom (urutan & format sesuai output vClaim asli).
    // jenis_klaim ditambahkan dari pilihan user (AI ekstraksi tidak pernah
    // menghasilkan field ini) - jadi konteks "memory" untuk AI review nanti.
    const extractedData = { ...result.record, JENIS_KLAIM: jenisKlaim };

    // P1-6: REJECT (bukan cuma warn) kalau SEP ini SUDAH ada di claim_records
    // manapun -- beda dari pola detectAndFlagInternalEpisodes (flag-only,
    // verifikator yang putuskan) karena SEP identik risikonya klaim ganda
    // LANGSUNG ke BPJS, bukan sekadar pola yang perlu direview. Dicek di sini
    // (sebelum insert claim_files/claim_records) supaya tidak ada baris
    // setengah-tersimpan kalau ditolak.
    // TIDAK LAGI menolak (21 Sep 2026, permintaan klien): rumah sakit memang
    // mengupload berkas yang sama berulang kali, dan penolakan membuat alur
    // kerja mereka buntu. Semua upload kini disimpan sebagai baris tersendiri
    // supaya jejak auditnya utuh.
    //
    // Deteksinya SENGAJA dipertahankan sebagai peringatan: risiko yang dulu
    // memicu pengecekan ini -- SEP sama terkirim 2x ke vClaim sebagai klaim
    // ganda -- tidak hilang hanya karena uploadnya diizinkan. Sekarang jadi
    // catatan di log, bukan penghalang.
    //
    // KONSEKUENSI yang disadari: Riwayat Upload bisa memuat beberapa baris
    // dengan SEP sama, dan rekap yang menghitung per baris bisa terhitung ganda.
    if (!isTesting && extractedData.SEP) {
      try {
        const duplikat = await findExistingRecordBySep(db, { hospitalCode, sep: extractedData.SEP });
        if (duplikat) {
          const diuploadPada = duplikat.created_at
            ? new Date(duplikat.created_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' })
            : 'waktu tidak diketahui';
          console.warn(`[Upload] SEP ${extractedData.SEP} sudah pernah diupload pada ${diuploadPada} -- tetap diproses sebagai baris baru.`);
        }
      } catch (errDuplikat) {
        // Peringatan saja: kegagalan pengecekan tidak boleh menggagalkan upload.
        console.warn(`[Upload] Gagal cek duplikat SEP: ${errDuplikat.message || errDuplikat}`);
      }
    }

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
    if (!isTesting) await autofillFromMrn(db, { hospitalCode, extractedData, jenisKlaim });

    // Convert vClaim format to database format for validation
    const dbRecord = vclaimToDbFormat(extractedData);
    dbRecord.jenis_klaim = jenisKlaim;
    // has_bpjs_page bukan field vClaim resmi (tidak lewat MAPPING di
    // vclaimToDbFormat) — dihitung terpisah di pdfExtractionPipeline.js dari
    // teks mentah dokumen. Default true kalau tidak diset (dokumen lama/jalur
    // non-PDF) supaya tidak melonggarkan validasi RV-01/RV-02 tanpa sengaja.
    dbRecord.has_bpjs_page = result.record.has_bpjs_page !== false;
    // RV-12: konservatif (default false) -- cuma true kalau detector benar2
    // nemu markernya, lihat catatan di pdfExtractionPipeline.js.
    dbRecord.has_laporan_operasi = result.record.has_laporan_operasi === true;
    dbRecord.has_hasil_pa = result.record.has_hasil_pa === true;

    // Run validation on extracted record
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const validationErrors = await validasiRecordDenganKamus(db, dbRecord, activeRules);
    const validationStatus = determineStatus(validationErrors);

    // Save file record with status='uploaded' (data extraction complete).
    // valid_count/error_count/pending_count harus diisi di sini juga (bukan
    // cuma di claim_records) — halaman Riwayat Upload bacanya dari kolom ini,
    // dan untuk jalur PDF (1 file = 1 record) nilainya langsung turunan dari
    // validationStatus record itu sendiri.
    await db.prepare(`
      INSERT INTO claim_files (id, hospital_code, file_name, file_path, status, uploaded_by, total_records, valid_count, error_count, pending_count, description, jenis_klaim, is_testing)
      VALUES (?, ?, ?, ?, 'uploaded', ?, 1, ?, ?, ?, 'Extracted from PDF', ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      fileId, hospitalCode || '3371084', originalName, resolvedFilePath, userId,
      validationStatus === 'valid' ? 1 : 0,
      validationStatus === 'error' ? 1 : 0,
      validationStatus === 'pending' ? 1 : 0,
      jenisKlaim, isTesting
    );

    // Save extracted record with validation results using transaction
    await db.transaction(async (tx) => {
      const txInsertRecord = tx.prepare(`
        INSERT INTO claim_records (
          id, file_id, row_number, kode_rs, sep, nokartu, nama_pasien, mrn,
          birth_date, gender, kelas_rawat, admission_date, discharge_date,
          discharge_status, los, diagnosa_list, prosedur_list, dpjp_name,
          tarif_rs, jenis_klaim, validation_status, error_count, raw_data, klinik_poli, has_bpjs_page,
          has_laporan_operasi, has_hasil_pa
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      await txInsertRecord.run(
        recordId, fileId, extractedData.KODE_RS, extractedData.SEP, extractedData.NOKARTU,
        extractedData.NAMA_PASIEN, extractedData.MRN,
        vclaimDateToISO(extractedData.BIRTH_DATE), extractedData.SEX,
        /^\d+$/.test(extractedData.KELAS_RAWAT) ? parseInt(extractedData.KELAS_RAWAT) : null,
        vclaimDateToISO(extractedData.ADMISSION_DATE), vclaimDateToISO(extractedData.DISCHARGE_DATE),
        /^\d+$/.test(extractedData.DISCHARGE_STATUS) ? parseInt(extractedData.DISCHARGE_STATUS) : 1,
        /^\d+$/.test(String(extractedData.LOS || '')) ? parseInt(extractedData.LOS) : 0,
        extractedData.DIAGLIST, extractedData.PROCLIST,
        extractedData.DPJP,
        /^\d+$/.test(extractedData.TARIF_RS) ? parseInt(extractedData.TARIF_RS) : null, jenisKlaim,
        validationStatus, validationErrors.length, JSON.stringify(extractedData), extractedData.KLINIK_SEP || null,
        dbRecord.has_bpjs_page, dbRecord.has_laporan_operasi, dbRecord.has_hasil_pa
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
    if (!isTesting) {
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
    }

    // Periode diisi di sini, setelah record tersimpan, supaya pengelompokan
    // dan arsip per bulan ikut terbentuk untuk berkas yang baru masuk.
    try {
      await isiPeriodeUntukFile(db, fileId);
    } catch (e) {
      // periode bukan syarat berkas dianggap berhasil diproses
      console.warn('[periode] gagal mengisi periode:', e.message);
    }

    // Alur AI ekstraksi -> rule engine -> AI review: setelah record tersimpan
    // (dibutuhkan supaya ocr_results punya record_id valid untuk FK), kumpulkan
    // bukti dokumen dan jalankan AI review sekali, simpan hasilnya supaya saat
    // halaman hasil dibuka nanti tidak perlu AI call lagi.
    let aiReview = null;
    let buktiReview = [];
    let gangguanKode = false;
    try {
      // OCR dari tahap ekstraksi dipakai ulang -- tidak meng-OCR PDF dua kali.
      if (result.ocrPages) {
        await saveOcrResultsToDb(db, recordId, { success: true, pages: result.ocrPages })
          .catch(e => console.warn(`[upload-pdf] gagal simpan OCR tahap ekstraksi: ${e.message}`));
      }
      const evidencePool = await gatherEvidencePool(db, recordId, resolvedFilePath,result.classification);
      buktiReview = evidencePool;
      const knowledgeEntries = await getRelevantKnowledge(db, validationErrors.map(e => e.rule_id));
      const bpjsExamples = await getRelevantBpjsExamples(db, { ...extractedData, validationErrors });
      tahap('review_ai');
      aiReview = await generateAiReview({ ...extractedData, id: recordId }, validationErrors, evidencePool, knowledgeEntries, bpjsExamples);
      // Hasil casemix dari lembar grouper E-Klaim: pembanding, bukan bahan bacaan.
      if (aiReview && result.lembarGrouper) aiReview.lembar_grouper = result.lembarGrouper;
      if (aiReview) {
        tahap('mengisi_kode');
        await simpanAiReview(db, recordId, aiReview);
        // Kode saran yang sudah terverifikasi kamus ICD-10 langsung mengisi
        // DIAGLIST/PROCLIST yang masih kosong -- koder tidak perlu mengetik
        // ulang. Best-effort: kegagalan di sini tidak menggagalkan review.
        if (!isTesting) {
          await isiKodeDariSaranTervalidasi(db, recordId, extractedData, aiReview).catch(errIsi => {
            gangguanKode = true;
            console.warn(`[AutoIsi] gagal untuk record ${recordId}: ${errIsi.message || errIsi}`);
          });
          recordKnowledge(db, aiReview.knowledge_updates).catch(kbErr =>
            console.warn(`[upload-pdf] Gagal simpan knowledge base: ${kbErr.message}`));
        }
      }
    } catch (aiErr) {
      console.warn(`[upload-pdf] AI review gagal untuk record ${recordId}: ${aiErr.message}`);
      aiReview = null;
    }

    const finalAnalysis = await finalisasiAnalisisPdf(db, { recordId, fileId, review: aiReview,
      evidencePool: buktiReview, classification: result.classification, gangguanKode });

    if (isTesting) {
      const stored = await db.prepare('SELECT * FROM claim_records WHERE id = ?').get(recordId);
      const { prediksi } = require('../services/testingPendingService');
      const snapshot = prediksi(stored, validationErrors);
      await db.run(`INSERT INTO testing_pending(record_id,hospital_code,prediction,prediction_snapshot,
        actual_result,reference_source,reason_match,updated_by) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO NOTHING`,
        [recordId, hospitalCode, snapshot.status, JSON.stringify(snapshot), 'belum_diketahui', 'BPJS', 'belum_dinilai', userId]);
    }

    return {
      success: true,
      file_id: fileId,
      record_id: recordId,
      original_name: originalName,
      vclaimFormat: extractedData,
      ...finalAnalysis,
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
    if (fileIdDibuat) {
      // Jangan menghapus record/bukti yang sudah masuk ketika tahap setelahnya
      // terganggu. Percobaan antrean berikutnya melanjutkan ID yang sama.
      const saved=await db.get('SELECT id FROM claim_records WHERE file_id=?',[fileIdDibuat]).catch(()=>null);
      if(saved) return {success:false,dapat_diulang:true,file_id:fileIdDibuat,record_id:saved.id,
        original_name:originalName,error:'Data klaim sudah tersimpan; tahap analisis dilanjutkan otomatis.'};
      await db.prepare("UPDATE claim_files SET status='error',total_records=0,valid_count=0,error_count=0,pending_count=0 WHERE id=?")
        .run(fileIdDibuat).catch(()=>{});
    }
    return { success: false, dapat_diulang: true, original_name: originalName, error: 'Terjadi gangguan saat memproses berkas. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' };
  }
}

/**
 * "Baca Ulang" — jalankan ulang ekstraksi -> rule engine -> AI review untuk
 * SATU record yang SUDAH ADA (bukan upload baru), pakai file PDF yang sudah
 * tersimpan di disk. Dipakai saat verifikator lihat ada field kosong/error
 * (mis. DIAGLIST, DISCHARGE_DATE) yang dicurigai sebenarnya ADA di dokumen
 * tapi terlewat oleh AI ekstraksi pertama — mis. karena prompt sudah
 * diperbaiki, atau AI cuma "kurang beruntung" di percobaan pertama.
 *
 * UPDATE di tempat (bukan INSERT record baru) — file_id & record_id tetap
 * sama, supaya link/histori yang sudah ada (pending BPJS, dst) tidak putus.
 *
 * @returns {Promise<{success:boolean, error?:string, vclaimFormat?, validation_status?, validation_errors?, ai_review?}>}
 */
async function reprocessExistingRecord(db, options) {
  const file=await db.get('SELECT hospital_code,ai_anggaran_id FROM claim_files WHERE id=?',[options.fileId]);
  const hospitalCode=options.hospitalCode||file?.hospital_code||'3371084';
  const scope=await require('../services/anggaranAiService').untukBerkas(db,{filePath:options.filePath,hospitalCode,
    jenis:[options.jenisKlaim],recordId:options.recordId,anggaranId:file?.ai_anggaran_id});
  return konteksAi.jalankan({ hospital_code:hospitalCode,record_id:options.recordId,file_id:options.fileId,anggaran_ai:scope },
    () => reprocessExistingRecordDenganKonteks(db, options));
}

async function reprocessExistingRecordDenganKonteks(db, { fileId, recordId, filePath, jenisKlaim, hospitalCode }) {
  try {
    const { extractFromPDF } = require('../services/pdfExtractionPipeline');
    const result = await extractFromPDF(filePath, { jenisKlaim, originalName: path.basename(filePath) });

    if (!result.success) {
      console.error('[reread] gagal:', recordId, JSON.stringify(result.errors));
      return { success: false, error: result.pesan };
    }

    const extractedData = { ...result.record, JENIS_KLAIM: jenisKlaim };

    if (!extractedData.KODE_RS && hospitalCode) {
      extractedData.KODE_RS = hospitalCode;
    }
    if (!extractedData.KELAS_RS) {
      const hospitalSettings = await db.prepare('SELECT kelas_rs FROM hospital_settings WHERE hospital_code = ?').get(hospitalCode || '3371084');
      if (hospitalSettings?.kelas_rs) extractedData.KELAS_RS = hospitalSettings.kelas_rs;
    }

    await autofillFromMrn(db, { hospitalCode, extractedData, jenisKlaim });

    const dbRecord = vclaimToDbFormat(extractedData);
    dbRecord.jenis_klaim = jenisKlaim;
    dbRecord.has_bpjs_page = result.record.has_bpjs_page !== false;
    dbRecord.has_laporan_operasi = result.record.has_laporan_operasi === true;
    dbRecord.has_hasil_pa = result.record.has_hasil_pa === true;

    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const validationErrors = await validasiRecordDenganKamus(db, dbRecord, activeRules);
    const validationStatus = determineStatus(validationErrors);

    await db.transaction(async (tx) => {
      await tx.prepare(`
        UPDATE claim_records SET
          kode_rs = ?, sep = ?, nokartu = ?, nama_pasien = ?, mrn = ?,
          birth_date = ?, gender = ?, kelas_rawat = ?, admission_date = ?, discharge_date = ?,
          discharge_status = ?, los = ?, diagnosa_list = ?, prosedur_list = ?, dpjp_name = ?,
          tarif_rs = ?, validation_status = ?, error_count = ?, raw_data = ?, klinik_poli = ?, has_bpjs_page = ?,
          has_laporan_operasi = ?, has_hasil_pa = ?
        WHERE id = ?
      `).run(
        extractedData.KODE_RS, extractedData.SEP, extractedData.NOKARTU,
        extractedData.NAMA_PASIEN, extractedData.MRN,
        vclaimDateToISO(extractedData.BIRTH_DATE), extractedData.SEX,
        /^\d+$/.test(extractedData.KELAS_RAWAT) ? parseInt(extractedData.KELAS_RAWAT) : null,
        vclaimDateToISO(extractedData.ADMISSION_DATE), vclaimDateToISO(extractedData.DISCHARGE_DATE),
        /^\d+$/.test(extractedData.DISCHARGE_STATUS) ? parseInt(extractedData.DISCHARGE_STATUS) : 1,
        /^\d+$/.test(String(extractedData.LOS || '')) ? parseInt(extractedData.LOS) : 0,
        extractedData.DIAGLIST, extractedData.PROCLIST,
        extractedData.DPJP,
        /^\d+$/.test(extractedData.TARIF_RS) ? parseInt(extractedData.TARIF_RS) : null,
        validationStatus, validationErrors.length, JSON.stringify(extractedData), extractedData.KLINIK_SEP || null,
        dbRecord.has_bpjs_page, dbRecord.has_laporan_operasi, dbRecord.has_hasil_pa,
        recordId
      );

      await tx.prepare('DELETE FROM validation_errors WHERE record_id = ?').run(recordId);
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

      // Sinkronkan cache di claim_files (dibaca panel ringkasan atas & Riwayat
      // Upload) dari HASIL AGREGASI ULANG seluruh record file ini, bukan cuma
      // status record yang baru dibaca ulang -- lihat recomputeFileCounts().
      await recomputeFileCounts(tx, fileId);
    });

    // Best-effort, sama seperti alur upload asli — tidak menggagalkan baca ulang.
    await detectAndFlagInternalEpisodes(db, {
      hospitalCode,
      nokartu: extractedData.NOKARTU,
      admissionDate: vclaimDateToISO(extractedData.ADMISSION_DATE),
    }).catch(() => {});
    await detectAndFlagPRB(db, {
      hospitalCode,
      mrn: extractedData.MRN,
      nokartu: extractedData.NOKARTU,
      admissionDate: vclaimDateToISO(extractedData.ADMISSION_DATE),
      diagnosaList: extractedData.DIAGLIST,
    }).catch(() => {});
    await linkPendingBpjsForSep(db, extractedData.SEP, recordId).catch(() => {});

    let aiReview = null;
    let buktiReview = [];
    let gangguanKode = false;
    try {
      // Baca ulang = OCR baru; bukti AI review memakai hasil yang sama.
      if (result.ocrPages) {
        await saveOcrResultsToDb(db, recordId, { success: true, pages: result.ocrPages })
          .catch(e => console.warn(`[reread] gagal simpan OCR tahap ekstraksi: ${e.message}`));
      }
      const evidencePool = await gatherEvidencePool(db, recordId, path.resolve(filePath),result.classification);
      buktiReview = evidencePool;
      const knowledgeEntries = await getRelevantKnowledge(db, validationErrors.map(e => e.rule_id));
      const bpjsExamples = await getRelevantBpjsExamples(db, { ...extractedData, validationErrors });
      aiReview = await generateAiReview({ ...extractedData, id: recordId }, validationErrors, evidencePool, knowledgeEntries, bpjsExamples);
      // Hasil casemix dari lembar grouper E-Klaim: pembanding, bukan bahan bacaan.
      if (aiReview && result.lembarGrouper) aiReview.lembar_grouper = result.lembarGrouper;
      if (aiReview) {
        // Update validation_status to PENDING jika:
        // 1. Ada pending_risk_notes dari AI review, ATAU
        // 2. Kunjungan IGD tidak memenuhi kriteria kegawatdaruratan.
        let finalStatus = validationStatus;
        let shouldSetPending = false;

        if (aiReview.pending_risk_notes && aiReview.pending_risk_notes.length > 0) {
          shouldSetPending = true;
        }

        // Kunjungan IGD yang TIDAK memenuhi kriteria kegawatdaruratan -> pending.
        // Klaim poli rawat jalan tidak pernah pending karena kriteria ini
        // (permintaan klien 1 Okt 2026), lihat kegawatdaruratanMemicuPending.
        if (kegawatdaruratanMemicuPending(aiReview.kegawatdaruratan_assessment)) {
          shouldSetPending = true;
        }

        if (shouldSetPending) {
          finalStatus = 'pending';
          // Update status di database
          await db.prepare('UPDATE claim_records SET validation_status = ? WHERE id = ?')
            .run(finalStatus, recordId);
        }

        await simpanAiReview(db, recordId, aiReview);
        // Kode saran yang sudah terverifikasi kamus ICD-10 langsung mengisi
        // DIAGLIST/PROCLIST yang masih kosong -- koder tidak perlu mengetik
        // ulang. Best-effort: kegagalan di sini tidak menggagalkan review.
        await isiKodeDariSaranTervalidasi(db, recordId, extractedData, aiReview).catch(errIsi => {
          gangguanKode = true;
          console.warn(`[AutoIsi] gagal untuk record ${recordId}: ${errIsi.message || errIsi}`);
        });
        recordKnowledge(db, aiReview.knowledge_updates).catch(kbErr =>
          console.warn(`[reread] Gagal simpan knowledge base: ${kbErr.message}`));
      } else {
        await simpanAiReview(db, recordId, { analisis_tidak_tersedia: true });
      }
    } catch (aiErr) {
      console.warn(`[reread] AI review gagal untuk record ${recordId}: ${aiErr.message}`);
      aiReview = null;
    }

    const finalAnalysis = await finalisasiAnalisisPdf(db, { recordId, fileId, review: aiReview,
      evidencePool: buktiReview, classification: result.classification, gangguanKode });

    return {
      success: true,
      file_id: fileId,
      record_id: recordId,
      vclaimFormat: extractedData,
      ...finalAnalysis,
    };
  } catch (err) {
    console.error('[reread] error tak terduga:', recordId, err);
    return { success: false, error: 'Terjadi gangguan saat membaca ulang berkas. Silakan coba lagi.' };
  }
}

/**
 * POST /api/v1/claim-files/records/:recordId/reread
 * "Baca Ulang" — re-ekstraksi + re-validasi + re-AI-review 1 record yang
 * sudah ada, pakai PDF yang sudah tersimpan. Lihat reprocessExistingRecord().
 */
/**
 * GET /records/:recordId/saran-koding -- tab "Saran AI": diagnosis, prosedur,
 * INA-CBG, dan tarif yang disusun dari isi berkas (lihat saranKodingService).
 * Dihitung dari data tersimpan tanpa panggilan AI, jadi klaim lama langsung
 * bisa dilihat tanpa Baca Ulang. Tidak mengubah apa pun di klaim.
 */
router.get('/records/:recordId/saran-koding', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare(`
      SELECT id, sep, raw_data, validation_status, diagnosa_list, prosedur_list, jenis_klaim, kelas_rawat, ai_review
      FROM claim_records WHERE id = ?
    `).get(req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Record tidak ditemukan' });
    let aiReview = record.ai_review;
    if (typeof aiReview === 'string') {
      try { aiReview = JSON.parse(aiReview); } catch (_) { aiReview = null; }
    }
    const risiko = perbaruiRisikoTampilan(record);
    res.json({ ...susunSaranKoding(record, aiReview, hitungInacbgDanTarif), kesiapan_koding: risiko.kesiapan_koding });
  } catch (error) {
    console.error('[saran-koding] gagal:', error);
    res.status(500).json({ error: 'Saran koding gagal disusun.' });
  }
});

// Tarif INA-CBG dan iDRG berdampingan + koding versi iDRG. Disusun saat
// dibaca (tanpa AI) supaya klaim lama pun langsung tampil tanpa Baca Ulang.
router.get('/records/:recordId/tarif-ganda', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare(`
      SELECT id, raw_data, diagnosa_list, prosedur_list, jenis_klaim, kelas_rawat, ai_review
      FROM claim_records WHERE id = ?
    `).get(req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Record tidak ditemukan' });
    let aiReview = record.ai_review;
    if (typeof aiReview === 'string') {
      try { aiReview = JSON.parse(aiReview); } catch (_) { aiReview = null; }
    }
    res.json(susunTarifGanda(record, aiReview || {}));
  } catch (error) {
    console.error('[tarif-ganda] gagal:', error);
    res.status(500).json({ error: 'Tarif INA-CBG/iDRG gagal disusun.' });
  }
});

// Laporan Agen Casemix (mode otomatis): ringkasan klinis, rekomendasi koding
// berstatus, persyaratan, klarifikasi, risiko, alternatif koding sah + dampak
// tarif, jejak kerja. Disusun dari data tersimpan tanpa AI.
async function muatLaporanCasemix(db, recordId) {
  const record = await db.prepare('SELECT * FROM claim_records WHERE id = ?').get(recordId);
  if (!record) return null;
  let ai = record.ai_review;
  if (typeof ai === 'string') { try { ai = JSON.parse(ai); } catch (_) { ai = {}; } }
  ai = ai || {};
  // Lembar grouper hanya pembanding casemix: tidak pernah dibaca agen.
  const pages = (await db.prepare('SELECT page_number, ocr_text FROM ocr_results WHERE record_id = ? ORDER BY page_number').all(record.id))
    .filter(p => !isLembarGrouper(p.ocr_text));
  const faktaKlinis = susunFaktaKlinis(pages, ai);
  const saran = susunSaranKoding(record, ai, hitungInacbgDanTarif);
  const { dx, px } = kodeFinal(record, ai);
  const [pelajaran, keputusan] = await Promise.all([
    pelajaranRelevan(db, { dx, px, recordId: record.id, jenisKlaim: record.jenis_klaim, untukPerbandingan: true }).catch(() => []),
    ambilKeputusan(db, record.id),
  ]);
  const laporan = susunLaporanCasemix({ record, ai, faktaKlinis, saran, hitungInacbgDanTarif, kronologi: susunKronologi(pages), pelajaran, keputusan });
  return { record, ai, pages, faktaKlinis, saran, laporan };
}

router.get('/records/:recordId/laporan-casemix', authenticate, async (req, res) => {
  try {
    const muat = await muatLaporanCasemix(getDb(), req.params.recordId);
    if (!muat) return res.status(404).json({ error: 'Record tidak ditemukan' });
    res.json(muat.laporan);
  } catch (error) {
    console.error('[laporan-casemix] gagal:', error);
    res.status(500).json({ error: 'Laporan casemix belum dapat disusun.' });
  }
});

// Keputusan casemix final (casemix RS = keputusan akhir). Disimpan terpisah --
// DIAGLIST/PROCLIST klaim tidak diubah -- lalu dibandingkan dengan rekomendasi
// aplikasi dan dipelajari untuk kasus berikutnya.
router.post('/records/:recordId/keputusan-casemix', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const muat = await muatLaporanCasemix(db, req.params.recordId);
    if (!muat) return res.status(404).json({ error: 'Record tidak ditemukan' });
    const hasil = await simpanKeputusan({
      db, record: muat.record, saran: muat.saran, pages: muat.pages, dx: req.body?.diagnosis, px: req.body?.prosedur,
      catatan: req.body?.catatan, oleh: req.user?.id || null, hitungInacbgDanTarif,
    });
    if (hasil.galat) return res.status(400).json({ error: hasil.galat });
    res.json(hasil);
  } catch (error) {
    console.error('[keputusan-casemix] gagal:', error);
    res.status(500).json({ error: 'Keputusan casemix belum dapat disimpan. Coba lagi.' });
  }
});

// Mode interaktif Agen Casemix: tanya-jawab per berkas. Tidak mengubah data klaim.
router.post('/records/:recordId/agen-casemix/tanya', authenticate, async (req, res) => {
  try {
    const pertanyaan = String(req.body?.pertanyaan || '').trim();
    if (!pertanyaan) return res.status(400).json({ error: 'Pertanyaan wajib diisi.' });
    const db = getDb();
    const muat = await muatLaporanCasemix(db, req.params.recordId);
    if (!muat) return res.status(404).json({ error: 'Record tidak ditemukan' });
    const { record, pages, faktaKlinis, laporan } = muat;
    const file=await db.prepare('SELECT * FROM claim_files WHERE id=?').get(record.file_id);
    if(!canAccessFile(file,req.user)) return res.status(404).json({error:'Record tidak ditemukan'});
    const hasil = await konteksAi.untukRecord(db,record,()=>tanyaAgenCasemix({
      pertanyaan, riwayat: Array.isArray(req.body?.riwayat) ? req.body.riwayat : [], record, pages, faktaKlinis, laporan, hitungInacbgDanTarif, db,
      dikenal: { nama: record.nama_pasien, nomor_kartu: record.nokartu, nik: record.nik, no_rm: record.mrn, sep: record.sep },
    }));
    res.json(hasil);
  } catch (error) {
    console.error('[agen-casemix/tanya] gagal:', error);
    res.status(500).json({ error: 'Agen casemix belum dapat menjawab. Coba lagi.' });
  }
});

// Tab "Pemeriksaan penunjang": pemeriksaan yang sudah dilakukan + hasil lab
// per parameter, disusun dari halaman berkas tersimpan (tanpa AI).
router.get('/records/:recordId/pemeriksaan-penunjang', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare('SELECT id FROM claim_records WHERE id = ?').get(req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Record tidak ditemukan' });
    const pages = await db.prepare('SELECT page_number, ocr_text FROM ocr_results WHERE record_id = ? ORDER BY page_number').all(record.id);
    res.json(susunPemeriksaanPenunjang(pages));
  } catch (error) {
    console.error('[pemeriksaan-penunjang] gagal:', error);
    res.status(500).json({ error: 'Pemeriksaan penunjang gagal disusun.' });
  }
});

// Pratinjau tinjauan kasus pada berkas lama, tanpa mengubah record/putusan pending.
router.post('/records/:recordId/tinjauan-diagnosis', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare('SELECT * FROM claim_records WHERE id = ?').get(req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Record tidak ditemukan.' });
    const file=await db.prepare('SELECT * FROM claim_files WHERE id=?').get(record.file_id);
    if(!canAccessFile(file,req.user)) return res.status(404).json({error:'Record tidak ditemukan.'});
    let ai = record.ai_review;
    if (typeof ai === 'string') { try { ai = JSON.parse(ai); } catch (_) { ai = {}; } }
    ai = ai || {};
    const pages = await db.prepare('SELECT page_number, ocr_text FROM ocr_results WHERE record_id = ? ORDER BY page_number').all(record.id);
    const resumePages = getAnyResumeMedisPageNumbers(pages);
    const penilaian=await konteksAi.untukRecord(db,record,async()=>{
    let tinjauan = await tinjauDiagnosis(record, ai, pages, resumePages, {
      db, dikenal: { nama: record.nama_pasien, nomor_kartu: record.nokartu, nik: record.nik, no_rm: record.mrn, sep: record.sep },
    });
    const lanjutan = await tinjauLanjutan(record, { ...ai, tinjauan_diagnosis: tinjauan }, pages, resumePages, null, {
      db, dikenal: { nama: record.nama_pasien, nomor_kartu: record.nokartu, nik: record.nik, no_rm: record.mrn, sep: record.sep },
      paksaSol: req.body?.paksa_sol === true,
    });
    tinjauan = lanjutan.tinjauan || { ...tinjauan, pemeriksaan_lanjutan: lanjutan.metadata };
    return tinjauan;
    });
    const risiko = perbaruiRisikoTampilan(record);
    res.json({ ...susunSaranKoding(record, { ...ai, tinjauan_diagnosis: penilaian }, hitungInacbgDanTarif), kesiapan_koding: risiko.kesiapan_koding });
  } catch (_) {
    res.status(500).json({ error: 'Tinjauan diagnosis belum dapat disusun. Coba lagi.' });
  }
});

router.post('/records/:recordId/reread', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare('SELECT * FROM claim_records WHERE id = ?').get(req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Record tidak ditemukan.' });

    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(record.file_id);
    if (!file) return res.status(404).json({ error: 'Berkas tidak ditemukan.' });
    if (!file.file_path || !fs.existsSync(file.file_path)) {
      return res.status(400).json({ error: 'Berkas PDF asli tidak ditemukan di server, tidak bisa dibaca ulang.' });
    }

    const result = await reprocessExistingRecord(db, {
      fileId: file.id,
      recordId: record.id,
      filePath: file.file_path,
      jenisKlaim: file.jenis_klaim || record.jenis_klaim || 'RAWAT_INAP',
      hospitalCode: file.hospital_code,
    });

    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('[reread] route error:', err);
    res.status(500).json({ error: 'Terjadi gangguan server saat membaca ulang.' });
  }
});

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
// Naik dari 100 ke 300 (26 Aug 2026, permintaan klien: minimal bisa upload
// 300 file sekaligus). Estimasi durasi ~90 menit untuk 300 file (konsisten
// dengan hasil testing 50 file = ~15,5 menit dgn BATCH_AI_CONCURRENCY=20) —
// server requestTimeout, timeout fetch FE, dan nginx proxy_*_timeout semua
// sudah dinaikkan mengikuti (lihat index.js, lib/api.ts, nginx
// sites-available/medaudit) supaya batch besar tidak keputusan di tengah.
// Progress per-file tetap real-time lewat socket.io (pdf-batch:file-done)
// yang independen dari request HTTP utama & timeout-nya sendiri.
const MAX_BATCH_PDF_FILES = 300;
// Concurrency pemrosesan file dalam 1 batch (naik dari 5 → 15): hampir semua
// waktu per file adalah menunggu respons provider AI eksternal (gpt-5.6-luna),
// bukan kerja CPU lokal, jadi paralelisme tinggi aman & mempercepat linear.
// Prasyarat yang sudah dipenuhi: DB pool >= nilai ini (DB_POOL_MAX default 30,
// lihat database/init.js). Ubah lewat env BATCH_AI_CONCURRENCY kalau provider
// AI mulai sering rate-limit (tiap file tetap retry 3x sendiri).
const BATCH_AI_CONCURRENCY = Math.max(1, parseInt(process.env.BATCH_AI_CONCURRENCY || '15', 10));
const pdfUploadBatch = multer({
  storage,
  limits: { fileSize: 70 * 1024 * 1024 },
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
// ---------------------------------------------------------------------------
// Unggah berantrean: berkas diterima, server langsung membalas (202) dengan id
// proses, lalu pembacaan berjalan di latar belakang. Status & perkiraan waktu
// tersimpan (prosesUnggahService) sehingga refresh/pindah halaman/menutup tab
// tidak memengaruhi pembacaan; halaman cukup memantau GET /proses-unggah.
// ---------------------------------------------------------------------------
const prosesUnggah = require('../services/prosesUnggahService');
const antreanUnggah = prosesUnggah.buatAntrean(BATCH_AI_CONCURRENCY);

/**
 * Satu pekerjaan unggah di antrean. Gangguan sementara (AI/OCR timeout,
 * koneksi, error tak terduga) dicoba ulang otomatis sebelum dinyatakan gagal;
 * kesalahan yang pasti (API key belum disetel, dokumen kosong) tidak diulang.
 */
async function jalankanProsesUnggah(db, io, id, muatan) {
  if(!muatan.fileId || !muatan.recordId) {
    muatan={...muatan,fileId:muatan.fileId||uuidv4(),recordId:muatan.recordId||uuidv4()};
    await prosesUnggah.perbarui(db,id,{muatan:JSON.stringify(muatan)});
  }
  const { filePath, originalName, allowedJenisKlaim = [], userId, hospitalCode } = muatan;
  const catat = prosesUnggah.pencatat(db, id);
  let rantai = Promise.resolve();
  const onTahap = (t, info) => { rantai = rantai.then(() => catat(t, info)).catch(() => {}); if (io) io.emit('proses-unggah:update', { id, tahap: t }); return rantai; };
  let hasil;
  const JEDA_ULANG_MS = [2000];
  for (let percobaan = 0; percobaan <= JEDA_ULANG_MS.length; percobaan++) {
    try {
      if (!fs.existsSync(filePath)) {
        hasil = { success: false, error: 'Berkas unggahan tidak ditemukan lagi di server. Silakan unggah ulang.' };
        break;
      }
      hasil = await processSinglePdfUpload(db, {
        filePath, originalName,
        jenisKlaim: allowedJenisKlaim.length === 1 ? allowedJenisKlaim[0] : undefined,
        allowedJenisKlaim, userId, hospitalCode, onTahap,
        fileId:muatan.fileId,recordId:muatan.recordId,
      });
    } catch (err) {
      console.error(`[upload-antre] ${originalName} gagal:`, err && err.message);
      hasil = { success: false, dapat_diulang: true, error: 'Terjadi gangguan saat memproses berkas. Silakan coba lagi.' };
    }
    if (hasil && (hasil.success || !hasil.dapat_diulang) || percobaan === JEDA_ULANG_MS.length) break;
    console.warn(`[upload-antre] ${originalName}: percobaan ${percobaan + 1} gagal (${hasil && hasil.error}); diulang dalam ${JEDA_ULANG_MS[percobaan] / 1000} dtk.`);
    onTahap('antre', { pesan: `Mengulang otomatis (percobaan ${percobaan + 2})` });
    await new Promise(r => setTimeout(r, JEDA_ULANG_MS[percobaan]));
  }
  await rantai;
  if(!hasil?.success && hasil?.record_id && hasil?.file_id) hasil={...hasil,success:true,analysis_status:'sebagian',
    analysis_warning:'Berkas dan data klaim sudah tersimpan; satu tahap analisis belum selesai. Lihat hasil untuk meninjau penyebabnya.'};
  await prosesUnggah.selesai(db, id, hasil);
  if (io) io.emit('proses-unggah:update', { id, status: prosesUnggah.statusHasil(hasil) });
}

/**
 * Dipanggil sekali setelah server & DB siap: unggahan yang terhenti karena
 * server dimulai ulang dilanjutkan otomatis (berkas yang setengah tersimpan
 * dari percobaan sebelumnya dibersihkan dulu supaya tidak ganda).
 */
async function lanjutkanProsesTerputus(io) {
  const db = getDb();
  const daftar = await prosesUnggah.ambilUntukDilanjutkan(db);
  for (const p of daftar) {
    console.log(`[upload-antre] melanjutkan ${p.muatan.originalName} (proses ${p.id}) setelah server dimulai ulang.`);
    antreanUnggah.tambah(() => jalankanProsesUnggah(db, io, p.id,
      {...p.muatan,fileId:p.file_id||p.muatan.fileId,recordId:p.record_id||p.muatan.recordId}));
  }
  return daftar.length;
}

router.post('/upload-pdf-antre', authenticate, pdfUploadBatch.array('files', MAX_BATCH_PDF_FILES), async (req, res) => {
  let diterima = false;
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Belum ada berkas yang dipilih. Silakan pilih minimal satu berkas PDF.' });
    let allowedJenisKlaim = [];
    try {
      const parsed = req.body?.allowed_jenis_klaim ? JSON.parse(req.body.allowed_jenis_klaim) : null;
      if (Array.isArray(parsed)) allowedJenisKlaim = parsed.filter(v => JENIS_KLAIM_OPTIONS.includes(v));
    } catch { /* fallback di bawah */ }
    if (allowedJenisKlaim.length === 0 && JENIS_KLAIM_OPTIONS.includes(req.body?.jenis_klaim)) allowedJenisKlaim = [req.body.jenis_klaim];
    if (allowedJenisKlaim.length === 0) return res.status(400).json({ error: 'Pilih minimal satu kategori pelayanan yang mungkin ada di unggahan ini.' });

    const db = getDb();
    const io = req.app.get('io');
    const batchId = uuidv4();
    const userId = req.user.id; const hospitalCode = req.user.hospital_code;
    const daftarProses = await prosesUnggah.buatBatch(db, {
      batchId, hospitalCode, userId, files: req.files, allowedJenisKlaim,
    });
    diterima = true;
    for (const { id, muatan } of daftarProses) {
      antreanUnggah.tambah(() => jalankanProsesUnggah(db, io, id, muatan));
    }
    // Gangguan membaca panel progres tidak boleh menyatakan berkas yang
    // sudah diterima gagal, atau mendorong pengguna mengunggahnya lagi.
    let milikBatch = daftarProses.map(({ muatan, hospital_code, user_id, ...p }) => p);
    try {
      const status = await prosesUnggah.daftar(db, { hospitalCode, batasParalel: BATCH_AI_CONCURRENCY });
      const terkini = new Map(status.proses.filter(p => p.batch_id === batchId).map(p => [p.id, p]));
      milikBatch = milikBatch.map(p => terkini.get(p.id) || p);
    } catch (error) {
      console.warn('[upload-antre] berkas diterima, status sementara belum dapat dibaca:', error.message);
    }
    res.status(202).json({ batch_id: batchId, total_files: daftarProses.length, proses: milikBatch,
      perkiraan_selesai_detik: milikBatch.some(p => p.sisa_detik == null) ? null : Math.max(0, ...milikBatch.map(p => p.sisa_detik)) });
  } catch (error) {
    console.error('[upload-antre] gagal menerima berkas:', error);
    res.status(503).json({ error: 'Antrean belum dapat disimpan. Berkas belum diterima; silakan coba lagi.' });
  } finally {
    if (!diterima) for (const f of req.files || []) fs.promises.unlink(f.path).catch(() => {});
  }
});

// Tutup (sembunyikan) proses yang sudah selesai/gagal dari panel progres.
router.post('/proses-unggah/tutup', authenticate, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 400) : [];
    res.json({ ditutup: await prosesUnggah.tutup(getDb(), { ids, hospitalCode: req.user.hospital_code }) });
  } catch (error) {
    res.status(500).json({ error: 'Status unggahan belum dapat diperbarui.' });
  }
});

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

      // Kill-switch timeout per file — TIDAK boleh lebih pendek dari total
      // budget wajar pipeline-nya sendiri, kalau tidak setiap dokumen yang
      // sekadar "berat/lambat" (bukan benar-benar macet) ikut ditandai
      // "Gagal" di respons batch walau processSinglePdfUpload TETAP lanjut
      // di background dan BERHASIL menyimpan data (jadi file muncul benar di
      // Riwayat Upload walau UI upload sempat bilang gagal — root cause bug
      // "berhasil diproses tapi status Gagal").
      // Worst-case realistis 1 file: ekstraksi (3x percobaan @60s ~182s,
      // pdfExtractionService.js) + OCR evidence (maks 180s,
      // gatherEvidencePool di atas) + AI review utama (3x percobaan @60s
      // ~182s) + assessment paralel pendingRisk/kegawatdaruratan (~182s) +
      // fallback saran diagnosis (hard-timeout 70s, aiReviewService.js) —
      // bisa >13 menit total TANPA ada yang benar-benar hang, apalagi saat
      // BATCH_AI_CONCURRENCY tinggi menekan provider AI. Timeout lama (5
      // menit) SELALU lebih pendek dari budget itu sendiri. 20 menit jauh di
      // atas worst-case wajar, jadi sekarang murni pengaman untuk file yang
      // BENAR-BENAR macet (bug), bukan yang cuma lambat.
      const PER_FILE_TIMEOUT_MS = 20 * 60 * 1000;
      let result;
      let timedOut = false;
      const uploadPromise = processSinglePdfUpload(db, {
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
      try {
        result = await Promise.race([
          uploadPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Upload timeout: file processing took too long (> ${PER_FILE_TIMEOUT_MS / 60000} minutes)`)), PER_FILE_TIMEOUT_MS)
          )
        ]);
      } catch (err) {
        timedOut = true;
        result = {
          success: false,
          original_name: file.originalname,
          error: err.message || 'Terjadi kesalahan saat memproses file'
        };
      }
      if (timedOut) {
        // uploadPromise TIDAK bisa dibatalkan (sama seperti pola OCR di
        // runDedupedOcr) — tetap jalan di background dan BISA saja tetap
        // berhasil. Rekonsiliasi best-effort: kalau nanti sungguh berhasil,
        // catat di log server + emit event terkoreksi (dipakai kalau ada
        // listener socket real-time di masa depan) supaya kejadian "gagal
        // menurut respons HTTP tapi sebenarnya tersimpan" tidak diam-diam
        // hilang tanpa jejak.
        uploadPromise.then(realResult => {
          if (realResult.success) {
            console.warn(`[upload-pdf-batch] File "${file.originalname}" dilaporkan timeout (>${PER_FILE_TIMEOUT_MS / 60000} menit) tapi TETAP berhasil diproses di background (file_id=${realResult.file_id}). Data sudah tersimpan, lihat Riwayat Upload.`);
            if (io) {
              io.emit('pdf-batch:file-done', {
                batchId, fileName: file.originalname, success: true, error: null,
                file_id: realResult.file_id,
                jenis_klaim: realResult.jenis_klaim || null,
                jenis_klaim_detection: realResult.jenis_klaim_detection || null,
                reconciled: true,
              });
            }
          }
        }).catch(bgErr => {
          console.warn(`[upload-pdf-batch] File "${file.originalname}" gagal permanen di background setelah timeout: ${bgErr.message}`);
        });
      }
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

    // Merge ai_review data (kegawatdaruratan, inacbg, tariff, etc)
    if (record.ai_review) {
      const aiData = JSON.parse(record.ai_review);
      data.kegawatdaruratan_assessment = aiData.kegawatdaruratan_assessment;
      data.inacbg_result = aiData.inacbg_result;
      data.tariff_result = aiData.tariff_result;
      data.pending_risk_notes = aiData.pending_risk_notes;
      data.suggested_codes = aiData.suggested_codes;
      data.pagar_temuan = aiData.pagar_temuan;
      data.petunjuk_resep = aiData.petunjuk_resep;
    }

    // Hide SEP field dari response
    if (data.SEP) delete data.SEP;

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
        discharge_status, diagnosa_list, prosedur_list, dpjp_name, tarif_rs, has_bpjs_page,
        has_laporan_operasi, has_hasil_pa, ai_review
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
    // Sama seperti has_bpjs_page: bawa nilai deteksi RV-12 dari upload/baca
    // ulang terakhir, edit field manual tidak mengubah/menghitung ulang ini.
    dbRecord.has_laporan_operasi = existing.has_laporan_operasi === true;
    dbRecord.has_hasil_pa = existing.has_hasil_pa === true;
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const validationErrors = await validasiRecordDenganKamus(db, dbRecord, activeRules);
    const validationStatus = determineStatus(validationErrors);
    const review = typeof existing.ai_review === 'string' ? JSON.parse(existing.ai_review) : (existing.ai_review || {});
    review.ekstraksi_kode_asli = review.ekstraksi_kode_asli || {
      DIAGLIST: pristineData.DIAGLIST || existing.diagnosa_list || '',
      PROCLIST: pristineData.PROCLIST || existing.prosedur_list || '',
    };
    const [diagnosis, prosedur] = await Promise.all([
      periksaKode(db, [...String(dbRecord.diagnosa_list || '').split(/[;,]/).filter(Boolean),
        ...(review.code_evidence || []).filter(e => e.type === 'diagnosis').map(e => e.code)], 'diagnosis'),
      periksaKode(db, [...String(dbRecord.prosedur_list || '').split(/[;,]/).filter(Boolean),
        ...(review.code_evidence || []).filter(e => e.type === 'procedure').map(e => e.code)], 'prosedur'),
    ]);
    review.status_kamus = { diagnosis, prosedur };
    tandaiStatusKamusEvidence(review.code_evidence, { diagnosis, prosedur });
    review.kode_luar_kamus = validationErrors.filter(e => e.dictionary_status === 'not_found')
      .map(e => ({ kode: e.actual_value, jenis: e.rule_id === 'RV-05' ? 'diagnosis' : 'prosedur', status: 'kode_luar_kamus', pesan: e.error_message }));
    if (mergedData.DIAGLIST !== existing.diagnosa_list || mergedData.PROCLIST !== existing.prosedur_list) {
      review.inacbg_result = null; review.tariff_result = null;
      review.suggested_inacbg = ''; review.suggested_tarif = null;
      for (const [jenis, before, after] of [
        ['diagnosis', existing.diagnosa_list || '', mergedData.DIAGLIST || ''],
        ['prosedur', existing.prosedur_list || '', mergedData.PROCLIST || ''],
      ]) {
        if (before === after) continue;
        const change = { jenis, kode_asal: before, kode_baru: after, sumber: 'edit_manual',
          alasan: 'Perubahan kode melalui formulir edit', petugas: req.user.id, waktu: new Date().toISOString() };
        review.penggantian_kode = [...(review.penggantian_kode || []), change];
        const split = value => String(value).split(/[;,]/).map(code => code.trim().toUpperCase()).filter(Boolean);
        const oldCodes = split(before); const newCodes = split(after);
        const removed = oldCodes.filter(code => !newCodes.includes(code));
        const added = newCodes.filter(code => !oldCodes.includes(code));
        if (jenis === 'diagnosis' && removed.length === 1 && added.length === 1) {
          tandaiEvidenceDiganti(review, [{ kode_asal: removed[0], kode_baru: added[0] }]);
        }
      }
    }

    await db.transaction(async (tx) => {
      const txUpdateRecord = tx.prepare(`
        UPDATE claim_records SET
          kode_rs = ?, sep = ?, nokartu = ?, nama_pasien = ?, mrn = ?,
          birth_date = ?, gender = ?, kelas_rawat = ?, admission_date = ?, discharge_date = ?,
          discharge_status = ?, los = ?, diagnosa_list = ?, prosedur_list = ?, dpjp_name = ?,
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
        /^\d+$/.test(String(mergedData.LOS || '')) ? parseInt(mergedData.LOS) : 0,
        mergedData.DIAGLIST, mergedData.PROCLIST, mergedData.DPJP,
        /^\d+$/.test(mergedData.TARIF_RS) ? parseInt(mergedData.TARIF_RS) : null,
        validationStatus, validationErrors.length, JSON.stringify(mergedData),
        req.params.record_id
      );
      await simpanAiReview(tx, req.params.record_id, review);

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

      // Panel ringkasan file (VALID X% / PENDING Y%) baca count ini -- tanpa
      // sinkron di sini, count-nya basi begitu koder edit field lewat endpoint
      // ini (mis. klik Terapkan pada saran kode lalu Simpan), sementara badge
      // status per-record di header/daftar sudah baca validation_status yang
      // baru -- itu persis temuan K-2 (evaluasi 14 Sep 2026): tiga tempat beda
      // status utk klaim yang sama. Lihat juga recomputeFileCounts() di reread.
      await recomputeFileCounts(tx, existing.file_id);
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
    const ruleErrors = await validasiRecordDenganKamus(db, record, activeRules);
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
      WHERE cf.hospital_code = ? AND cr.admission_date LIKE ? AND cf.is_testing = FALSE AND cr.nokartu IS NOT NULL
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

/**
 * POST /api/v1/claim-files/:record_id/audit-suggestions
 * Menghasilkan rekomendasi audit koding medis ("Bukti Dulu, Tarif Menyusul")
 * berbasis kutipan verbatim dan kamus validasi ICD-10 WHO / ICD-9-CM.
 */
router.post('/:record_id/audit-suggestions', authenticate, async (req, res) => {
  try {
    const { record_id } = req.params;
    const { generateAuditSuggestions } = require('../services/auditSuggestionsService');
    const result = await generateAuditSuggestions(record_id);
    res.json(result);
  } catch (err) {
    console.error('[audit-suggestions] error:', err);
    res.status(500).json({ error: err.message || 'Gagal menghasilkan rekomendasi saran koding.' });
  }
});

module.exports = router;
module.exports.vclaimToDbFormat = vclaimToDbFormat;
// Jalur pemeliharaan lokal memakai alur baca ulang yang sama dengan endpoint.
module.exports.reprocessExistingRecord = reprocessExistingRecord;
module.exports.finalisasiAnalisisPdf = finalisasiAnalisisPdf;
module.exports.vclaimDateToISO = vclaimDateToISO;
module.exports.resolvePdfPath = resolvePdfPath;
module.exports.RESOLVED_UPLOAD_DIR = RESOLVED_UPLOAD_DIR;
module.exports.isiKodeDariSaranTervalidasi = isiKodeDariSaranTervalidasi;

module.exports.processSinglePdfUpload = processSinglePdfUpload;
module.exports.lanjutkanAnalisisTersimpan = lanjutkanAnalisisTersimpan;
module.exports.pdfUpload = pdfUpload;

module.exports.pdfUploadBatch = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => path.extname(file.originalname).toLowerCase() === ".pdf" ? cb(null, true) : cb(new Error("PDF saja")) });
module.exports.runWithConcurrencyLimit = runWithConcurrencyLimit;
module.exports.BATCH_AI_CONCURRENCY = BATCH_AI_CONCURRENCY;
module.exports.lanjutkanProsesTerputus = lanjutkanProsesTerputus;
