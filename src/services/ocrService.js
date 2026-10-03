/**
 * OCR Service — Extract text from scanned PDF pages
 *
 * Uses tesseract.js (WASM-based OCR, works on Windows without admin)
 * Supports Indonesian language (ind) for medical documents
 *
 * NOTE: Requires tesseract.js to be installed:
 * npm install tesseract.js
 */

let Tesseract;
try {
  Tesseract = require('tesseract.js');
} catch (err) {
  console.warn('[OCR] tesseract.js not installed. OCR features disabled.');
  console.warn('[OCR] To enable, run: npm install tesseract.js');
  Tesseract = null;
}

const fs = require('fs');
const path = require('path');

// OCR Configuration
const OCR_CONFIG = {
  // eng+ind (bukan cuma ind): banyak dokumen medis RS campur istilah Inggris
  // (label alat EKG/lab seperti "RATE", "QRS", "Electrocardiogram", dst) di
  // tengah teks Indonesia — model bahasa Indonesia-saja sering gagal baca
  // istilah itu, bikin confidence rendah/hasil kacau di halaman seperti
  // strip EKG.
  language: 'eng+ind',
  confidence_threshold: 50, // Minimum confidence to mark as 'readable' (percent)
  timeout_ms: 60000, // 60s per page max
  log_performance: true
};

// Data bahasa (eng/ind .traineddata, varian LSTM best_int) disimpan di repo
// pada eclaim-pro-be/tessdata/ supaya OCR jalan offline setelah clone.
// Tanpa opsi ini tesseract.js mengunduh dari CDN jsdelivr saat worker pertama
// dibuat dan menyimpannya di process.cwd() — gagal kalau offline, dan
// mengunduh ulang kalau server dijalankan dari folder lain. Path absolut
// (bukan relatif cwd) supaya tidak bergantung dari mana `npm start` dipanggil.
const TESSDATA_DIR = path.join(__dirname, '..', '..', 'tessdata');
const TESSERACT_WORKER_OPTIONS = {
  langPath: TESSDATA_DIR,
  cachePath: TESSDATA_DIR,
  gzip: false, // file di tessdata/ sudah tidak terkompresi
  cacheMethod: 'readOnly' // jangan pernah menulis/mengunduh ulang ke tessdata/
};

// ===== OCR Phase 1: Critical page prioritization & timeout reduction =====
// (19 Sep 2026, client approved) Total budget SATU pemanggilan ocrPdfPages()
// buat memproses SEMUA halaman target, turun jadi 3 menit — dipakai dua
// tempat: (1) di sini, sebagai penanda kapan halaman NON-CRITICAL mulai
// di-skip (lihat prioritizePagesForOcr() & loop di ocrPdfPages di bawah);
// (2) di ocrIntegration.js sebagai batas keras Promise.race pembungkus
// seluruh enhancement pass. Keduanya SENGAJA pakai env var yang sama supaya
// tidak pernah lebih longgar dari batas keras eksternalnya — kalau beda,
// budget internal yang lebih longgar jadi percuma karena Promise.race di
// luar sudah keburu membuang SELURUH hasil (termasuk halaman critical yang
// sudah selesai) sebelum budget internal sempat berhenti sendiri.
const ENHANCEMENT_TIMEOUT_MS = parseInt(process.env.OCR_ENHANCEMENT_TIMEOUT || '180000', 10);
// Berhenti mulai halaman NON-CRITICAL 5 detik sebelum budget benar-benar
// habis — jaga-jaga durasi render+OCR halaman yang lagi berjalan (bukan
// yang mau dimulai) tidak bikin overshoot jauh dari ENHANCEMENT_TIMEOUT_MS.
// Halaman CRITICAL (TRIAGE IGD/RESUME MEDIS) TIDAK kena aturan ini — tetap
// diproses walau budget sudah lewat, karena itu satu-satunya sumber vital
// signs/diagnosis (lihat isCriticalPage() di pdfPageClassifier.js).
const CRITICAL_PAGE_TIMEOUT_MARGIN_MS = 5000;

// Budget OCR mengikuti jumlah halaman: berkas rawat inap bedah (ortopedi,
// bedah umum) bisa 40-80 halaman; budget tetap 180 dtk membuat halaman
// belakang (laporan operasi, hasil lab) dilewati. Minimal ENHANCEMENT_TIMEOUT_MS,
// ditambah OCR_MS_PER_HALAMAN per halaman, maksimal OCR_ANGGARAN_MAKS_MS.
// Dipakai juga oleh batas keras di ocrIntegration.js -- keduanya harus sama.
const OCR_MS_PER_HALAMAN = parseInt(process.env.OCR_MS_PER_HALAMAN || '4000', 10);
const OCR_ANGGARAN_MAKS_MS = parseInt(process.env.OCR_ANGGARAN_MAKS_MS || '600000', 10);
// Berkas lain yang sedang di-OCR berbagi antrean layanan OCR yang sama
// (batch upload), jadi waktu tunggunya ikut dihitung ke budget berkas ini.
let berkasOcrAktif = 0;
function anggaranOcrMs(jumlahHalaman, berkasBersamaan = 1) {
  const n = Math.max(0, Number(jumlahHalaman) || 0);
  const bagi = Math.max(1, Number(berkasBersamaan) || 1);
  return Math.min(OCR_ANGGARAN_MAKS_MS, Math.max(ENHANCEMENT_TIMEOUT_MS, n * OCR_MS_PER_HALAMAN * bagi));
}

/**
 * Urutkan halaman target OCR: CRITICAL (TRIAGE IGD/RESUME MEDIS) duluan,
 * baru sisanya — masing-masing grup tetap urut nomor halaman ascending.
 * Non-mutating (return array baru).
 * @param {number[]} pageNums
 * @param {Set<number>} criticalPageNums
 * @returns {number[]}
 */
function prioritizePagesForOcr(pageNums, criticalPageNums) {
  return [...pageNums].sort((a, b) => {
    const ac = criticalPageNums.has(a) ? 0 : 1;
    const bc = criticalPageNums.has(b) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return a - b;
  });
}

// ===== BUGFIX (19 Sep 2026 debug session): critical-page detection tidak
// pernah kena untuk halaman SCAN ASLI =====
// Root cause: classifyPdfPages()/isCriticalPage() (pdfPageClassifier.js,
// pdfClassifyWorker.js) menandai is_critical dari TEKS NATIVE hasil
// pdf-parse — teks itu diambil SEBELUM OCR jalan sama sekali. Untuk halaman
// yang BENAR-BENAR hasil scan kertas (foto formulir TRIAGE IGD/RESUME MEDIS
// tanpa text layer tertanam — persis definisi kenapa type-nya 'SCAN' dan
// masuk antrean OCR), pdf-parse mengembalikan teks nyaris kosong (<50 char,
// lihat SCAN_CHAR_THRESHOLD), jadi regex CRITICAL_PAGE_MARKERS TIDAK PERNAH
// match. Akibatnya criticalPageNums selalu kosong utk dokumen full-scan,
// prioritizePagesForOcr() jadi no-op (semua halaman "non-critical" & urut
// nomor halaman apa adanya), dan skip logic di loop utama membuang halaman
// berdasarkan nomor urut -- BUKAN berdasarkan isinya -- begitu deadline
// mepet. Ini persis penyebab "vital_signs_found: 0" walau 7-8 halaman sudah
// diproses.
//
// Fix: sebelum loop OCR utama, jalankan pre-scan CEPAT beresolusi RENDAH
// (QUICK_SCAN_SCALE, jauh di bawah DEFAULT_SCALE render worker) khusus utk
// mendeteksi CRITICAL_PAGE_MARKERS lewat OCR SUNGGUHAN (bukan pdf-parse) --
// cukup buat baca judul besar halaman ("TRIAGE IGD"/"RESUME MEDIS"), TIDAK
// perlu detail vital signs (itu tetap tugas pass utama beresolusi tinggi).
// Dibatasi budget kecil (QUICK_SCAN_BUDGET_MS, diambil dari total budget
// SUPAYA tidak pernah lebih longgar dari ENHANCEMENT_TIMEOUT_MS) -- begitu
// budget pre-scan habis, sisa halaman diasumsikan non-critical (fallback ke
// perilaku lama, bukan fatal) supaya pre-scan sendiri tidak menghabiskan
// seluruh 180s.
const QUICK_SCAN_SCALE = 1.5; // ~108 DPI -- cukup baca judul besar, jauh lebih murah dari DEFAULT_SCALE (4.0) di pdfRenderWorker.js
// Diambil dari ENHANCEMENT_TIMEOUT_MS (bukan konstanta lepas) supaya kalau
// OCR_ENHANCEMENT_TIMEOUT diubah, budget quick-scan ikut menyesuaikan --
// dibatasi maksimal 30s supaya pre-scan sendiri tidak memakan seluruh budget
// pada dokumen dengan banyak halaman scan.
const QUICK_SCAN_BUDGET_MS = Math.min(30000, Math.floor(ENHANCEMENT_TIMEOUT_MS * 0.2));

/**
 * Pre-scan cepat (resolusi rendah) untuk deteksi halaman CRITICAL
 * (TRIAGE IGD/RESUME MEDIS) di antara halaman yang BELUM ketahuan critical
 * dari teks native (biasanya karena halaman itu scan murni tanpa text
 * layer). Non-fatal per halaman -- error di satu halaman tidak menghentikan
 * pre-scan halaman lain.
 * @param {Buffer} buf - buffer PDF utuh
 * @param {number[]} pageNums - halaman yang mau di-quick-scan
 * @param {string} language
 * @param {number} deadline - epoch ms, batas keras TOTAL budget ocrPdfPages()
 * @returns {Promise<Set<number>>} halaman yang terdeteksi critical lewat quick-scan
 */
async function quickScanCriticalPages(buf, pageNums, language, deadline) {
  const found = new Set();
  if (pageNums.length === 0) return found;

  const { isCriticalPage } = require('./pdfPageClassifier');
  const subDeadline = Math.min(deadline, Date.now() + QUICK_SCAN_BUDGET_MS);
  console.log(`[OCR][Phase1] Quick-scan critical-page dimulai: ${pageNums.length} halaman kandidat, budget ${QUICK_SCAN_BUDGET_MS}ms`);

  for (const pageNum of pageNums) {
    if (Date.now() >= subDeadline) {
      const remaining = pageNums.slice(pageNums.indexOf(pageNum));
      console.log(`[OCR][Phase1] Quick-scan budget habis -- halaman berikut diasumsikan non-critical (fallback): ${remaining.join(',')}`);
      break;
    }
    try {
      const pngBuffer = await getRenderPool().run({ bufferData: buf, pageNum, scaleOverride: QUICK_SCAN_SCALE });
      const quick = await ocrSingleFile(pngBuffer, language);
      if (isCriticalPage(quick.text)) {
        found.add(pageNum);
        console.log(`[OCR][Phase1] Quick-scan: halaman ${pageNum} terdeteksi CRITICAL`);
      }
    } catch (err) {
      console.warn(`[OCR][Phase1] Quick-scan gagal utk halaman ${pageNum} (non-fatal, lanjut):`, err.message || err);
    }
  }

  return found;
}

// Render halaman PDF->PNG via mupdf (dulu doc.loadPage/toPixmap/asPNG inline
// di sini, resolusi 3x/~216 DPI) itu sendiri CPU-berat & SINKRON — sempat
// "dibatasi" pakai semaphore Promise (OCR_JOB_CONCURRENCY), TAPI TERBUKTI
// TIDAK CUKUP di testing production 26 Aug 2026 (dibuktikan lewat
// classifyPdfPages yang punya masalah identik — lihat catatan panjang di
// pdfPageClassifier.js): semaphore Promise cuma mengatur giliran di thread
// utama yang sama, TIDAK memindahkan kerja sinkronnya, jadi event-loop tetap
// terblokir sepanjang durasi render walau "concurrency" dibatasi kecil.
// Solusi yang benar: render di worker_threads (thread OS terpisah) lewat
// workerThreadPool.js — lihat src/workers/pdfRenderWorker.js.
const { createWorkerPool } = require('./workerThreadPool');
const RENDER_POOL_SIZE = Math.max(1, parseInt(process.env.PDF_RENDER_WORKER_POOL_SIZE || '3', 10));
let renderPool = null;
function getRenderPool() {
  if (!renderPool) {
    renderPool = createWorkerPool(path.join(__dirname, '..', 'workers', 'pdfRenderWorker.js'), RENDER_POOL_SIZE);
  }
  return renderPool;
}
async function shutdownRenderPool() {
  if (renderPool) {
    await renderPool.shutdown();
    renderPool = null;
  }
}

// Worker pool tesseract.js — SEBELUMNYA setiap ocrSingleFile() memanggil
// Tesseract.recognize() (API one-shot) yang bikin worker WASM baru dari nol
// TIAP KALI dipanggil (spin-up engine + load bahasa eng+ind), padahal ini
// dipanggil per HALAMAN scan, dikalikan sampai beberapa dokumen paralel saat
// batch upload — pemborosan CPU/memori besar dan penyebab utama CPU meroket
// (>1000%) serta proses jadi sangat lambat saat testing production (lihat
// item 10). Solusi: buat sejumlah kecil worker PERSISTEN sekali (lazy-init),
// pakai ulang terus lewat checkout/checkin sederhana.
//
// Ukuran pool = 5, BUKAN 2 (percobaan pertama) — dites langsung di production:
// dengan pool 2 tapi record diproses dengan concurrency 5 (lihat
// runWithConcurrencyLimit(records, 5, ...) di claimFiles.js), 3 dari 5 record
// harus ANTRE dapat worker, dan waktu antre itu ikut kehitung ke batas waktu
// 120 detik gatherEvidencePool() — hasilnya SEMUA 5 record tetap kena "OCR
// timeout" walau CPU jauh lebih rendah dari sebelumnya. Pool 5 menyamakan
// jumlah worker dengan concurrency record supaya tidak ada yang perlu antre.
const POOL_SIZE = 5;
let workerPoolPromise = null; // Promise<{worker, busy}[]>
const waiters = [];

async function getWorkerPool() {
  if (!workerPoolPromise) {
    workerPoolPromise = (async () => {
      const { createWorker } = Tesseract;
      const workers = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        const worker = await createWorker(OCR_CONFIG.language, Tesseract.OEM.LSTM_ONLY, TESSERACT_WORKER_OPTIONS);
        workers.push({ worker, busy: false });
      }
        // Disimpan di properti promise supaya hitungWorkerOcrBebas() bisa
        // membacanya tanpa await.
        workerPoolPromise.pool = workers;
      return workers;
    })();
  }
  return workerPoolPromise;
}

async function checkoutWorker() {
  const pool = await getWorkerPool();
  const free = pool.find(w => !w.busy);
  if (free) {
    free.busy = true;
    return free;
  }
  // Semua worker sedang dipakai — antre sampai salah satu dilepas (checkin).
  return new Promise((resolve) => waiters.push(resolve));
}

// Jumlah worker OCR yang BEBAS saat ini. Dipakai pekerja paralel di
// ocrPdfPages() untuk menahan diri: mereka hanya mengambil worker yang
// memang menganggur, TIDAK pernah antre. Saat batch upload (5 record
// jalan bersamaan, satu worker per record) hasilnya 0, jadi tiap record
// otomatis kembali berjalan serial -- persis perilaku lama, dan jatah
// record lain tidak terserobot.
function hitungWorkerOcrBebas() {
  // Pool belum pernah dibuat = belum ada yang memakainya = semua bebas.
  // Kalau ini dikembalikan 0, upload pertama setelah restart akan selalu
  // berjalan serial padahal justru saat itu server paling lengang.
  if (!workerPoolPromise) return POOL_SIZE;
  const pool = workerPoolPromise.pool;
  if (!Array.isArray(pool)) return 0;
  return pool.filter(w => !w.busy).length;
}

function checkinWorker(entry) {
  const nextWaiter = waiters.shift();
  if (nextWaiter) {
    // Langsung dioper ke yang antre, tetap busy (tidak perlu toggle false lalu true).
    nextWaiter(entry);
  } else {
    entry.busy = false;
  }
}

/** Terminate semua worker — dipanggil saat proses backend shutdown. */
async function shutdownOcrPool() {
  if (!workerPoolPromise) return;
  const pool = await workerPoolPromise;
  workerPoolPromise = null;
  await Promise.all(pool.map(w => w.worker.terminate().catch(() => {})));
}
process.on('SIGTERM', () => { shutdownOcrPool(); shutdownRenderPool(); });
process.on('SIGINT', () => { shutdownOcrPool(); shutdownRenderPool(); });

/**
 * OCR a single PDF or image file
 * @param {string|Buffer} input - File path or Buffer
 * @param {string} language - Language code ('ind', 'eng+ind', etc.) — diabaikan
 *   kalau beda dari OCR_CONFIG.language karena worker pool sudah di-load
 *   dengan bahasa tetap saat startup; parameter dipertahankan demi kompatibilitas
 *   signature lama.
 * @returns {Promise<OCRResult>}
 */
// Model PaddleOCR (PP-OCRv5) dipakai bila OCR_ENGINE=paddle, lewat layanan
// HTTP di PADDLE_OCR_URL: ocr_rapid (ocr-rapid/app.py, RapidOCR/ONNX,
// ~1,5-2 dtk/halaman, default) atau ocr_paddle lama (ocr-paddle/app.py,
// runtime Paddle, 10-16 dtk/halaman) -- API keduanya sama. Pada uji berkas
// EIFFELIN keyakinannya ~98-99% vs Tesseract 56-85%, dan tabel tanda vital
// terbaca utuh ("33 KG ... 163 Kali 32 Kali 36.2") yang di Tesseract rusak
// ("3k6", "163kKali"). Gagal/timeout -> jatuh ke Tesseract untuk halaman itu,
// upload tidak pernah gagal karena layanan OCR mati.
const PADDLE_OCR_URL = process.env.PADDLE_OCR_URL || 'http://ocr_rapid:8866';
const PADDLE_OCR_TIMEOUT_MS = Number(process.env.PADDLE_OCR_TIMEOUT_MS || 60000);

function pakaiPaddle() {
  return (process.env.OCR_ENGINE || 'tesseract').toLowerCase() === 'paddle';
}

// Antrean global permintaan ke layanan OCR: banyak record (batch rawat inap)
// tidak menumpuk puluhan permintaan sekaligus ke satu layanan -- dilayani
// berurutan (FIFO) sebanyak OCR_PADDLE_PARALEL sekaligus.
const OCR_PADDLE_PARALEL = Math.max(1, parseInt(process.env.OCR_PADDLE_PARALEL || '4', 10));
const PERKIRAAN_MS_HALAMAN_PADDLE = 2000;
let paddleAktif = 0;
const antreanPaddle = [];
async function denganSlotPaddle(fn) {
  if (paddleAktif >= OCR_PADDLE_PARALEL) await new Promise(r => antreanPaddle.push(r));
  else paddleAktif++;
  try {
    return await fn();
  } finally {
    const berikut = antreanPaddle.shift();
    if (berikut) berikut(); else paddleAktif--;
  }
}

async function ocrDenganPaddle(input) {
  return denganSlotPaddle(() => ocrDenganPaddleLangsung(input));
}

async function ocrDenganPaddleLangsung(input) {
  const startTime = Date.now();
  // Alur upload mengirim PNG hasil render mupdf sebagai Uint8Array (bukan
  // Buffer); hanya string yang berarti path file.
  const body = typeof input === 'string' ? fs.readFileSync(input) : Buffer.from(input);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PADDLE_OCR_TIMEOUT_MS);
  try {
    const res = await fetch(`${PADDLE_OCR_URL}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const lines = Array.isArray(data.lines) ? data.lines : [];
    return {
      success: true,
      engine: 'paddle',
      text: data.text || '',
      confidence: Math.round(Number(data.confidence || 0) * 100) / 100,
      block_count: lines.length,
      duration_ms: Date.now() - startTime,
      blocks: lines.map(l => ({
        text: l.text,
        confidence: l.confidence,
        bounds: Array.isArray(l.bbox) ? { x0: l.bbox[0], y0: l.bbox[1], x1: l.bbox[2], y1: l.bbox[3] } : {},
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function ocrSingleFile(input, language = OCR_CONFIG.language) {
  if (pakaiPaddle()) {
    try {
      return await ocrDenganPaddle(input);
    } catch (err) {
      const msg = err.name === 'AbortError' ? `timeout ${PADDLE_OCR_TIMEOUT_MS}ms` : err.message;
      console.warn(`[OCR] Layanan OCR PaddleOCR (${PADDLE_OCR_URL}) gagal (${msg}) -- halaman ini dibaca Tesseract.`);
    }
  }

  if (!Tesseract) {
    throw new Error('[OCR] tesseract.js not available. Install with: npm install tesseract.js');
  }

  const startTime = Date.now();
  const entry = await checkoutWorker();

  try {
    const result = await entry.worker.recognize(input);

    const duration = Date.now() - startTime;

    return {
      success: true,
      text: result.data.text || '',
      confidence: Math.round(result.data.confidence * 100) / 100, // percentage
      block_count: result.data.blocks?.length || 0,
      duration_ms: duration,
      blocks: (result.data.blocks || []).map(block => ({
        text: block.text,
        confidence: Math.round(block.confidence * 100) / 100,
        bounds: block.bbox || {}
      }))
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    throw {
      success: false,
      error: err.message,
      duration_ms: duration
    };
  } finally {
    checkinWorker(entry);
  }
}

/**
 * OCR specific pages from a PDF.
 *
 * RISET TERVERIFIKASI (21 Jul 2026): tesseract.js TIDAK bisa baca PDF langsung
 * ("Error in pixReadStream: Pdf reading is not supported" — dites langsung ke
 * 5 PDF sample). Solusi: render tiap halaman ke PNG pakai `mupdf` (WASM murni,
 * tanpa native binary/compile — beda dengan `canvas`/`pdf-img-convert` yang
 * butuh node-gyp dan gagal compile di mesin ini), baru PNG-nya di-OCR.
 * `mupdf` adalah paket ESM — WAJIB pakai `await import('mupdf')`, `require()`
 * akan gagal (ERR_REQUIRE_ASYNC_MODULE), sama seperti kasus pdfjs-dist v4.
 *
 * @param {string} pdfPath - Path to PDF file
 * @param {number[]|string} pageNumbers - Page numbers (1-indexed) or 'all' or 'auto-scan'
 * @param {string} language - Language code
 * @param {{timeoutMs?: number}} options - timeoutMs: override budget total (ms)
 *   dipakai buat skip halaman non-critical (default ENHANCEMENT_TIMEOUT_MS,
 *   lihat catatan OCR Phase 1 di atas OCR_CONFIG).
 * @returns {Promise<{success, pages: {page_number, text, confidence, block_count, duration_ms}[], skipped_pages: {page_number, reason}[]}>}
 */
async function ocrPdfPages(pdfPath, pageNumbers = 'auto-scan', language = OCR_CONFIG.language, options = {}) {
  if (!Tesseract) {
    throw new Error('[OCR] tesseract.js not available. Install with: npm install tesseract.js');
  }

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`[OCR] File not found: ${pdfPath}`);
  }


  const result = {
    success: false,
    pdfPath,
    pages: [],
    // Halaman NON-CRITICAL yang dilewati karena budget waktu sudah mepet —
    // lihat CRITICAL_PAGE_TIMEOUT_MARGIN_MS/prioritizePagesForOcr() di atas.
    // Fase 2 (Luna fallback, BELUM diimplementasi) akan pakai daftar ini
    // buat tahu field mana yang perlu dicoba ekstraksi ulang lewat jalur lain.
    skipped_pages: [],
    errors: [],
    total_duration_ms: 0
  };

  const startTime = Date.now();
  let deadline = startTime + (options.timeoutMs || ENHANCEMENT_TIMEOUT_MS);
  let berkasDihitung = false;

  try {
    const mupdf = await import('mupdf');
    const buf = fs.readFileSync(pdfPath);
    const doc = mupdf.Document.openDocument(buf, 'application/pdf');
    const totalPages = doc.countPages();
    berkasOcrAktif++;
    berkasDihitung = true;
    deadline = startTime + (options.timeoutMs || anggaranOcrMs(totalPages, berkasOcrAktif));

    // Tentukan halaman mana yang mau di-OCR, DAN halaman mana yang CRITICAL
    // (TRIAGE IGD/RESUME MEDIS — lihat isCriticalPage() di
    // pdfPageClassifier.js). Klasifikasi dijalankan untuk SEMUA mode (bukan
    // cuma 'auto-scan') supaya prioritas critical-first tetap berlaku waktu
    // dipanggil dengan 'all' (lihat ocrEnhancement.js/pdfExtractionPipeline.js)
    // — kegagalan klasifikasi di mode 'all'/array SENGAJA tidak fatal
    // (fallback ke urutan halaman apa adanya, tanpa prioritas) karena mode
    // itu tidak WAJIB berhasil klasifikasi seperti 'auto-scan'.
    let targetPages;
    const criticalPageNums = new Set();
    // Halaman SEP yang teks native-nya SUDAH terbaca — buang dari antrean OCR
    // (isinya administratif, tidak pernah memuat vital signs). Lihat
    // isSepPage() di pdfPageClassifier.js soal kenapa syarat "native sudah
    // terbaca" WAJIB: di dokumen full-scan, OCR satu-satunya sumber nomor
    // SEP/no kartu, jadi di sana halaman SEP tetap harus diproses.
    const sepNativePages = new Set();
    // Teks halaman yang sudah terbaca tanpa OCR. Dipakai sebagai PENGGANTI
    // hasil OCR untuk halaman itu, bukan sebagai alasan membuangnya:
    // ocrEnhancement.js#extractClinicalFields() HANYA membaca ocrResult.pages,
    // jadi halaman yang tidak masuk situ hilang sama sekali dari ekstraksi
    // klinis. Diverifikasi di berkas produksi: 8 dari 32 halaman NATIVE
    // memuat kata tanda vital, jadi membuangnya berarti membuang data.
    //
    // Untuk halaman ini teks asli PDF justru LEBIH akurat daripada OCR (teks
    // sungguhan vs pengenalan gambar), sekaligus menghemat render + OCR.
    // Ambangnya sengaja tinggi: halaman ber-teks sedikit bisa jadi campuran
    // teks + tabel gambar, dan tabel itulah yang memuat tanda vital -- yang
    // begitu tetap di-OCR.
    const NATIVE_TEXT_MIN_CHARS = 500;
    // Keputusan "teks asli PDF atau OCR" dipusatkan di keputusanSumberHalamanService
    // (ambang sama: 50 / 500; tambahan: lapisan teks rusak/sampah tetap di-OCR).
    const { punyaLapisanTeksNyata } = require('./keputusanSumberHalamanService');
    const nativeTextByPage = new Map();
    if (pageNumbers === 'auto-scan') {
      // 'auto-scan' (default): pakai klasifikasi halaman yang sudah ada —
      // cuma halaman SCAN (bukan hasil ketik/NATIVE) yang perlu di-OCR.
      const { classifyPdfPages } = require('./pdfPageClassifier');
      const classified = await classifyPdfPages(buf);
      if (!classified.success) {
        throw new Error('Gagal klasifikasi halaman: ' + (classified.errors[0]?.message || 'unknown'));
      }
      targetPages = classified.pages
        .filter(p => p.type === 'SCAN' || !punyaLapisanTeksNyata(p.text_full, { mode: 'auto-scan' }))
        .map(p => p.page_num);
      classified.pages.filter(p => p.is_critical).forEach(p => criticalPageNums.add(p.page_num));
    } else {
      targetPages = Array.isArray(pageNumbers)
        ? pageNumbers
        : Array.from({ length: totalPages }, (_, i) => i + 1);
      try {
        const { classifyPdfPages, isSepPage } = require('./pdfPageClassifier');
        const classified = await classifyPdfPages(buf);
        if (classified.success) {
          classified.pages.filter(p => p.is_critical).forEach(p => criticalPageNums.add(p.page_num));
          classified.pages
            .filter(p => p.type === 'NATIVE' && !p.is_critical && isSepPage(p.text_full))
            .forEach(p => sepNativePages.add(p.page_num));
          classified.pages
            .filter(p => p.type === 'NATIVE' && punyaLapisanTeksNyata(p.text_full))
            .forEach(p => nativeTextByPage.set(p.page_num, p.text_full));
        }
      } catch (classifyErr) {
        console.warn('[OCR] Klasifikasi critical-page gagal (non-fatal, lanjut tanpa prioritas):', classifyErr.message || classifyErr);
      }
    }

    if (sepNativePages.size > 0) {
      targetPages = targetPages.filter(p => !sepNativePages.has(p));
      [...sepNativePages].forEach(p => result.skipped_pages.push({ page_number: p, reason: 'sep_page_native_text_available' }));
      console.log(`[OCR][Phase1] SKIP ${sepNativePages.size} halaman SEP (teks native sudah ada): [${[...sepNativePages].join(',')}]`);
    }

    console.log(`[OCR][Phase1] Target OCR: ${targetPages.length} halaman [${targetPages.join(',')}], critical dari teks native: ${criticalPageNums.size} [${[...criticalPageNums].join(',')}]`);

    // BUGFIX (lihat catatan panjang di atas prioritizePagesForOcr()): teks
    // native (pdf-parse) hampir selalu KOSONG untuk halaman scan murni, jadi
    // criticalPageNums di atas biasanya kosong untuk dokumen full-scan.
    // Quick-scan resolusi rendah di bawah ini pakai OCR SUNGGUHAN buat
    // menemukan TRIAGE IGD/RESUME MEDIS yang tidak lolos deteksi native —
    // hanya dijalankan kalau masih ada sisa waktu (kalau deadline sudah
    // mepet, tidak ada gunanya, main loop di bawah akan skip semua non-critical
    // lagi juga).
    const pagesNeedingQuickScan = targetPages.filter(p => !criticalPageNums.has(p));
    // Dengan RapidOCR (~1,5 dtk/halaman) semua halaman terbaca dalam budget,
    // jadi quick-scan resolusi rendah hanya membuang waktu (YETY NOVIATI 21
    // halaman: 22,7 dtk quick-scan tanpa temuan + 27 dtk OCR). Quick-scan
    // tetap dipakai bila perkiraan waktu OCR melebihi sisa budget atau mesin
    // OCR-nya Tesseract.
    const perkiraanOcrMs = pagesNeedingQuickScan.filter(p => !nativeTextByPage.has(p)).length * PERKIRAAN_MS_HALAMAN_PADDLE;
    const quickScanPerlu = !pakaiPaddle() || perkiraanOcrMs > deadline - Date.now() - CRITICAL_PAGE_TIMEOUT_MARGIN_MS;
    if (pagesNeedingQuickScan.length > 0 && !quickScanPerlu) {
      console.log(`[OCR][Phase1] Quick-scan dilewati: perkiraan OCR ${Math.round(perkiraanOcrMs / 1000)} dtk muat dalam budget.`);
    } else if (pagesNeedingQuickScan.length > 0 && Date.now() < deadline - CRITICAL_PAGE_TIMEOUT_MARGIN_MS) {
      const quickFound = await quickScanCriticalPages(buf, pagesNeedingQuickScan, language, deadline);
      quickFound.forEach(p => criticalPageNums.add(p));
      console.log(`[OCR][Phase1] Quick-scan selesai: ${quickFound.size} halaman tambahan terdeteksi critical, total critical sekarang: ${criticalPageNums.size} [${[...criticalPageNums].join(',')}]`);
    } else if (pagesNeedingQuickScan.length > 0) {
      console.log('[OCR][Phase1] Quick-scan dilewati — budget sudah mepet sebelum sempat mulai.');
    }

    // CRITICAL (TRIAGE IGD/RESUME MEDIS) duluan — lihat prioritizePagesForOcr().
    targetPages = prioritizePagesForOcr(targetPages, criticalPageNums);
    console.log(`[OCR][Phase1] Urutan OCR final (critical duluan): [${targetPages.join(',')}]`);

    // Halaman diproses paralel SEBATAS worker yang menganggur. Server ini
    // 4 core; diukur langsung di sana: 18,4 detik/halaman saat serial vs
    // 5,46 detik/halaman pada konkurensi 4 (3,4x). Di atas 4 tidak menambah
    // apa-apa (konkurensi 5: 5,50 detik) karena sudah jenuh di jumlah core.
    //
    // Pekerja ke-0 selalu jalan, jadi perilaku minimumnya sama persis dengan
    // versi serial. Pekerja tambahan berhenti begitu tidak ada worker bebas
    // -- mereka tidak pernah antre. Ini yang menjaga batch upload tetap aman:
    // saat 5 record jalan bersamaan semua worker sibuk, jadi tiap record
    // otomatis serial dan tidak ada yang kehabisan jatah lalu timeout
    // (kegagalan produksi yang dicatat di atas getWorkerPool()).
    const antreanHalaman = [...targetPages];
    const MAKS_PEKERJA_HALAMAN = 4; // = jumlah core; di atas ini tidak menambah kecepatan
    // Mesin RapidOCR tidak memakai worker Tesseract; antrean globalnya ada di
    // ocrDenganPaddle (OCR_PADDLE_PARALEL), jadi batch tetap adil antar record.
    const jumlahPekerja = pakaiPaddle()
      ? MAKS_PEKERJA_HALAMAN
      : Math.max(1, Math.min(MAKS_PEKERJA_HALAMAN, hitungWorkerOcrBebas()));
    if (jumlahPekerja > 1) {
      console.log(`[OCR][Phase1] ${jumlahPekerja} halaman diproses paralel (worker OCR menganggur: ${hitungWorkerOcrBebas()})`);
    }

    await Promise.all(Array.from({ length: jumlahPekerja }, (_, indeksPekerja) => (async () => {
      for (;;) {
        if (indeksPekerja > 0 && !pakaiPaddle() && hitungWorkerOcrBebas() === 0) return;
        const pageNum = antreanHalaman.shift();
        if (pageNum === undefined) return;
      if (pageNum < 1 || pageNum > totalPages) {
        result.errors.push({ type: 'invalid_page', message: `Halaman ${pageNum} di luar jangkauan (total ${totalPages})` });
        continue;
      }

      const msRemaining = deadline - Date.now();
      if (msRemaining <= CRITICAL_PAGE_TIMEOUT_MARGIN_MS) {
        console.log(`[OCR][Phase1] Deadline mepet (sisa ${msRemaining}ms) saat mau proses halaman ${pageNum} (critical: ${criticalPageNums.has(pageNum)})`);
      }

      // Budget hampir habis & halaman ini BUKAN critical — skip supaya
      // halaman critical yang belum sempat diproses (kalau ada) tetap
      // kebagian waktu, dan Promise.race eksternal (ocrIntegration.js) tidak
      // memaksa "buang semua hasil" begitu batas keras tercapai.
      if (!criticalPageNums.has(pageNum) && Date.now() >= deadline - CRITICAL_PAGE_TIMEOUT_MARGIN_MS) {
        console.log(`[OCR][Phase1] SKIP halaman ${pageNum} (non-critical, budget habis)`);
        result.skipped_pages.push({ page_number: pageNum, reason: 'ocr_timeout_budget_exceeded_non_critical' });
        continue;
      }

      // Teks halaman ini sudah terbaca tanpa OCR -- pakai apa adanya.
      // Bukan pelewatan: halamannya tetap masuk result.pages, jadi ekstraksi
      // klinis tetap melihatnya. Yang dihemat render + OCR-nya.
      const teksNative = nativeTextByPage.get(pageNum);
      if (teksNative) {
        result.pages.push({
          page_number: pageNum,
          text: teksNative,
          confidence: 100, // teks asli PDF, bukan hasil pengenalan gambar
          confidence_status: 'readable',
          block_count: 0,
          duration_ms: 0,
          source: 'native_text',
        });
        console.log(`[OCR][Phase1] Halaman ${pageNum} pakai teks asli PDF (${teksNative.length} char) -- render+OCR dilewati`);
        continue;
      }

      console.log(`[OCR][Phase1] Memproses halaman ${pageNum}${criticalPageNums.has(pageNum) ? ' (CRITICAL)' : ''}...`);
      const pageStart = Date.now();
      try {
        // Render (dulu inline: doc.loadPage/toPixmap/asPNG di thread utama —
        // 3.0/~216 DPI CPU-berat) sekarang di worker_threads terpisah, lihat
        // catatan panjang di atas RENDER_POOL_SIZE.
        const pngBuffer = await getRenderPool().run({ bufferData: buf, pageNum });

        const ocrResult = await ocrSingleFile(pngBuffer, language);

        result.pages.push({
          page_number: pageNum,
          text: ocrResult.text,
          confidence: ocrResult.confidence,
          confidence_status: ocrResult.confidence >= OCR_CONFIG.confidence_threshold ? 'readable' : 'unclear',
          // 'readable': confidence >= threshold (likely correct)
          // 'unclear': confidence < threshold (needs human review, often handwriting)
          block_count: ocrResult.block_count,
          duration_ms: Date.now() - pageStart
        });
      } catch (pageErr) {
        result.errors.push({
          type: 'page_ocr_error',
          page_number: pageNum,
          message: pageErr.message || String(pageErr)
        });
      }
      }
    })()));

    // Hasil dari beberapa pekerja bisa masuk tidak berurutan -- urutkan lagi
    // supaya konsumen di hilir tetap melihat halaman berurut seperti dulu.
    result.pages.sort((a, b) => a.page_number - b.page_number);
    result.skipped_pages.sort((a, b) => a.page_number - b.page_number);

    result.success = result.pages.length > 0 || targetPages.length === 0;

  } catch (err) {
    result.errors.push({
      type: 'ocr_error',
      message: err.message || String(err)
    });
  }

  if (berkasDihitung) berkasOcrAktif--;
  result.total_duration_ms = Date.now() - startTime;
  return result;
}

/**
 * OCR with retry logic
 * @param {string} filePath - File path
 * @param {number} maxAttempts - Max retry attempts
 * @param {number} backoffMs - Backoff delay between retries
 * @returns {Promise<OCRResult>}
 */
async function ocrWithRetry(filePath, maxAttempts = 3, backoffMs = 1000) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[OCR] Attempt ${attempt}/${maxAttempts}: ${path.basename(filePath)}`);
      return await ocrSingleFile(filePath);
    } catch (err) {
      lastError = err;
      console.warn(`[OCR] Attempt ${attempt} failed: ${err.message || err}`);

      if (attempt < maxAttempts) {
        console.log(`[OCR] Retrying in ${backoffMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw lastError;
}

/**
 * Batch OCR multiple files
 * @param {string[]} filePaths - Array of file paths
 * @param {string} language - Language code
 * @param {Object} options - { maxParallel, timeout, onProgress }
 * @returns {Promise<Object[]>}
 */
async function ocrBatch(filePaths, language = OCR_CONFIG.language, options = {}) {
  const {
    maxParallel = 2, // Don't overwhelm memory with too many parallel OCRs
    timeout = OCR_CONFIG.timeout_ms,
    onProgress = null
  } = options;

  const results = [];
  const queue = [...filePaths];
  const running = new Set();

  return new Promise((resolve, reject) => {
    const processNext = async () => {
      if (queue.length === 0 && running.size === 0) {
        resolve(results);
        return;
      }

      if (queue.length > 0 && running.size < maxParallel) {
        const filePath = queue.shift();
        running.add(filePath);

        try {
          const result = await ocrWithRetry(filePath);
          results.push({ filePath, ...result });

          if (onProgress) {
            onProgress({
              completed: filePaths.length - queue.length,
              total: filePaths.length
            });
          }
        } catch (err) {
          results.push({ filePath, success: false, error: err.message });
        }

        running.delete(filePath);
        setImmediate(processNext);
      }
    };

    // Start processing
    for (let i = 0; i < maxParallel && queue.length > 0; i++) {
      setImmediate(processNext);
    }
  });
}

/**
 * Health check: verify tesseract.js is available
 * @returns {boolean}
 */
function isAvailable() {
  return Tesseract !== null;
}

module.exports = {
  ocrSingleFile,
  ocrPdfPages,
  ocrWithRetry,
  ocrBatch,
  isAvailable,
  shutdownOcrPool,
  prioritizePagesForOcr,
  quickScanCriticalPages,
  OCR_CONFIG,
  ENHANCEMENT_TIMEOUT_MS,
  anggaranOcrMs,
  OCR_ANGGARAN_MAKS_MS,
  QUICK_SCAN_BUDGET_MS,
  QUICK_SCAN_SCALE
};
