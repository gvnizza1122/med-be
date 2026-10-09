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
 * Satu dokumen disimpan per worker; pergantian file melepaskan dokumen lama.
 */
const { parentPort } = require('worker_threads');

// Default scale factor untuk OCR — ditingkatkan untuk better detail
// 3.0 = ~216 DPI (original)
// 4.0 = ~288 DPI (enhancement, balanced)
// 5.0 = ~360 DPI (high-detail, untuk mode khusus)
const DEFAULT_SCALE = 4.0;
const HIGH_DETAIL_SCALE = 5.0;

const fs = require('fs');
let cachedDocument = null, cachedKey = null;
async function renderPage(bufferData, pageNum, scaleOverride = null, filePath = null) {
  const mupdf = await import('mupdf');
  let doc;
  if (filePath) {
    const stat = await fs.promises.stat(filePath);
    const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    if (cachedKey !== key) {
      cachedDocument?.destroy?.(); cachedDocument = null; cachedKey = null;
      cachedDocument = mupdf.Document.openDocument(await fs.promises.readFile(filePath), 'application/pdf');
      cachedKey = key;
    }
    doc = cachedDocument;
  } else doc = mupdf.Document.openDocument(bufferData, 'application/pdf');
  let page, pixmap;
  try {
    page = doc.loadPage(pageNum - 1);
    const scale = scaleOverride || DEFAULT_SCALE;
    pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    return Buffer.from(pixmap.asPNG());
  } finally {
    pixmap?.destroy?.(); page?.destroy?.();
    if (!filePath) doc.destroy?.();
  }
}
parentPort.on('message', async ({ taskId, payload }) => {
  try {
    const png = await renderPage(payload.bufferData, payload.pageNum, payload.scaleOverride, payload.filePath);
    parentPort.postMessage({ taskId, result: png });
  } catch (error) {
    parentPort.postMessage({ taskId, error: error.message || String(error) });
  }
});

// Export untuk testing
module.exports = { renderPage, DEFAULT_SCALE, HIGH_DETAIL_SCALE };
