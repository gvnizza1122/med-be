const express = require('express');
const request = require('supertest');
let mockDb;
let mockUser;
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = mockUser; next(); },
  authorize: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/auditService', () => ({ logAudit: jest.fn() }));
const router = require('../../routes/claimFiles');
const app = express();
app.use(express.json()); app.use('/claims', router);

let panggilan;
const pakaiDb = (acuan, items = []) => {
  panggilan = [];
  mockDb = {
    prepare: sql => ({
      get: async (...p) => {
        panggilan.push({ sql, p });
        if (/FROM claim_records cr JOIN claim_files cf ON cf.id = cr.file_id WHERE cr.id = \?/.test(sql)) return acuan;
        return { semua: '3', pending: '2', valid: '1' };
      },
      all: async (...p) => { panggilan.push({ sql, p }); return items; },
    }),
  };
};
beforeEach(() => { mockUser = { id: 'u', role: 'verifikator', hospital_code: 'RS1' }; });

test('daftar memakai periode klaim acuan, pending lebih dulu, dan hitungan per status', async () => {
  pakaiDb({ id: 'r1', periode: '2026-06', hospital_code: 'RS1', is_testing: false, diarsipkan_pada: null },
    [{ record_id: 'r2', file_id: 'f2', nama_pasien: 'B', validation_status: 'pending' }]);
  const res = await request(app).get('/claims/records/r1/sebulan');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ periode: '2026-06', status: 'semua', ringkasan: { semua: 3, pending: 2, valid: 1 } });
  expect(res.body.items).toHaveLength(1);
  const daftar = panggilan.find(c => /ORDER BY CASE/.test(c.sql));
  expect(daftar.sql).toMatch(/cr\.periode = \?/);
  expect(daftar.sql).toMatch(/cf\.is_testing = FALSE/);
  expect(daftar.sql).toMatch(/cf\.diarsipkan_pada IS NULL/);
  expect(daftar.p).toEqual(['2026-06', 'RS1', 50, 0]);
});

test('filter pending mencakup status error, filter valid hanya valid', async () => {
  pakaiDb({ id: 'r1', periode: '2026-06', hospital_code: 'RS1', is_testing: false, diarsipkan_pada: null });
  await request(app).get('/claims/records/r1/sebulan?status=pending');
  expect(panggilan.find(c => /ORDER BY CASE/.test(c.sql)).sql).toMatch(/AND cr\.validation_status IN \('pending', 'error'\)\s+ORDER/);
  pakaiDb({ id: 'r1', periode: '2026-06', hospital_code: 'RS1', is_testing: false, diarsipkan_pada: null });
  await request(app).get('/claims/records/r1/sebulan?status=valid&cari=sub&page=2&limit=10');
  const daftar = panggilan.find(c => /ORDER BY CASE/.test(c.sql));
  expect(daftar.sql).toMatch(/AND cr\.validation_status = 'valid'\s+ORDER/);
  expect(daftar.p).toEqual(['2026-06', 'RS1', '%sub%', '%sub%', '%sub%', 10, 10]);
});

test('klaim tanpa periode menampilkan kelompok tanpa periode', async () => {
  pakaiDb({ id: 'r1', periode: null, hospital_code: 'RS1', is_testing: false, diarsipkan_pada: null });
  const res = await request(app).get('/claims/records/r1/sebulan');
  expect(res.body.periode).toBeNull();
  expect(panggilan.find(c => /ORDER BY CASE/.test(c.sql)).sql).toMatch(/cr\.periode IS NULL/);
});

test('klaim milik rumah sakit lain dianggap tidak ada', async () => {
  pakaiDb({ id: 'r1', periode: '2026-06', hospital_code: 'RS2', is_testing: false, diarsipkan_pada: null });
  const res = await request(app).get('/claims/records/r1/sebulan');
  expect(res.status).toBe(404);
  expect(panggilan.some(c => /ORDER BY CASE/.test(c.sql))).toBe(false);
});
