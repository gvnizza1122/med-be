/**
 * Worker thread untuk render 1 halaman PDF -> PNG via mupdf (dipakai
 * ocrService.js). Lihat workerThreadPool.js untuk alasan kenapa ini harus
 * jalan di thread terpisah — render pixmap resolusi tinggi CPU-berat & sinkron,
 * sama seperti classifyPdfPages (pdfClassifyWorker.js).
 *
 * ENHANCEMENT (18 Sep 2026): Increase default scale factor dari 3.0 (~216 DPI)
 * ke 4.0 (~288 DPI) untuk better OCR detail readability, khususnya vital signs
 * dan clinical notation. Trade-off: ~1.8x memory per page (scale^2), tapi CPU
 * masih manageable dengan worker pool.
 *
 * Buka dokumen dari AWAL tiap panggilan (bukan reuse across pages) — sengaja
 * sederhana: worker task terisolasi per-halaman, tidak perlu koordinasi
 * "dokumen mana yang sedang terbuka di worker mana". Overhead re-open per
 * halaman jauh lebih murah dibanding cost render pixmap-nya sendiri.
 */
const { parentPort } = require('worker_threads');

// Default scale factor untuk OCR — ditingkatkan untuk better detail
// 3.0 = ~216 DPI (original)
// 4.0 = ~288 DPI (enhancement, balanced)
// 5.0 = ~360 DPI (high-detail, untuk mode khusus)
const DEFAULT_SCALE = 4.0;
const HIGH_DETAIL_SCALE = 5.0;

async function renderPage(bufferData, pageNum, scaleOverride = null) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(bufferData, 'application/pdf');
  try {
    const page = doc.loadPage(pageNum - 1); // mupdf 0-indexed

    // Use scale override jika ada (untuk pass khusus), otherwise default
    const scale = scaleOverride || DEFAULT_SCALE;
    const matrix = mupdf.Matrix.scale(scale, scale);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    return Buffer.from(pixmap.asPNG());
  } finally {
    doc.destroy?.();
  }
}

parentPort.on('message', async ({ taskId, payload }) => {
  try {
    // Support scale override untuk high-detail OCR pass (lihat ocrEnhancement.js)
    const scaleOverride = payload.scaleOverride || null;
    const pngBuffer = await renderPage(payload.bufferData, payload.pageNum, scaleOverride);
    parentPort.postMessage({ taskId, result: pngBuffer });
  } catch (error) {
    parentPort.postMessage({ taskId, error: error.message || String(error) });
  }
});

// Export untuk testing
module.exports = { renderPage, DEFAULT_SCALE, HIGH_DETAIL_SCALE };
