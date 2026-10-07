const express = require('express');
const request = require('supertest');
let mockDb;
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'tester', role: 'admin', hospital_code: 'uji-rs' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/validasiRecordKamusService', () => ({ validasiRecordDenganKamus: async () => [] }));
jest.mock('../../services/aiReviewService', () => ({ generateAiReview: jest.fn(), hitungInacbgDanTarif: jest.fn() }));
const { generateAiReview } = require('../../services/aiReviewService');
const app = express();
app.use('/claims', require('../../routes/claimFiles'));
let writes;
beforeEach(() => {
  writes = [];
  generateAiReview.mockClear();
  mockDb = { prepare: sql => ({ get: async () => null, all: async () => [],
    run: async (...values) => { writes.push({ sql, values }); return { changes: 1 }; } }),
    transaction: async cb => cb(mockDb) };
});
function upload(content, pilihan) {
  let req = request(app).post('/claims/upload');
  if (pilihan) req = req.field('jenis_klaim', pilihan);
  return req.attach('file', Buffer.from(content), 'uji-jenis.txt');
}
test('TXT campuran disimpan sesuai PTD setiap baris, walau kelas kamar sama', async () => {
  const res = await upload('SEP\tPTD\tKELAS_RAWAT\tDIAGLIST\nUJI1\t2\t3\tJ45.9\nUJI2\t1\t3\tJ45.9', 'RAWAT_INAP');
  expect(res.status).toBe(202);
  const rows = writes.filter(w => /INSERT INTO claim_records/.test(w.sql));
  expect(rows.map(r => r.values[41])).toEqual(['RAWAT_JALAN', 'RAWAT_INAP']);
  expect(generateAiReview).not.toHaveBeenCalled();
});
test('TXT rawat jalan mengisi kategori file dan semua record dari PTD', async () => {
  const res = await upload('SEP\tPTD\tDIAGLIST\nUJI\t2\tJ45.9');
  expect(res.status).toBe(202);
  expect(writes).toContainEqual(expect.objectContaining({ sql: expect.stringMatching(/UPDATE claim_files SET jenis_klaim/), values: expect.arrayContaining(['RAWAT_JALAN']) }));
});
test.each([
  ['SEP\tPTD\tDIAGLIST\nUJI\t3\tJ45.9'],
  ['SEP\tDIAGLIST\tCOL3\nUJI\tJ45.9\tx'],
  ['SEP\tPTD\tJENIS_KLAIM\nUJI\t2\tRAWAT_INAP'],
])('jenis layanan hilang/salah/berbeda tidak diam-diam disimpan rawat inap', async content => {
  const res = await upload(content);
  expect(res.status).toBe(422);
  expect(writes.some(w => /INSERT INTO claim_records/.test(w.sql))).toBe(false);
  expect(generateAiReview).not.toHaveBeenCalled();
});
test('berkas lama tanpa PTD dapat menerima pilihan pengguna', async () => {
  const res = await upload('SEP\tDIAGLIST\tCOL3\nUJI\tJ45.9\tx', 'RAWAT_JALAN');
  expect(res.status).toBe(202);
  expect(writes.find(w => /INSERT INTO claim_records/.test(w.sql)).values[41]).toBe('RAWAT_JALAN');
});
