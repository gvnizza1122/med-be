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
  // strip EKG. eng.traineddata sudah tersedia lokal, tidak perlu download.
  language: 'eng+ind',
  confidence_threshold: 50, // Minimum confidence to mark as 'readable' (percent)
  timeout_ms: 60000, // 60s per page max
  log_performance: true
};

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
        const worker = await createWorker(OCR_CONFIG.language);
        workers.push({ worker, busy: false });
      }
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
async function ocrSingleFile(input, language = OCR_CONFIG.language) {
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
 * @returns {Promise<{success, pages: {page_number, text, confidence, block_count, duration_ms}[]}>}
 */
async function ocrPdfPages(pdfPath, pageNumbers = 'auto-scan', language = OCR_CONFIG.language) {
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
    errors: [],
    total_duration_ms: 0
  };

  const startTime = Date.now();

  try {
    const mupdf = await import('mupdf');
    const buf = fs.readFileSync(pdfPath);
    const doc = mupdf.Document.openDocument(buf, 'application/pdf');
    const totalPages = doc.countPages();

    // Tentukan halaman mana yang mau di-OCR
    let targetPages;
    if (Array.isArray(pageNumbers)) {
      targetPages = pageNumbers;
    } else if (pageNumbers === 'all') {
      targetPages = Array.from({ length: totalPages }, (_, i) => i + 1);
    } else {
      // 'auto-scan' (default): pakai klasifikasi halaman yang sudah ada —
      // cuma halaman SCAN (bukan hasil ketik/NATIVE) yang perlu di-OCR.
      const { classifyPdfPages } = require('./pdfPageClassifier');
      const classified = await classifyPdfPages(buf);
      if (!classified.success) {
        throw new Error('Gagal klasifikasi halaman: ' + (classified.errors[0]?.message || 'unknown'));
      }
      targetPages = classified.pages.filter(p => p.type === 'SCAN').map(p => p.page_num);
    }

    for (const pageNum of targetPages) {
      if (pageNum < 1 || pageNum > totalPages) {
        result.errors.push({ type: 'invalid_page', message: `Halaman ${pageNum} di luar jangkauan (total ${totalPages})` });
        continue;
      }

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

    result.success = result.pages.length > 0 || targetPages.length === 0;

  } catch (err) {
    result.errors.push({
      type: 'ocr_error',
      message: err.message || String(err)
    });
  }

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
  OCR_CONFIG
};
