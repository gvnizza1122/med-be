const http = require('http');

// Layanan OCR tiruan dengan API yang sama dengan ocr-rapid/app.py.
let server;
let diterima;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const potongan = [];
    req.on('data', c => potongan.push(c));
    req.on('end', () => {
      diterima = Buffer.concat(potongan);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        text: 'R06.0 - Dyspnoea',
        confidence: 99.2,
        lines: [{ text: 'R06.0 - Dyspnoea', confidence: 99.2, bbox: [1, 2, 3, 4] }],
      }));
    });
  });
  await new Promise(r => server.listen(0, r));
  process.env.OCR_ENGINE = 'paddle';
  process.env.PADDLE_OCR_URL = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  delete process.env.OCR_ENGINE;
  delete process.env.PADDLE_OCR_URL;
  await new Promise(r => server.close(r));
});

describe('ocrSingleFile lewat layanan OCR PaddleOCR', () => {
  // Alur upload mengirim PNG render mupdf sebagai Uint8Array. Dulu dianggap
  // path file -> setiap halaman diam-diam jatuh ke Tesseract.
  test('input Uint8Array dikirim ke layanan, bukan dibaca sebagai path', async () => {
    jest.resetModules();
    const { ocrSingleFile } = require('../../services/ocrService');
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const r = await ocrSingleFile(png);
    expect(r.engine).toBe('paddle');
    expect(r.confidence).toBe(99.2);
    expect(r.text).toBe('R06.0 - Dyspnoea');
    expect([...diterima]).toEqual([...png]);
  });

  test('input Buffer juga dikirim apa adanya', async () => {
    jest.resetModules();
    const { ocrSingleFile } = require('../../services/ocrService');
    const r = await ocrSingleFile(Buffer.from([1, 2, 3]));
    expect(r.engine).toBe('paddle');
    expect([...diterima]).toEqual([1, 2, 3]);
  });
});
