const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { panggilChatCompletions } = require('../../services/gatewayModelService');
const cache = require('../../services/cachePembacaanPdfService');
test('jawaban AI lambat ditunggu utuh walau timeout lama sangat kecil', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"selesai":true}' } }], usage: { total_tokens: 20 } }));
    }, 75));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const hasil = await panggilChatCompletions({ apiKey: 'test', baseUrl: `http://127.0.0.1:${server.address().port}`,
      timeoutMs: 5, model: 'test', prompt: 'contoh', json: true });
    expect(hasil.content).toBe('{"selesai":true}');
    expect(hasil.usage.total_tokens).toBe(20);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('OCR tersimpan hanya digunakan untuk sumber yang sama dan pembacaan lengkap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-baca-'));
  const file = path.join(dir, 'anonim.pdf');
  const hasil = { success: true, totalPages: 2, pages: [{ page_num: 1 }, { page_num: 2 }],
    ocr_enhancement: { pass1_general_ocr: { pages: [1, 2].map(n => ({ page_number: n, text: `Bukti halaman ${n}` })) } } };
  try {
    await fs.writeFile(file, 'sumber awal');
    expect(await cache.simpan(file, hasil)).toBe(true);
    expect(await cache.ambil(file)).toEqual(hasil);
    expect(await cache.simpan(file, { ...hasil, totalPages: 3 })).toBe(false);
    await fs.writeFile(file, 'sumber sudah berbeda');
    expect(await cache.ambil(file)).toBeNull();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('semua halaman tetap dibaca walau waktu virtual sudah lewat 30 menit', async () => {
  const { execFileSync } = require('child_process');
  const script = `
    const assert = require('assert/strict');
    process.env.OCR_ENGINE = 'tesseract';
    let clock = 0;
    Date.now = () => { clock += 30*60*1000; return clock; };
    require.cache[require.resolve('tesseract.js')] = { exports: {
      OEM: { LSTM_ONLY: 1 }, createWorker: async () => ({ recognize: async () => ({data:{text:'Bukti lengkap',confidence:98,blocks:[]}}), terminate:async()=>{} })
    }};
    require.cache[require.resolve('../../services/workerThreadPool')] = { exports: { createWorkerPool: () => ({ run: async payload => { assert(payload.filePath); assert(!payload.bufferData); return Buffer.from([1]); }, shutdown:async()=>{} }) }};
    const classification = { success: true, pages: [1,2,3].map(n=>({page_num:n,type:'SCAN',text_full:''})), totalPages:3 };
    (async()=>{
      const service=require('../../services/ocrService');
      const result=await service.ocrPdfPages('../../../docs/referensi/pnpk-pneumonia-anak-idai.pdf',[1,2,3],undefined,{classification,timeoutMs:1});
      assert.equal(result.success,true); assert.deepEqual(result.pages.map(p=>p.page_number),[1,2,3]); assert.equal(result.skipped_pages.length,0);
      await service.shutdownOcrPool(); console.log('lulus');
    })().catch(e=>{console.error(e);process.exit(1)});
  `;
  const out = execFileSync(process.execPath, ['-e', script], { cwd: __dirname, encoding: 'utf8' });
  expect(out).toContain('lulus');
});
