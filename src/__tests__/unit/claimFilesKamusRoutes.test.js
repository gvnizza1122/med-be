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
        : { id: 'rec', file_id: 'file', raw_data: '{}', diagnosa_list: 'R10.84', prosedur_list: '93.94' },
      all: async () => /validation_rules/.test(sql) ? [] : [{ id: 'rec', diagnosa_list: 'R10.84', prosedur_list: '93.94', validation_status: 'valid' }],
      run: async (...values) => { writes.push({ sql, values }); },
    }),
    transaction: async callback => callback(mockDb),
  };
});

test('edit manual menyimpan draf R10.84 (ICD-10-CM) dengan RV-05 dan status error, bukan valid', async () => {
  const response = await request(app).post('/claims/rec/update-values').send({ updates: { DIAGLIST: 'R10.84' } });
  expect(response.status).toBe(200);
  expect(response.body.validation_status).toBe('error');
  expect(response.body.validation_errors).toContainEqual(expect.objectContaining({ rule_id: 'RV-05', actual_value: 'R10.84' }));
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

test.each(['/claims/file/approve','/claims/export/siap-submit'])('analisis PDF gagal tidak lolos %s walaupun status lama valid dan kodenya sah',async url=>{
  mockDb.prepare=sql=>({get:async()=>({status:'completed',file_name:'kasus.pdf'}),
    all:async()=>[{id:'r',diagnosa_list:'J45.9',prosedur_list:'93.94',validation_status:'valid',source_file_name:'kasus.pdf',ai_review:JSON.stringify({analisis_tidak_tersedia:true})}],
    run:async(...values)=>writes.push({sql,values})});
  const response=url.endsWith('approve')?await request(app).post(url):await request(app).get(url);
  expect(response.status).toBe(409);expect(response.body.error).toMatch(/analisis berkas belum lengkap/);
  expect(writes).toEqual([]);
});

test('edit manual kode IM iDRG J45.3 tersimpan tanpa RV-05', async () => {
  const response = await request(app).post('/claims/rec/update-values').send({ updates: { DIAGLIST: 'J45.3' } });
  expect(response.status).toBe(200);
  expect(response.body.validation_errors.filter(e => e.actual_value === 'J45.3')).toEqual([]);
});

test('tarif-ganda: INA-CBG dari data klaim, iDRG belum dapat dihitung tanpa grouper, koding iDRG', async () => {
  mockDb.prepare = () => ({
    get: async () => ({
      id: 'rec', jenis_klaim: 'RAWAT_INAP', diagnosa_list: 'S73.0;J45.3', prosedur_list: '89.52',
      raw_data: JSON.stringify({ INACBG: 'M-1-04-I', DESKRIPSI_INACBG: 'PROSEDUR SENDI', TARIF_INACBG: '31713400', TOTAL_TARIF: '31713400' }),
      ai_review: JSON.stringify({ inacbg_result: { code: 'M-1-04-I' }, tariff_result: { amount: 31713400 } }),
    }),
  });
  const r = await request(app).get('/claims/records/rec/tarif-ganda');
  expect(r.status).toBe(200);
  expect(r.body.inacbg.resmi).toMatchObject({ sumber: 'data_klaim', kode: 'M-1-04-I', tarif: 31713400 });
  expect(r.body.inacbg.cocok).toBe(false); // hasil lama tidak menjadi dasar perhitungan dari diagnosis/prosedur saat ini
  expect(r.body.idrg).toMatchObject({ status: 'belum_dapat_dihitung', tarif: null });
  expect(r.body.idrg.nbr).toMatchObject({ nilai: null, jenis: 'rawat_inap', status: 'tidak_tersedia' });
  const dx = Object.fromEntries(r.body.koding_idrg.diagnosis.map(d => [d.kode, d]));
  expect(dx['S73.0'].status).toBe('perlu_verifikasi');
  expect(dx['S73.0'].kandidat).toEqual([]);
  expect(dx['J45.3']).toMatchObject({ status: 'im', kode_idrg: 'J45.3' });
});
