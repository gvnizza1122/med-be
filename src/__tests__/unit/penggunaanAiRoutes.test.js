const express = require('express');
const request = require('supertest');
let mockDb;
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
// Pakai authorize asli agar batas admin dan pewarisan superadmin ikut diuji.
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  authenticate: (req, res, next) => {
    if (!req.headers['x-role']) return res.status(401).json({ error: 'Masuk dahulu.' });
    req.user = { role: req.headers['x-role'], hospital_code: req.headers['x-hospital'] || 'RS-A' };
    next();
  },
}));
const app = express();
app.use('/usage', require('../../routes/aiUsage'));
beforeEach(() => { mockDb = { all: jest.fn(async () => []) }; });
test.each(['admin', 'superadmin'])('%s hanya memperoleh ringkasan rumah sakit akunnya', async role => {
  const res = await request(app).get('/usage?month=2026-10&hospital_code=RS-B').set('x-role', role);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.summary.calls).toBe(0);
  expect(mockDb.all.mock.calls[0][1][0]).toBe('RS-A');
});
test.each(['supervisor', 'verifikator'])('%s tidak boleh membaca biaya operasional', async role => {
  const res = await request(app).get('/usage').set('x-role', role);
  expect(res.status).toBe(403);
  expect(mockDb.all).not.toHaveBeenCalled();
});
test('tanpa login ditolak', async () => {
  expect((await request(app).get('/usage')).status).toBe(401);
});
test('bulan tidak valid ditolak sebelum query', async () => {
  expect((await request(app).get('/usage?month=2026-13').set('x-role', 'admin')).status).toBe(400);
  expect(mockDb.all).not.toHaveBeenCalled();
});
test('DB gagal menghasilkan error, bukan angka nol yang menyesatkan', async () => {
  mockDb.all.mockRejectedValue(new Error('database offline'));
  expect((await request(app).get('/usage').set('x-role', 'admin')).status).toBe(500);
});
