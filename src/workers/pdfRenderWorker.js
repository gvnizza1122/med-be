/**
 * Worker thread untuk render 1 halaman PDF -> PNG via mupdf (dipakai
 * ocrService.js). Lihat workerThreadPool.js untuk alasan kenapa ini harus
 * jalan di thread terpisah — render pixmap resolusi tinggi (3x/~216 DPI)
 * CPU-berat & sinkron, sama seperti classifyPdfPages (pdfClassifyWorker.js).
 *
 * Buka dokumen dari AWAL tiap panggilan (bukan reuse across pages) — sengaja
 * sederhana: worker task terisolasi per-halaman, tidak perlu koordinasi
 * "dokumen mana yang sedang terbuka di worker mana". Overhead re-open per
 * halaman jauh lebih murah dibanding cost render pixmap-nya sendiri.
 */
const { parentPort } = require('worker_threads');

async function renderPage(bufferData, pageNum) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(bufferData, 'application/pdf');
  try {
    const page = doc.loadPage(pageNum - 1); // mupdf 0-indexed
    const matrix = mupdf.Matrix.scale(3.0, 3.0);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    return Buffer.from(pixmap.asPNG());
  } finally {
    doc.destroy?.();
  }
}

parentPort.on('message', async ({ taskId, payload }) => {
  try {
    const pngBuffer = await renderPage(payload.bufferData, payload.pageNum);
    parentPort.postMessage({ taskId, result: pngBuffer });
  } catch (error) {
    parentPort.postMessage({ taskId, error: error.message || String(error) });
  }
});
