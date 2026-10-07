/**
 * Integrasi kamusPenunjangService + bacaLabService ke generateAiReview
 * (HANDOFF.md item 4). Fetch AI dan DB dimock, sama seperti
 * pagarPascaAiIntegrasi.test.js.
 *
 * Yang diuji:
 *  - ai_review.temuan_penunjang (baru, aditif) muncul dari daftar
 *    "Pemeriksaan Penunjang" di resume, default AKTIF (KAMUS_PENUNJANG_
 *    PEMBACAAN_AKTIF belum diset = ON).
 *  - ai_review.temuan_lab (baru, aditif) SELALU dihitung dari halaman
 *    lab_results, terlepas dari SYARAT_PAKAI_BACA_LAB (yang cuma
 *    mengendalikan syaratPenunjangService, tidak disentuh di sini).
 *  - Istilah yang tidak dikenali dicatat lewat catatVarianBelumDikenali
 *    dengan klaim_id (record.id), dibuktikan lewat db.run yang dimock.
 *  - KAMUS_PENUNJANG_PEMBACAAN_AKTIF=false mematikan temuan_penunjang saja.
 *  - Field lama (temuan_tindakan, suggested_codes, putusan_pending) TIDAK
 *    berubah bentuk/isinya antara flag ON vs OFF -- perubahan ini aditif.
 */

const runSql = [];
const mockKamus = { icd10_who_codes: new Set(['J18.9']), icd9_cm_procedures: new Set(['93.94']) };

jest.mock('../../database/init', () => ({
  getDb: () => ({
    get: async () => undefined,
    all: async (sql, params) => {
      if (/LIKE/i.test(sql)) return [];
      const tabel = /icd10_who_codes/.test(sql) ? 'icd10_who_codes' : 'icd9_cm_procedures';
      if (/COUNT\(\*\)/i.test(sql)) return [{ jumlah: mockKamus[tabel].size }];
      return (params || []).filter(k => mockKamus[tabel].has(k)).map(code => ({ code }));
    },
    run: async (sql, params) => { runSql.push({ sql, params }); return {}; },
  }),
}));

const { generateAiReview } = require('../../services/aiReviewService');

function mockAi(body = { suggested_codes: [] }) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(body) } }],
      usage: { total_tokens: 10 },
    })),
  });
}

const HAL_RESUME = [
  'Resume Medis Rawat Jalan',
  'Diagnosa: Pneumonia',
  'Pemeriksaan Penunjang: DL, Ro thorax, Pemeriksaan Xyz123',
  'Tindakan: Nebulisasi',
].join('\n');

const HAL_LAB = [
  'Hasil Pemeriksaan Laboratorium',
  'Hb  9.8  g/dL',
  'WBC  12.500  /uL',
  'Kadar Aneh Sekali  5  mg/dL',
].join('\n');

const POOL = [
  { page_number: 1, ocr_text: HAL_RESUME },
  { page_number: 2, ocr_text: HAL_LAB },
];

const REKAM = { id: 777, sep: 'ABC', JENIS_KLAIM: 'RAWAT_JALAN', DIAGLIST: 'J18.9' };

const SAKLAR = ['KAMUS_PENUNJANG_PEMBACAAN_AKTIF', 'SYARAT_PAKAI_BACA_LAB',
  'PAGAR_TEMUAN_AKTIF', 'PAGAR_KUTIPAN_AKTIF', 'PAGAR_NEGASI_AKTIF', 'PAGAR_PERAN_AKTIF',
  'PAGAR_TULISAN_TANGAN_AKTIF', 'PAGAR_KAMUS_PENUNJANG_AKTIF', 'PETUNJUK_RESEP_AKTIF'];

beforeEach(() => {
  runSql.length = 0;
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

describe('generateAiReview + temuan_penunjang (default ON)', () => {
  test('ai_review.temuan_penunjang berisi istilah dikenali dari daftar Pemeriksaan Penunjang', async () => {
    mockAi();
    const r = await generateAiReview(REKAM, [], POOL);
    expect(Array.isArray(r.temuan_penunjang)).toBe(true);
    const ids = r.temuan_penunjang.map(t => t.istilah_id);
    expect(ids).toEqual(expect.arrayContaining(['darah_lengkap', 'rontgen_toraks']));
    for (const t of r.temuan_penunjang) {
      if (t.status === 'dikenali') expect(t.kode_terverifikasi).toBe(false);
    }
  });

  test('istilah tak dikenali dari daftar Pemeriksaan Penunjang dicatat lewat catatVarianBelumDikenali dengan klaim_id', async () => {
    mockAi();
    await generateAiReview(REKAM, [], POOL);
    const panggilan = runSql.filter(c => /INTO varian_belum_dikenali/.test(c.sql));
    expect(panggilan.length).toBeGreaterThan(0);
    const cocok = panggilan.find(c => c.params[0] === 'pemeriksaan xyz123');
    expect(cocok).toBeDefined();
    expect(cocok.params[1]).toBe('777');
  });

  test('KAMUS_PENUNJANG_PEMBACAAN_AKTIF=false mematikan temuan_penunjang (tanpa memindai)', async () => {
    process.env.KAMUS_PENUNJANG_PEMBACAAN_AKTIF = 'false';
    mockAi();
    const r = await generateAiReview(REKAM, [], POOL);
    expect(r.temuan_penunjang).toEqual([]);
  });
});

describe('generateAiReview + temuan_lab dan evaluasi syarat lab (aktif default)', () => {
  test('baris tanpa satuan ditahan untuk cek manual; temuan tetap tersimpan dan flag false mempertahankan jalur lama', async () => {
    const record = { ...REKAM, hospital_code: '3371084', DIAGLIST: 'D63.8', PROCLIST: '90.59' };
    const pool = [
      { page_number: 1, ocr_text: 'Resume Medis' },
      { page_number: 2, ocr_text: 'Hemoglobin: 7,2 mg' },
    ];
    mockAi();
    const r = await generateAiReview(record, [], pool);
    expect(process.env.SYARAT_PAKAI_BACA_LAB).toBeUndefined();
    expect(r.temuan_lab).toBeDefined();
    expect(r.syarat_penunjang[0].syarat[0].status).toBe('perlu_cek_manual');
    expect(r.temuan_lab.baris[0].dapat_dipakai_memutuskan_syarat).toBe(false);

    process.env.SYARAT_PAKAI_BACA_LAB = 'false';
    mockAi();
    const rOff = await generateAiReview(record, [], pool);
    expect(rOff.temuan_lab).toEqual(r.temuan_lab);
    expect(rOff.syarat_penunjang[0].syarat[0].status).toBe('terpenuhi');
  });

  test('parameter lab tak dikenali ("Kadar Aneh Sekali") ikut dicatat ke varian_belum_dikenali', async () => {
    mockAi();
    await generateAiReview(REKAM, [], POOL);
    const panggilan = runSql.filter(c => /INTO varian_belum_dikenali/.test(c.sql));
    const cocok = panggilan.find(c => c.params[0] === 'kadar aneh sekali');
    expect(cocok).toBeDefined();
  });
});

describe('regresi: field lama tidak berubah bentuk/isi ketika fitur baru ON vs OFF', () => {
  test('temuan_tindakan, suggested_codes, putusan_pending identik antara KAMUS_PENUNJANG_PEMBACAAN_AKTIF ON dan OFF', async () => {
    mockAi({
      suggested_codes: [{ code: 'J18.9', type: 'diagnosis', page_number: 1, quotation: 'Pneumonia', reasoning: 'x' }],
    });
    const rOn = await generateAiReview(REKAM, [], POOL);

    process.env.KAMUS_PENUNJANG_PEMBACAAN_AKTIF = 'false';
    mockAi({
      suggested_codes: [{ code: 'J18.9', type: 'diagnosis', page_number: 1, quotation: 'Pneumonia', reasoning: 'x' }],
    });
    const rOff = await generateAiReview(REKAM, [], POOL);

    expect(rOff.temuan_tindakan).toEqual(rOn.temuan_tindakan);
    expect(rOff.suggested_codes).toEqual(rOn.suggested_codes);
    expect(rOff.putusan_pending).toEqual(rOn.putusan_pending);
    expect(rOff.syarat_penunjang).toEqual(rOn.syarat_penunjang);

    // Aditif: hanya temuan_penunjang yang beda antara ON/OFF.
    expect(rOn.temuan_penunjang.length).toBeGreaterThan(0);
    expect(rOff.temuan_penunjang).toEqual([]);
    // temuan_lab TIDAK digerbang oleh saklar ini -- tetap sama di kedua run.
    expect(rOff.temuan_lab).toEqual(rOn.temuan_lab);
  });

  test('generateAiReview tidak melempar error walau DB gagal saat mencatat varian belum dikenali', async () => {
    jest.resetModules();
    jest.doMock('../../database/init', () => ({
      getDb: () => ({
        all: async () => [],
        run: async () => { throw new Error('DB belum siap'); },
      }),
    }));
    const { generateAiReview: generateAiReviewGagalDb } = require('../../services/aiReviewService');
    mockAi();
    await expect(generateAiReviewGagalDb(REKAM, [], POOL)).resolves.not.toBeNull();
    jest.dontMock('../../database/init');
    jest.resetModules();
  });
});
