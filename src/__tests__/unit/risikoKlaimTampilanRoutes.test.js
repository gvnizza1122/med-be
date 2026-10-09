const express = require('express');
const request = require('supertest');
let mockDb;
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({ authenticate: (req, _res, next) => { req.user={hospital_code:'3371084'}; next(); }, authorize: () => (_req, _res, next) => next() }));
jest.mock('../../services/tinjauanDiagnosisService', () => ({ tinjauDiagnosis: jest.fn(async () => ({ versi: 1, status: 'perlu_klarifikasi', ringkasan: 'Periksa dukungan kasus.', kode_rekomendasi: [], kandidat: [], klarifikasi: [] })) }));
const router = require('../../routes/claimFiles');
const app = express();
app.use('/claims', router);
let writes;
let rec;
beforeEach(() => {
  rec = { id: 'rec', sep: 'SEP-UJI', diagnosa_list: 'J44.9;J18.9', prosedur_list: '93.94', validation_status: 'pending', raw_data: '{}', ai_review: JSON.stringify({ putusan_pending: { status: 'berisiko_pending', alasan: [{ kode: 'KD-02', keparahan: 'tinggi', sumber_pemeriksaan: 'Konsistensi antar data' }], jumlah: { total: 1 } } }) };
  writes = jest.fn();
  mockDb = { prepare: sql => ({ get: async () => /COUNT/.test(sql) ? { count: 1 } : rec, all: async () => /SELECT cr\.\*/.test(sql) ? [rec] : [], run: writes }) };
});
test('membuka daftar record menyegarkan penilaian tanpa query tulis dan tanpa mengubah status/kode asli', async () => {
  const before = JSON.stringify(rec);
  const res = await request(app).get('/claims/file/records');
  expect(res.status).toBe(200);
  expect(res.body.records[0]).toMatchObject({ diagnosa_list: 'J44.9;J18.9', prosedur_list: '93.94', validation_status: 'pending' });
  const review = JSON.parse(res.body.records[0].ai_review);
  expect(review.putusan_pending.alasan.map(a => a.kode)).toEqual(['KMB-12','RK-USIA','BA-19-M65']);
  expect(review.penjaminan.jenis).toBe('BPJS');
  expect(writes).not.toHaveBeenCalled();
  expect(JSON.stringify(rec)).toBe(before);
});
test('tab Saran AI juga membawa sign koding tanpa menulis saran ke klaim', async () => {
  const res = await request(app).get('/claims/records/rec/saran-koding');
  expect(res.status).toBe(200);
  expect(res.body.kesiapan_koding.status).toBe('berisiko_pending');
  expect(res.body.klaim_saat_ini.diagnosis).toEqual(['J44.9', 'J18.9']);
  expect(res.body.diagnosis.map(d => d.kode)).toEqual(['J44.9', 'J18.9']);
  expect(res.body.diagnosis_belum_final).toBe(true);
  expect(writes).not.toHaveBeenCalled();
});
test('pratinjau tinjauan tidak menulis record atau menghilangkan sign pending', async () => {
  const before = JSON.stringify(rec);
  const res = await request(app).post('/claims/records/rec/tinjauan-diagnosis');
  expect(res.status).toBe(200);
  expect(res.body.diagnosis_belum_final).toBe(true);
  expect(res.body.kesiapan_koding.status).toBe('berisiko_pending');
  expect(res.body.klaim_saat_ini.diagnosis).toEqual(['J44.9', 'J18.9']);
  expect(writes).not.toHaveBeenCalled();
  expect(JSON.stringify(rec)).toBe(before);
});
