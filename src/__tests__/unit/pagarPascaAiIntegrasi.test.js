/**
 * Integrasi pagar pasca-AI ke generateAiReview (fetch dan DB dimock) serta
 * regresi perilaku lama: pengisian DIAGLIST dari saran tervalidasi, kode_asal,
 * temuan_tindakan. Yang diuji di sini adalah alur kode; perilaku terhadap
 * berkas nyata hanya bisa dipastikan di server (lihat catatan serah terima).
 */

const mockKamus = { icd10_who_codes: new Set(['J18.9', 'J45.9', 'R10.4']), icd9_cm_procedures: new Set(['93.94']) };

jest.mock('../../database/init', () => ({
  getDb: () => ({
    all: async (sql, params) => {
      if (/LIKE/i.test(sql)) return []; // pemetaan WHO: tidak ada padanan
      const tabel = /icd10_who_codes/.test(sql) ? 'icd10_who_codes' : 'icd9_cm_procedures';
      return (params || []).filter(k => mockKamus[tabel].has(k)).map(code => ({ code }));
    },
    run: async () => {},
  }),
}));

const { generateAiReview } = require('../../services/aiReviewService');
const { isiKodeDariSaranTervalidasi } = require('../../routes/claimFiles');

const HALAMAN = [
  'Anamnesis: sesak napas 2 hari.',
  'Riwayat asma sejak kecil',
  'Pemeriksaan fisik: Thorax: Rh -/-',
  'Diagnosa: Pneumonia',
  'Tindakan: Nebulisasi',
].join('\n');
const POOL = [{ page_number: 1, ocr_text: HALAMAN, confidence: 100 }];

function mockAi(body) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(body) } }],
      usage: { total_tokens: 10 },
    })),
  });
}

const SAKLAR = ['PAGAR_TEMUAN_AKTIF', 'PAGAR_KUTIPAN_AKTIF', 'PAGAR_NEGASI_AKTIF', 'PAGAR_PERAN_AKTIF',
  'PAGAR_TULISAN_TANGAN_AKTIF', 'PAGAR_KAMUS_PENUNJANG_AKTIF', 'PETUNJUK_RESEP_AKTIF'];

beforeEach(() => {
  process.env.AI_PROVIDER_API_KEY = 'test-key';
  process.env.AI_MAX_ATTEMPTS = '1';
  SAKLAR.forEach(k => { delete process.env[k]; });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.AI_PROVIDER_API_KEY;
  delete process.env.AI_MAX_ATTEMPTS;
  SAKLAR.forEach(k => { delete process.env[k]; });
  jest.restoreAllMocks();
});

const REKAM = { sep: 'ABC', JENIS_KLAIM: 'RAWAT_JALAN', DIAGLIST: 'J18.9' };

describe('generateAiReview + pagar', () => {
  test('kode karangan J45.909 tanpa kutipan ditolak sebelum tampil, dan alasannya terlihat', async () => {
    mockAi({
      suggested_codes: [
        { code: 'J45.909', type: 'diagnosis', page_number: 1, quotation: '', reasoning: 'asma' },
        { code: 'J45.909', type: 'diagnosis', reasoning: 'asma' },
      ],
    });
    const r = await generateAiReview(REKAM, [], POOL);
    expect(r.suggested_codes.find(s => s.code === 'J45.909')).toBeUndefined();
    const ditolak = r.pagar_temuan.ditolak.filter(d => d.kode === 'J45.909');
    expect(ditolak).toHaveLength(2);
    expect(ditolak.every(d => d.alasan === 'kutipan_kosong' && d.tahap === 'awal')).toBe(true);
  });

  test('kutipan yang bukan dari halaman itu ditolak dan tercatat', async () => {
    mockAi({ suggested_codes: [{ code: 'J45.9', type: 'diagnosis', page_number: 1, quotation: 'Asma eksaserbasi akut', reasoning: 'x' }] });
    const r = await generateAiReview(REKAM, [], POOL);
    expect(r.suggested_codes).toEqual([]);
    expect(r.pagar_temuan.ditolak[0]).toMatchObject({ kode: 'J45.9', alasan: 'kutipan_tidak_ada_di_halaman' });
  });

  test('saran sah lolos: kamus_valid dari kamus tetap, peran diagnosis, tanpa penanda blokir', async () => {
    mockAi({ suggested_codes: [{ code: 'J18.9', type: 'diagnosis', page_number: 1, quotation: 'Pneumonia', reasoning: 'x' }] });
    const r = await generateAiReview(REKAM, [], POOL);
    expect(r.suggested_codes).toHaveLength(1);
    expect(r.suggested_codes[0]).toMatchObject({ code: 'J18.9', kamus_valid: true, peran: 'diagnosis' });
    expect(r.suggested_codes[0].boleh_isi_otomatis).toBeUndefined();
    expect(r.pagar_temuan.ringkasan.lolos).toBe(1);
  });

  test('temuan disangkal dan riwayat anamnesis: tidak menjadi diagnosis, alasan terlihat', async () => {
    mockAi({
      suggested_codes: [
        { code: 'R09.8', type: 'diagnosis', page_number: 1, quotation: 'Rh -/-', reasoning: 'x' },
        { code: 'J45.9', type: 'diagnosis', page_number: 1, quotation: 'Riwayat asma sejak kecil', reasoning: 'x' },
      ],
    });
    const r = await generateAiReview(REKAM, [], POOL);
    expect(r.suggested_codes.find(s => s.code === 'J45.9')).toBeUndefined();
    expect(r.pagar_temuan.ditolak.find(d => d.kode === 'J45.9').alasan).toBe('hanya_riwayat_anamnesis_bukan_diagnosis');
    const rh = r.suggested_codes.find(s => s.code === 'R09.8');
    expect(rh).toMatchObject({ disangkal: true, boleh_isi_otomatis: false });
    expect(r.pagar_temuan.disangkal).toHaveLength(1);
  });

  test('saklar induk mati: tidak ada pagar_temuan dan saran berperilaku seperti sebelumnya', async () => {
    process.env.PAGAR_TEMUAN_AKTIF = '0';
    mockAi({
      suggested_codes: [
        { code: 'J45.909', type: 'diagnosis', page_number: 1, quotation: '', reasoning: 'asma' },
        { code: 'J45.9', type: 'diagnosis', page_number: 1, quotation: 'Riwayat asma sejak kecil', reasoning: 'x' },
      ],
    });
    const r = await generateAiReview(REKAM, [], POOL);
    expect(r.pagar_temuan).toBeUndefined();
    expect(r.petunjuk_resep).toBeUndefined();
    expect(r.suggested_codes.map(s => s.code)).toEqual(['J45.9']); // hanya tahap lama yang bekerja
  });

  test('field lama tetap ada: temuan_tindakan, konsistensi_data, putusan_pending', async () => {
    mockAi({ suggested_codes: [] });
    const r = await generateAiReview(REKAM, [], POOL);
    expect(Array.isArray(r.temuan_tindakan)).toBe(true);
    const resume = [{
      page_number: 2,
      ocr_text: ['RESUME MEDIS IGD', 'A Diagnosa', 'PPOK,', 'Pneumonia', 'Penyebab Cedera: -', 'P',
        'Tindakan Nebulisasi Ventasal', 'Rencana Rawat jalan'].join('\n'),
      confidence: 100,
    }];
    const r2 = await generateAiReview(REKAM, [], resume);
    expect(r2.temuan_tindakan.find(t => t.id === 'nebulisasi').kode_usulan).toBe('93.94');
    expect(Array.isArray(r.konsistensi_data)).toBe(true);
    expect('putusan_pending' in r).toBe(true);
    expect(r.pagar_temuan).toBeDefined();
  });

  test('petunjuk_resep terisi hanya dari bagian terapi dan tidak menambah saran diagnosis', async () => {
    mockAi({ suggested_codes: [] });
    const pool = [{ page_number: 1, ocr_text: 'Diagnosa: Pneumonia\nTerapi:\n1. Sukralfat sirup 3dd1', confidence: 100 }];
    const r = await generateAiReview(REKAM, [], pool);
    expect(r.suggested_codes).toEqual([]);
    expect(r.petunjuk_resep.petunjuk.map(p => p.kelompok)).toContain('lambung');
    expect(r.petunjuk_resep.petunjuk.every(p => p.menambah_diagnosis === false && p.kode === null)).toBe(true);
  });
});

// ── regresi pengisian DIAGLIST (claimFiles) ─────────────────────────────────
function dbPalsu() {
  const tulis = [];
  return {
    tulis,
    all: async (_sql, params = []) => params.filter(k => ['J18.9', 'J45.9', 'R10.4'].includes(String(k).toUpperCase())).map(code => ({ code })),
    prepare: (sql) => ({
      run: async (...a) => { tulis.push({ sql, a }); },
      get: async () => undefined,
      all: async () => [],
    }),
  };
}

describe('isiKodeDariSaranTervalidasi (regresi)', () => {
  test('DIAGLIST kosong diisi dari saran kamus_valid:true', async () => {
    const db = dbPalsu();
    const ai = { suggested_codes: [
      { code: 'J18.9', type: 'diagnosis', kamus_valid: true },
      { code: 'X99', type: 'diagnosis', kamus_valid: false },
      { code: 'A00', type: 'diagnosis', kamus_valid: null },
    ] };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: '' }, ai);
    const upd = db.tulis.find(t => /UPDATE claim_records SET diagnosa_list/.test(t.sql));
    expect(upd.a[0]).toBe('J18.9');
  });

  test('kode_asal: kode ICD-10-CM di DIAGLIST diganti padanan WHO', async () => {
    const db = dbPalsu();
    const ai = { suggested_codes: [{ code: 'R10.4', type: 'diagnosis', kamus_valid: true, kode_asal: 'R10.84' }] };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: 'r10.84' }, ai);
    const upd = db.tulis.find(t => /UPDATE claim_records SET diagnosa_list/.test(t.sql));
    expect(upd.a[0]).toBe('R10.4');
  });

  test('isian koder tidak ditimpa', async () => {
    const db = dbPalsu();
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: 'J18.9' }, { suggested_codes: [{ code: 'J45.9', type: 'diagnosis', kamus_valid: true }] });
    expect(db.tulis.find(t => /SET diagnosa_list/.test(t.sql))).toBeUndefined();
  });

  test('DIAGLIST non-WHO tanpa saran AI tetap ditandai dan raw_data diperbarui', async () => {
    const db = dbPalsu();
    const record = { DIAGLIST: 'r10.84' };
    const ai = {};
    await isiKodeDariSaranTervalidasi(db, 'rec1', record, ai);
    expect(ai.kode_luar_kamus).toEqual([{ kode: 'R10.84', status: 'kode_luar_kamus' }]);
    expect(db.tulis.some(t => /SET raw_data/.test(t.sql) && JSON.parse(t.a[0]).DIAGLIST === 'R10.84')).toBe(true);
  });

  test('kode WHO dinormalisasi ke huruf besar tanpa saran AI', async () => {
    const db = dbPalsu();
    const record = { DIAGLIST: 'j18.9' };
    await isiKodeDariSaranTervalidasi(db, 'rec1', record, {});
    expect(record.DIAGLIST).toBe('J18.9');
    expect(db.tulis.some(t => /SET diagnosa_list/.test(t.sql) && t.a[0] === 'J18.9')).toBe(true);
  });

  test('saran disangkal atau saran_diagnosis (boleh_isi_otomatis:false) tidak pernah mengisi kolom', async () => {
    const db = dbPalsu();
    const ai = { suggested_codes: [
      { code: 'R09.8', type: 'diagnosis', kamus_valid: true, boleh_isi_otomatis: false, disangkal: true },
      { code: 'J45.9', type: 'diagnosis', kamus_valid: true, boleh_isi_otomatis: false, peran: 'saran_diagnosis' },
      { code: 'J18.9', type: 'diagnosis', kamus_valid: true, peran: 'diagnosis' },
    ] };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: '' }, ai);
    const upd = db.tulis.find(t => /UPDATE claim_records SET diagnosa_list/.test(t.sql));
    expect(upd.a[0]).toBe('J18.9');
  });
});
