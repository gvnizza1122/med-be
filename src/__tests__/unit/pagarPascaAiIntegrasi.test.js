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

  test('SUMIDAH: A Diagnosa kolik abdomen setelah bagian pemeriksaan fisik lolos ke DIAGLIST', async () => {
    const resume = [{
      page_number: 2,
      ocr_text: 'Anamnesis: nyeri ulu hati\nO Pemeriksaan Fisik: abdomen supel\nA Diagnosa kolik abdomen',
      confidence: 100,
    }];
    mockAi({ suggested_codes: [{
      code: 'R10.4', type: 'diagnosis', page_number: 2,
      quotation: 'A Diagnosa kolik abdomen', reasoning: 'Diagnosis tertulis di resume.',
    }] });

    const hasil = await generateAiReview(REKAM, [], resume);
    const saran = hasil.suggested_codes.find(s => s.code === 'R10.4');
    expect(saran).toMatchObject({ kamus_valid: true, peran: 'diagnosis' });
    expect(hasil.pagar_temuan.ditolak.some(d => d.kode === 'R10.4'
      && d.alasan === 'hanya_riwayat_anamnesis_bukan_diagnosis')).toBe(false);

    const db = dbPalsu();
    await isiKodeDariSaranTervalidasi(db, 'sumidah-record', { DIAGLIST: '' }, hasil);
    expect(db.tulis.find(t => /SET diagnosa_list/.test(t.sql)).a[0]).toBe('R10.4');
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

  // Ditemukan pada SEP 0170R0110826V003045 (SUMIDAH): kartu klaim menampilkan
  // "VALID" tapi ringkasan "Hasil Validasi" di atas menampilkan "100% PENDING".
  // Sebabnya recomputeFileCounts (pengisi cache claim_files.valid_count/
  // error_count/pending_count yang dibaca ringkasan itu) dipanggil SEBELUM
  // DIAGLIST diisi otomatis, dan tidak pernah dipanggil ulang sesudahnya --
  // record sendiri sudah 'valid' tapi cache file-nya masih hitungan lama.
  test('cache hitungan claim_files dihitung ulang setelah validation_status record berubah', async () => {
    const db = dbPalsu();
    const sqlRecompute = [];
    db.prepare = (sql) => {
      if (/SELECT \* FROM claim_records WHERE id = \?/.test(sql)) {
        return { get: async () => ({ id: 'rec1', file_id: 'file-1', DIAGLIST: 'R10.4', diagnosa_list: 'R10.4' }) };
      }
      if (/SELECT \* FROM validation_rules/.test(sql)) return { all: async () => [] };
      if (/UPDATE claim_files SET valid_count/.test(sql)) {
        return { run: async (...a) => { sqlRecompute.push({ sql, a }); } };
      }
      return { run: async (...a) => { db.tulis.push({ sql, a }); }, get: async () => undefined, all: async () => [] };
    };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: '' }, {
      suggested_codes: [{ code: 'R10.4', type: 'diagnosis', kamus_valid: true }],
    });
    expect(sqlRecompute).toHaveLength(1);
    expect(sqlRecompute[0].a[3]).toBe('file-1');
  });

  /** DB tiruan yang punya STATE: validation_status/DIAGLIST bisa berubah lewat
   * UPDATE dan terbaca lagi lewat SELECT berikutnya -- perlu untuk menguji
   * urutan tulis-baca yang sesungguhnya, bukan cuma satu snapshot statis. */
  function dbBerstatus(awal) {
    const state = { ...awal };
    const recompute = [];
    return {
      state, recompute,
      prepare(sql) {
        if (/SELECT validation_status, file_id FROM claim_records/.test(sql)) {
          return { get: async () => ({ validation_status: state.validation_status, file_id: state.file_id }) };
        }
        if (/SELECT \* FROM claim_records WHERE id = \?/.test(sql)) {
          return { get: async () => ({ ...state }) };
        }
        if (/SELECT \* FROM validation_rules/.test(sql)) return { all: async () => [] };
        if (/UPDATE claim_records SET validation_status = \?/.test(sql)) {
          return { run: async (v) => { state.validation_status = v; } };
        }
        if (/UPDATE claim_files SET valid_count/.test(sql)) {
          return { run: async (...a) => { recompute.push(a); } };
        }
        return { run: async () => {}, get: async () => undefined, all: async () => [] };
      },
    };
  }

  // Kasus persis yang dikhawatirkan: casemix mengunggah ulang klaim LAMA yang
  // sudah lengkap dikoding (DIAGLIST/PROCLIST sudah terisi sejak awal, tidak
  // ada yang perlu diisi otomatis -- perubahan tetap {}). Rule engine bersih
  // (format field valid), tapi AI menilai berisiko_pending (mis. kegawatan
  // klinis). Status akhir HARUS pending, bukan diam-diam lolos.
  test('AI menaikkan status ke pending walau tidak ada kolom yang diisi otomatis', async () => {
    const db = dbBerstatus({ validation_status: 'valid', file_id: 'file-9', DIAGLIST: 'J45.9', PROCLIST: '93.94' });
    const ai = { putusan_pending: { status: 'berisiko_pending' } };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: 'J45.9', PROCLIST: '93.94' }, ai);
    expect(db.state.validation_status).toBe('pending');
    expect(db.recompute.length).toBeGreaterThanOrEqual(1);
  });

  // Alur "Baca Ulang": AI menaikkan ke pending, LALU DIAGLIST diisi otomatis
  // dan rule engine dijalankan ulang bersih -- status pending dari AI TIDAK
  // BOLEH ditimpa balik ke valid oleh hitung-ulang rule-engine-only.
  test('status pending dari AI tidak ditimpa balik ke valid oleh hitung ulang rule engine', async () => {
    const db = dbBerstatus({ validation_status: 'valid', file_id: 'file-9', DIAGLIST: '' });
    const ai = {
      putusan_pending: { status: 'berisiko_pending' },
      suggested_codes: [{ code: 'R10.4', type: 'diagnosis', kamus_valid: true }],
    };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: '' }, ai);
    expect(db.state.validation_status).toBe('pending');
  });

  test('AI tidak menurunkan status yang sudah error', async () => {
    const db = dbBerstatus({ validation_status: 'error', file_id: 'file-9', DIAGLIST: 'J45.9' });
    const ai = { putusan_pending: { status: 'berisiko_pending' } };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: 'J45.9' }, ai);
    expect(db.state.validation_status).toBe('error');
  });

  test('putusan_pending bersih tidak memaksa status jadi pending', async () => {
    const db = dbBerstatus({ validation_status: 'valid', file_id: 'file-9', DIAGLIST: 'J45.9' });
    const ai = { putusan_pending: { status: 'tidak_ditemukan_alasan' } };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: 'J45.9' }, ai);
    expect(db.state.validation_status).toBe('valid');
  });

  // Kasus SUMIDAH: INA-CBG & Tarif tampil "Pending verifikasi" terus walau
  // DIAGLIST/PROCLIST sudah valid, karena grouping di dalam generateAiReview
  // dihitung dari kode yang ada SAAT itu (masih kosong). Di sini DIAGLIST/
  // PROCLIST SUDAH lengkap sejak awal (tidak ada yang perlu diisi otomatis,
  // perubahan={}) -- kasus paling umum saat mengunggah ulang klaim lama.
  test('INA-CBG dan tarif dihitung ulang dengan kode final walau tidak ada yang diisi otomatis', async () => {
    const db = dbPalsu();
    const ai = { inacbg_result: null, tariff_result: null, suggested_codes: [] };
    await isiKodeDariSaranTervalidasi(
      db, 'rec1',
      { DIAGLIST: 'J45.9', PROCLIST: '93.94', JENIS_KLAIM: 'RAWAT_JALAN' },
      ai,
    );
    expect(ai.inacbg_result).not.toBeNull();
    // Rawat jalan memakai kode ambulatori bertarif tunggal (dulu J-4-16-II
    // rawat inap, tarifnya null karena kelas rawat kosong).
    expect(ai.inacbg_result.code).toBe('Q-5-26-0');
    expect(ai.tariff_result.amount).toBeGreaterThan(0);
    const tulisAiReview = db.tulis.filter(t => /SET ai_review/.test(t.sql));
    expect(tulisAiReview.some(t => JSON.parse(t.a[0]).inacbg_result)).toBe(true);
  });

  test('INA-CBG tidak dihitung ulang kalau sudah pernah berhasil (tidak menimpa hasil ada)', async () => {
    const db = dbPalsu();
    const hasilLama = { code: 'X-1-1-I', description: 'lama' };
    const ai = { inacbg_result: hasilLama, tariff_result: { amount: 1000 }, suggested_codes: [] };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: 'J45.9', PROCLIST: '93.94' }, ai);
    expect(ai.inacbg_result).toBe(hasilLama);
  });

  test('INA-CBG tidak dihitung kalau DIAGLIST akhir tetap kosong', async () => {
    const db = dbPalsu();
    const ai = { inacbg_result: null, suggested_codes: [] };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: '' }, ai);
    expect(ai.inacbg_result).toBeNull();
  });

  describe('proclist_kosong — prosedur tidak pernah kosong diam-diam', () => {
    test('PROCLIST tetap kosong: alasan + kandidat dari usulan_prosedur tercatat', async () => {
      const db = dbPalsu();
      const ai = {
        suggested_codes: [],
        usulan_prosedur: [
          { id: 'infus', nama: 'Pemasangan infus', kode_usulan: null, alasan: 'Kode belum pasti — tidak pernah ditebak, jadi tidak masuk daftar prosedur.', masuk_proclist: false, sumber_bukti: ['resume_medis'], halaman_bukti: [2] },
          { id: 'nebulisasi', nama: 'Nebulisasi', kode_usulan: '93.94', alasan: 'Kode ICD-9-CM masih berstatus usulan dan belum diizinkan untuk pengisian otomatis ke PROCLIST.', masuk_proclist: false, sumber_bukti: ['resume_medis'], halaman_bukti: [2] },
        ],
      };
      await isiKodeDariSaranTervalidasi(db, 'rec1', { PROCLIST: '' }, ai);
      // Kode belum pasti TIDAK PERNAH diisi ke PROCLIST walau ada kandidat.
      expect(db.tulis.find(t => /SET prosedur_list/.test(t.sql))).toBeUndefined();
      expect(ai.proclist_kosong.kandidat).toHaveLength(2);
      expect(ai.proclist_kosong.kandidat[0].nama).toBe('Pemasangan infus');
      expect(ai.proclist_kosong.kandidat[1].nama).toBe('Nebulisasi');
      expect(ai.proclist_kosong.alasan).toMatch(/2 tindakan/);
      const tulisAiReview = db.tulis.filter(t => /SET ai_review/.test(t.sql));
      expect(tulisAiReview.some(t => JSON.parse(t.a[0]).proclist_kosong)).toBe(true);
    });

    test('tidak ada tindakan terbaca sama sekali: alasan generik, kandidat kosong', async () => {
      const db = dbPalsu();
      const ai = { suggested_codes: [] };
      await isiKodeDariSaranTervalidasi(db, 'rec1', { PROCLIST: '' }, ai);
      expect(ai.proclist_kosong.kandidat).toEqual([]);
      expect(ai.proclist_kosong.alasan).toMatch(/Tidak ada tindakan/);
    });

    test('PROCLIST terisi: tidak ada proclist_kosong', async () => {
      const db = dbPalsu();
      const ai = { suggested_codes: [], usulan_prosedur: [{ nama: 'x', masuk_proclist: false, alasan: 'y' }] };
      await isiKodeDariSaranTervalidasi(db, 'rec1', { PROCLIST: '93.94' }, ai);
      expect(ai.proclist_kosong).toBeUndefined();
    });

    test('catatan proclist_kosong lama dibuang begitu PROCLIST akhirnya terisi', async () => {
      const db = dbPalsu();
      const ai = {
        proclist_kosong: { alasan: 'lama', kandidat: [] },
        suggested_codes: [],
        temuan_tindakan: [{ id: 'nebulisasi', kode_usulan: '93.94', bukti: [{ sumber: 'resume_medis' }] }],
      };
      await isiKodeDariSaranTervalidasi(db, 'rec1', { PROCLIST: '93.94' }, ai);
      expect(ai.proclist_kosong).toBeUndefined();
    });
  });

  // Sama-sama dari kasus SUMIDAH: kotak AI "DIAGLIST kosong, ... isi DIAGLIST
  // dengan kode ICD-10" tetap tampil walau DIAGLIST SUDAH terisi R10.4, karena
  // catatan itu ditulis AI sebelum pengisian otomatis dan tidak pernah
  // dibuang. field_notes memakai nama KOLOM ("diagnosa_list"), bukan "DIAGLIST".
  test('catatan AI yang basi dibuang begitu DIAGLIST terisi otomatis', async () => {
    const db = dbPalsu();
    const ai = {
      field_notes: { diagnosa_list: 'DIAGLIST kosong, isi dengan kode ICD-10 yang sesuai.' },
      suggested_codes: [{ code: 'R10.4', type: 'diagnosis', kamus_valid: true }],
    };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: '' }, ai);
    expect(ai.field_notes.diagnosa_list).toBeUndefined();
    const tulisAiReview = db.tulis.filter(t => /SET ai_review/.test(t.sql));
    expect(tulisAiReview.some(t => !JSON.parse(t.a[0]).field_notes.diagnosa_list)).toBe(true);
  });

  test('catatan AI TIDAK dibuang kalau kolomnya masih kosong (tidak ada saran valid)', async () => {
    const db = dbPalsu();
    const ai = { field_notes: { diagnosa_list: 'DIAGLIST kosong, isi dengan kode ICD-10.' }, suggested_codes: [] };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: '' }, ai);
    expect(ai.field_notes.diagnosa_list).toBe('DIAGLIST kosong, isi dengan kode ICD-10.');
  });

  test('DIAGLIST non-WHO tanpa saran AI tetap ditandai dan raw_data diperbarui', async () => {
    const db = dbPalsu();
    const record = { DIAGLIST: 'r10.84' };
    const ai = {};
    await isiKodeDariSaranTervalidasi(db, 'rec1', record, ai);
    expect(ai.kode_luar_kamus).toHaveLength(1);
    expect(ai.kode_luar_kamus[0]).toMatchObject({ kode: 'R10.84', jenis: 'diagnosis' });
    expect(ai.kode_luar_kamus[0].pesan).toMatch(/ICD-10 WHO/);
    expect(db.tulis.some(t => /SET raw_data/.test(t.sql) && JSON.parse(t.a[0]).DIAGLIST === 'R10.84')).toBe(true);
  });

  // putusanPendingService membaca jenis dan pesan dari tiap entri; entri prosedur
  // dari aiReviewService tidak boleh hilang.
  test('entri kode_luar_kamus prosedur dipertahankan, entri diagnosis basi diganti', async () => {
    const db = dbPalsu();
    const ai = { kode_luar_kamus: [
      { kode: '99.99', jenis: 'prosedur', pesan: 'x' },
      { kode: 'R10.84', jenis: 'diagnosis', pesan: 'lama' },
    ] };
    await isiKodeDariSaranTervalidasi(db, 'rec1', { DIAGLIST: 'J18.9' }, ai);
    expect(ai.kode_luar_kamus).toEqual([{ kode: '99.99', jenis: 'prosedur', pesan: 'x' }]);
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
