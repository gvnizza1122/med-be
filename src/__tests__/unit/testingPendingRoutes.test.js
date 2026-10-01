const express = require('express');
const request = require('supertest');
let mockDb;
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  authenticate: (req, res, next) => {
    if (!req.headers['x-role']) return res.status(401).json({ error: 'Masuk dahulu' });
    req.user = { id: 'tester', role: req.headers['x-role'], hospital_code: req.headers['x-hospital'] || 'RS-A' }; next();
  },
}));
const app = express(); app.use(express.json()); app.use('/testing', require('../../routes/testingPending'));
const form = { actual_result: 'pending', reference_source: 'BPJS', reason_match: 'sesuai', actual_reason: 'Penunjang belum lengkap', notes: 'Uji' };
beforeEach(() => {
  mockDb = { get: jest.fn(async sql => sql.includes('has_table_privilege') ? { can_read: true, can_write: true } : sql.includes('COUNT') ? { total: 0 } : { id: 'rec', diagnosa_list: 'J44.9;J18.9', validation_status: 'pending' }), all: jest.fn(async () => []), run: jest.fn(async () => ({ changes: 1 })) };
});
test.each(['admin','superadmin','supervisor','verifikator'])('%s dapat membuka tab dengan scope RS akun', async role => {
  const res = await request(app).get('/testing?jenis_klaim=RAWAT_INAP&hospital_code=RS-B').set('x-role', role);
  expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.summary.BPJS.accuracy).toBeNull();
  expect(mockDb.get.mock.calls.find(c => c[0].includes('COUNT'))[1].slice(0,2)).toEqual(['RS-A','RAWAT_INAP']);
  expect(mockDb.run).not.toHaveBeenCalled();
});
test('hasil hanya ditulis ke tabel testing, prediksi dari klien diabaikan dan patokan tidak diganti saat edit', async () => {
  const res = await request(app).put('/testing/rec').set('x-role','verifikator').send({ ...form, prediction: 'tidak_pending' });
  expect(res.status).toBe(200);
  const [sql, params] = mockDb.run.mock.calls[0];
  expect(sql).toContain('INSERT INTO testing_pending');
  expect(sql).not.toMatch(/UPDATE claim_records|UPDATE claim_files/);
  expect(sql.split('DO UPDATE SET')[1]).not.toMatch(/prediction\s*=/);
  expect(params.slice(0,3)).toEqual(['rec','RS-A','pending']);
  expect(mockDb.get.mock.calls.find(c => c[0].includes('SELECT cr.*'))[1]).toEqual(['rec','RS-A']);
});
test('berkas rumah sakit lain tidak dapat diberi label', async () => {
  mockDb.get.mockImplementation(async sql => sql.includes('has_table_privilege') ? { can_read: true, can_write: true } : undefined);
  expect((await request(app).put('/testing/rec-lain').set('x-role','admin').send(form)).status).toBe(404);
  expect(mockDb.run).not.toHaveBeenCalled();
});
test('kategori dan input tidak valid ditolak', async () => {
  expect((await request(app).get('/testing?jenis_klaim=IGD').set('x-role','admin')).status).toBe(400);
  expect((await request(app).put('/testing/rec').set('x-role','admin').send({ ...form, reason_match:'ya' })).status).toBe(400);
  expect(mockDb.run).not.toHaveBeenCalled();
});
test('wajib login dan role yang berhak', async () => {
  expect((await request(app).get('/testing')).status).toBe(401);
  expect((await request(app).get('/testing').set('x-role','guest')).status).toBe(403);
});
test('BPJS dan simulasi verifikator dihitung terpisah', async () => {
  mockDb.all.mockImplementation(async sql => sql.includes('SELECT t.prediction') ? [
    { prediction:'pending',actual_result:'pending',reference_source:'BPJS',reason_match:'sesuai' },
    { prediction:'pending',actual_result:'diterima',reference_source:'VERIFIKATOR',reason_match:'belum_dinilai' },
  ] : []);
  const res = await request(app).get('/testing').set('x-role','admin');
  expect(res.body.summary.BPJS.accuracy).toBe(100);
  expect(res.body.summary.VERIFIKATOR.accuracy).toBe(0);
});
test('tanpa izin tabel baru daftar tetap bisa dibuka, tetapi penyimpanan tetap ditolak', async () => {
  mockDb.get.mockImplementation(async sql => sql.includes('has_table_privilege') ? { can_read: false, can_write: false } : { total: 0 });
  const res = await request(app).get('/testing').set('x-role','admin');
  expect(res.status).toBe(200);
  expect(res.body.testing_storage_available).toBe(false);
  expect(mockDb.all.mock.calls.every(c => !c[0].includes('JOIN testing_pending'))).toBe(true);
  expect((await request(app).put('/testing/rec').set('x-role','admin').send(form)).status).toBe(503);
  expect(mockDb.run).not.toHaveBeenCalled();
});
test('arsip disembunyikan secara default dan dapat disertakan saat dibutuhkan', async () => {
  await request(app).get('/testing').set('x-role','admin');
  expect(mockDb.all.mock.calls[0][0]).toContain('AND cf.diarsipkan_pada IS NULL');
  mockDb.all.mockClear();
  await request(app).get('/testing?include_arsip=1').set('x-role','admin');
  expect(mockDb.all.mock.calls[0][0]).not.toContain('AND cf.diarsipkan_pada IS NULL');
});
