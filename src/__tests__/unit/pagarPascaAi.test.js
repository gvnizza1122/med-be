/**
 * Pagar pasca-AI: post-processing saran kode dengan halaman sintetis.
 * Modul murni, tanpa DB dan tanpa AI.
 */
const {
  terapkanPagarSaran, jalankanPagarAman, bacaSaklar, ALASAN_PAGAR,
} = require('../../services/pagarPascaAiService');

const HALAMAN_RM = [
  'Anamnesis: batuk pilek 3 hari.',
  'Riwayat asma sejak kecil',
  'Pemeriksaan fisik: Thorax: Rh -/-, Wh -/-',
  'Diagnosa: Pneumonia',
  'DM tipe 2 tanpa komplikasi',
].join('\n');

const HALAMAN_RESEP = [
  'Terapi:',
  '1. Salbutamol 3dd1 pc',
  '2. Ambroxol 3dd1',
].join('\n');

const pool = (extra = []) => [
  { page_number: 1, ocr_text: HALAMAN_RM, confidence: 95 },
  ...extra,
];

const saran = (o) => ({ type: 'diagnosis', page_number: 1, reasoning: 'x', kamus_valid: true, ...o });

const ADA_SAKLAR = ['PAGAR_TEMUAN_AKTIF', 'PAGAR_KUTIPAN_AKTIF', 'PAGAR_NEGASI_AKTIF', 'PAGAR_PERAN_AKTIF',
  'PAGAR_TULISAN_TANGAN_AKTIF', 'PAGAR_KAMUS_PENUNJANG_AKTIF', 'PETUNJUK_RESEP_AKTIF', 'PAGAR_OCR_AMBANG_CEK'];
beforeEach(() => ADA_SAKLAR.forEach(k => { delete process.env[k]; }));
afterAll(() => ADA_SAKLAR.forEach(k => { delete process.env[k]; }));

describe('(a) kutipan harus ada di halaman', () => {
  test('kode karangan J45.909 tanpa kutipan ditolak, tidak lolos', () => {
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J45.909' })], evidencePool: pool() });
    expect(r.suggested_codes).toEqual([]);
    expect(r.pagar_temuan.ditolak).toHaveLength(1);
    expect(r.pagar_temuan.ditolak[0]).toMatchObject({ kode: 'J45.909', alasan: 'kutipan_kosong' });
  });

  test('kutipan yang tidak ada di halaman ditolak dengan alasan', () => {
    const r = terapkanPagarSaran({
      saran: [saran({ code: 'J45.9', quotation: 'Asma bronkial eksaserbasi akut' })], evidencePool: pool(),
    });
    expect(r.suggested_codes).toEqual([]);
    expect(r.pagar_temuan.ditolak[0].alasan).toBe('kutipan_tidak_ada_di_halaman');
  });

  test('kutipan "tidak ditemukan" dari model ditolak dengan alasan sendiri', () => {
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J18.9', quotation: 'tidak ditemukan' })], evidencePool: pool() });
    expect(r.pagar_temuan.ditolak[0].alasan).toBe('model_menjawab_tidak_ditemukan');
  });

  test('halaman yang tidak ada di berkas ditolak', () => {
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J18.9', page_number: 9, quotation: 'Pneumonia' })], evidencePool: pool() });
    expect(r.pagar_temuan.ditolak[0].alasan).toBe('halaman_tidak_ada_di_berkas');
  });

  test('kutipan valid (toleran spasi dan huruf besar) lolos dengan peran diagnosis', () => {
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J18.9', quotation: 'diagnosa:   PNEUMONIA' })], evidencePool: pool() });
    expect(r.suggested_codes).toHaveLength(1);
    expect(r.suggested_codes[0]).toMatchObject({ code: 'J18.9', peran: 'diagnosis' });
    expect(r.pagar_temuan.ditolak).toEqual([]);
  });

  test('saran yang gugur di tahap lama ikut tercatat di audit', () => {
    const r = terapkanPagarSaran({
      saran: [],
      ditolakAwal: [{ teks: 'x', kode: 'Z99', jenis: 'diagnosis', halaman: 1, alasan: 'kutipan_kosong' }],
      evidencePool: pool(),
    });
    expect(r.pagar_temuan.ditolak).toEqual([expect.objectContaining({ kode: 'Z99', tahap: 'awal' })]);
    expect(r.pagar_temuan.ringkasan.ditolak).toBe(1);
  });
});

describe('(b) tabel referensi: memakai kamus_valid, tidak menanya ulang', () => {
  test('kamus_valid:false tetap tampil tetapi tercatat perlu cek dan tidak dihapus', () => {
    const r = terapkanPagarSaran({ saran: [saran({ code: 'R10.84', quotation: 'Pneumonia', kamus_valid: false })], evidencePool: pool() });
    expect(r.suggested_codes).toHaveLength(1);
    expect(r.suggested_codes[0].kamus_valid).toBe(false);
    expect(r.pagar_temuan.perlu_cek_manusia[0].alasan).toBe('kode_tidak_ada_di_tabel_referensi');
  });

  test('kode_asal dan kamus_valid dari annotateKamusValid dibawa utuh', () => {
    const r = terapkanPagarSaran({
      saran: [saran({ code: 'R10.4', kode_asal: 'R10.84', quotation: 'Pneumonia' })], evidencePool: pool(),
    });
    expect(r.suggested_codes[0]).toMatchObject({ code: 'R10.4', kode_asal: 'R10.84', kamus_valid: true });
  });
});

describe('(c) negasi', () => {
  test('"Rh -/-" tidak dibaca positif: tetap ada, ditandai disangkal dan tidak boleh isi otomatis', () => {
    const r = terapkanPagarSaran({
      saran: [saran({ code: 'R09.8', quotation: 'Rh -/-' })], evidencePool: pool(),
    });
    expect(r.suggested_codes).toHaveLength(1);
    expect(r.suggested_codes[0]).toMatchObject({ disangkal: true, boleh_isi_otomatis: false, perlu_cek_manusia: true });
    expect(r.pagar_temuan.disangkal).toHaveLength(1);
    expect(r.pagar_temuan.disangkal[0].kode).toBe('R09.8');
  });

  test('penanda di luar kutipan (klausa sekitar) tetap terbaca', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Pemeriksaan fisik: nyeri tekan (-)\nDiagnosa: gastritis', confidence: 100 }];
    const r = terapkanPagarSaran({ saran: [saran({ code: 'R10.4', quotation: 'nyeri tekan' })], evidencePool: halaman });
    expect(r.suggested_codes[0].disangkal).toBe(true);
  });

  test('"DM tipe 2 tanpa komplikasi" bukan penyangkalan', () => {
    const r = terapkanPagarSaran({ saran: [saran({ code: 'E11.9', quotation: 'DM tipe 2 tanpa komplikasi' })], evidencePool: pool() });
    expect(r.suggested_codes[0].disangkal).toBeUndefined();
    expect(r.suggested_codes[0].boleh_isi_otomatis).toBeUndefined();
    expect(r.pagar_temuan.disangkal).toEqual([]);
  });

  test('penanda lemah di blok diagnosis ("BTA negatif") hanya ditandai, tidak diblokir', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Diagnosa: TB paru tanpa penyulit, tidak ada keluhan lain', confidence: 100 }];
    const r = terapkanPagarSaran({ saran: [saran({ code: 'A16.2', quotation: 'TB paru' })], evidencePool: halaman });
    expect(r.suggested_codes[0].disangkal).toBeUndefined();
  });

  test('saklar PAGAR_NEGASI_AKTIF=0 mematikan penandaan', () => {
    process.env.PAGAR_NEGASI_AKTIF = '0';
    process.env.PAGAR_PERAN_AKTIF = '0'; // tanpa ini peran (bagian fisik) yang menggugurkan
    const r = terapkanPagarSaran({ saran: [saran({ code: 'R09.8', quotation: 'Rh -/-' })], evidencePool: pool() });
    expect(r.suggested_codes[0].disangkal).toBeUndefined();
  });
});

describe('(d) anamnesis bukan diagnosis', () => {
  test('riwayat di anamnesis tanpa bukti terapi tidak menjadi diagnosis, tercatat ditolak', () => {
    const r = terapkanPagarSaran({
      saran: [saran({ code: 'J45.9', quotation: 'Riwayat asma sejak kecil' })], evidencePool: pool(),
    });
    expect(r.suggested_codes).toEqual([]);
    expect(r.pagar_temuan.ditolak[0]).toMatchObject({ kode: 'J45.9', alasan: ALASAN_PAGAR.RIWAYAT, bagian: 'anamnesis' });
  });

  test('anamnesis + bukti terapi (salbutamol) menjadi saran_diagnosis berlabel, tidak isi otomatis', () => {
    const r = terapkanPagarSaran({
      saran: [saran({ code: 'J45.9', quotation: 'Riwayat asma sejak kecil' })],
      evidencePool: pool([{ page_number: 2, ocr_text: HALAMAN_RESEP, confidence: 100 }]),
    });
    expect(r.suggested_codes).toHaveLength(1);
    expect(r.suggested_codes[0]).toMatchObject({ peran: 'saran_diagnosis', boleh_isi_otomatis: false });
    expect(r.suggested_codes[0].label_peran).toMatch(/Disarankan/);
  });

  test('label diagnosis di baris yang sama mengalahkan judul anamnesis', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Keluhan: sesak. Diagnosa: asma bronkial', confidence: 100 }];
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J45.9', quotation: 'asma bronkial' })], evidencePool: halaman });
    expect(r.suggested_codes[0].peran).toBe('diagnosis');
  });

  test('diagnosis banding ditolak dengan alasan', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Diagnosa: Pneumonia\nDiagnosa banding:\nTB paru', confidence: 100 }];
    const r = terapkanPagarSaran({ saran: [saran({ code: 'A16.2', quotation: 'TB paru' })], evidencePool: halaman });
    expect(r.suggested_codes).toEqual([]);
    expect(r.pagar_temuan.ditolak[0].alasan).toBe(ALASAN_PAGAR.BANDING);
  });

  test('halaman tanpa judul bagian dibiarkan (OCR sering menghilangkan judul)', () => {
    const halaman = [{ page_number: 1, ocr_text: 'pasien dengan pneumonia dirawat', confidence: 100 }];
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J18.9', quotation: 'pneumonia' })], evidencePool: halaman });
    expect(r.suggested_codes).toHaveLength(1);
    expect(r.suggested_codes[0].boleh_isi_otomatis).toBeUndefined();
  });

  test('saran prosedur dari bagian terapi tidak kena aturan peran diagnosis', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Terapi: nebulisasi ventolin', confidence: 100 }];
    const r = terapkanPagarSaran({ saran: [saran({ type: 'procedure', code: '93.94', quotation: 'nebulisasi' })], evidencePool: halaman });
    expect(r.suggested_codes).toHaveLength(1);
  });

  test('saklar PAGAR_PERAN_AKTIF=0 mematikan aturan peran', () => {
    process.env.PAGAR_PERAN_AKTIF = 'off';
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J45.9', quotation: 'Riwayat asma sejak kecil' })], evidencePool: pool() });
    expect(r.suggested_codes).toHaveLength(1);
  });
});

describe('(e) tulisan tangan / OCR tidak pasti', () => {
  test('halaman confidence rendah ditandai perlu cek manusia, tetap tampil', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Diagnosa: Pneumonia', confidence: 40 }];
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J18.9', quotation: 'Pneumonia' })], evidencePool: halaman });
    expect(r.suggested_codes[0].perlu_cek_manusia).toBe(true);
    expect(r.pagar_temuan.perlu_cek_manusia.some(p => p.alasan === ALASAN_PAGAR.TULISAN_TANGAN)).toBe(true);
    // informasi saja: tidak memblokir isi otomatis
    expect(r.suggested_codes[0].boleh_isi_otomatis).toBeUndefined();
  });

  test('penanda eksplisit sumber tulisan_tangan pada halaman dihormati', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Diagnosa: Pneumonia', confidence: 99, sumber: 'tulisan_tangan' }];
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J18.9', quotation: 'Pneumonia' })], evidencePool: halaman });
    expect(r.suggested_codes[0].perlu_cek_manusia).toBe(true);
  });

  test('halaman teks asli (confidence 100) tidak ditandai', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Diagnosa: Pneumonia', confidence: 100 }];
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J18.9', quotation: 'Pneumonia' })], evidencePool: halaman });
    expect(r.suggested_codes[0].perlu_cek_manusia).toBeUndefined();
  });
});

describe('kamus penunjang: singkatan ambigu tidak diputuskan sendiri', () => {
  test('"DC" pada saran prosedur ditandai perlu konfirmasi dengan kandidat', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Tindakan: DC', confidence: 100 }];
    const r = terapkanPagarSaran({ saran: [saran({ type: 'procedure', code: '57.94', quotation: 'Tindakan: DC' })], evidencePool: halaman });
    expect(r.suggested_codes[0].singkatan_ambigu[0].kandidat.length).toBeGreaterThan(1);
    expect(r.suggested_codes[0].perlu_cek_manusia).toBe(true);
    expect(r.suggested_codes[0].code).toBe('57.94'); // kode tidak diubah pagar
  });
});

describe('(f) resep hanya petunjuk', () => {
  test('petunjuk dari bagian terapi, tidak pernah menambah diagnosis atau kode', () => {
    const r = terapkanPagarSaran({
      saran: [],
      evidencePool: pool([{ page_number: 2, ocr_text: HALAMAN_RESEP, confidence: 100 }]),
    });
    expect(r.suggested_codes).toEqual([]); // resep tidak melahirkan saran diagnosis
    expect(r.petunjuk_resep.petunjuk.length).toBeGreaterThan(0);
    for (const p of r.petunjuk_resep.petunjuk) {
      expect(p.menambah_diagnosis).toBe(false);
      expect(p.kode).toBeNull();
    }
  });

  test('obat di anamnesis (bukan terapi) tidak dibaca sebagai resep', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Anamnesis: minum salbutamol 3dd1 sendiri', confidence: 100 }];
    const r = terapkanPagarSaran({ saran: [], evidencePool: halaman });
    expect(r.petunjuk_resep.petunjuk).toEqual([]);
  });

  test('PETUNJUK_RESEP_AKTIF=0 tidak mengisi field', () => {
    process.env.PETUNJUK_RESEP_AKTIF = '0';
    const r = terapkanPagarSaran({ saran: [], evidencePool: pool([{ page_number: 2, ocr_text: HALAMAN_RESEP, confidence: 100 }]) });
    expect(r.petunjuk_resep).toBeNull();
  });
});

describe('saklar dan kegagalan aman', () => {
  test('bawaan: semua pagar hidup', () => {
    expect(bacaSaklar()).toMatchObject({ aktif: true, kutipan: true, negasi: true, peran: true, tulisan_tangan: true, kamus_penunjang: true, petunjuk_resep: true });
  });

  test('PAGAR_KUTIPAN_AKTIF=0 mematikan pemeriksaan ulang kutipan', () => {
    process.env.PAGAR_KUTIPAN_AKTIF = 'false';
    const r = terapkanPagarSaran({ saran: [saran({ code: 'J45.909' })], evidencePool: pool() });
    expect(r.suggested_codes).toHaveLength(1);
  });

  test('saklar induk mati: jalankanPagarAman tidak mengubah apa pun', () => {
    process.env.PAGAR_TEMUAN_AKTIF = '0';
    expect(jalankanPagarAman({ saran: [saran({ code: 'X' })], evidencePool: pool() }))
      .toEqual({ suggested_codes: null, pagar_temuan: null, petunjuk_resep: null });
  });

  test('galat di tahap pagar: tidak melempar, hasil lama dipakai, galat tercatat', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const hasil = jalankanPagarAman({
      saran: [saran({ code: 'J18.9', quotation: 'Pneumonia' })],
      ditolakAwal: { bukan: 'array' }, // memicu TypeError di dalam tahap
      evidencePool: pool(),
    });
    spy.mockRestore();
    expect(hasil.suggested_codes).toBeNull(); // null = pemanggil mempertahankan hasil lama
    expect(hasil.pagar_temuan.galat).toBeTruthy();
    expect(hasil.pagar_temuan.ditolak).toEqual([]);
  });

  test('entri yang gagal diproses lolos apa adanya dengan catatan', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const aneh = saran({ code: 'J18.9', quotation: 'Pneumonia' });
    const halaman = { page_number: 1, get ocr_text() { throw new Error('boom'); } };
    const r = terapkanPagarSaran({ saran: [aneh], evidencePool: [halaman] });
    spy.mockRestore();
    expect(r.suggested_codes).toEqual([aneh]);
    expect(r.pagar_temuan.perlu_cek_manusia[0].alasan).toBe(ALASAN_PAGAR.GALAT_ENTRI);
  });
});
