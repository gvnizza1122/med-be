const path = require('path');
const { createWorkerPool } = require('../../services/workerThreadPool');
test('render berulang menjaga halaman terpisah dan pulih setelah nomor halaman salah', async () => {
  const pool = createWorkerPool(path.join(__dirname, '../../workers/pdfRenderWorker.js'), 1);
  const filePath = path.join(__dirname, '../../../docs/referensi/pnpk-pneumonia-anak-idai.pdf');
  try {
    const a = Buffer.from(await pool.run({ filePath, pageNum: 1, scaleOverride: 1 }));
    const b = Buffer.from(await pool.run({ filePath, pageNum: 2, scaleOverride: 1 }));
    expect(a.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect(a.equals(b)).toBe(false);
    await expect(pool.run({ filePath, pageNum: 9999, scaleOverride: 1 })).rejects.toThrow();
    const lagi = Buffer.from(await pool.run({ filePath, pageNum: 1, scaleOverride: 1 }));
    expect(lagi).toEqual(a);
  } finally { await pool.shutdown(); }
});
