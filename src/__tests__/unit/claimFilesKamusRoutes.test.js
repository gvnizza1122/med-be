const express = require('express');
const request = require('supertest');
let mockDb;
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'tester', email: 'uji@example.invalid', role: 'admin' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/auditService', () => ({ logAudit: jest.fn() }));
const router = require('../../routes/claimFiles');
const app = express();
app.use(express.json()); app.use('/claims', router);
let writes;
beforeEach(() => {
  writes = [];
  mockDb = {
    all: async (sql, params = []) => /COUNT/.test(sql) ? [{ jumlah: 2 }]
      : params.filter(c => ['J45.9', '93.94'].includes(c)).map(code => ({ code })),
    prepare: sql => ({
      get: async () => /claim_files/.test(sql) ? { status: 'completed' }
        : { id: 'rec', file_id: 'file', raw_data: '{}', diagnosa_list: 'J45.3', prosedur_list: '93.94' },
      all: async () => /validation_rules/.test(sql) ? [] : [{ id: 'rec', diagnosa_list: 'J45.3', prosedur_list: '93.94', validation_status: 'valid' }],
      run: async (...values) => { writes.push({ sql, values }); },
    }),
    transaction: async callback => callback(mockDb),
  };
});

test('edit manual menyimpan draf J45.3 dengan RV-05 dan status error, bukan valid', async () => {
  const response = await request(app).post('/claims/rec/update-values').send({ updates: { DIAGLIST: 'J45.3' } });
  expect(response.status).toBe(200);
  expect(response.body.validation_status).toBe('error');
  expect(response.body.validation_errors).toContainEqual(expect.objectContaining({ rule_id: 'RV-05', actual_value: 'J45.3' }));
  expect(writes.some(w => /UPDATE claim_records SET/.test(w.sql))).toBe(true);
});

test.each(['/claims/file/approve', '/claims/export/siap-submit'])('kode lama berstatus valid tidak lolos gerbang %s', async url => {
  const response = url.endsWith('approve') ? await request(app).post(url) : await request(app).get(url);
  expect(response.status).toBe(409);
  expect(writes).toEqual([]);
});

test('kamus offline menunda approval tanpa menyatakan kode pasien salah', async () => {
  mockDb.all = async () => { throw Error('offline'); };
  const response = await request(app).post('/claims/file/approve');
  expect(response.status).toBe(503);
  expect(response.body.errors.every(e => e.dictionary_status === 'unavailable')).toBe(true);
  expect(writes).toEqual([]);
});
