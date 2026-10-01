/**
 * Tes pemilihKodeService: aturan a-g, 5 status, lapisan AI "pilih dari
 * kandidat", anti-upcoding prosedur. Sistem BARU/PARALEL — tidak menyentuh
 * pipeline hidup. cariKandidatKode & ambilAtributKode SELALU di-mock di sini
 * (interface eksternal milik agen lain / query nyata ke tabel yang belum
 * tentu ada di DB tes).
 */

const {
  ALASAN_TOLAK,
  terapkanAturanKode,
  deteksiRencana,
  normalisasiJenisKelamin,
  verifikasiKutipanDenganNfkc,
  buatPromptPilihKode,
  validasiJawabanAi,
  pilihDenganAiDariKandidat,
  prosesDaftarKode,
  ambilKodeTerdekat,
} = require('../../services/pemilihKodeService');

const HALAMAN = [
  { page_number: 1, ocr_text: 'Diagnosa: kolik abdomen, nyeri di daerah epigastrium. VAS 8.' },
  { page_number: 2, ocr_text: 'Pasien perempuan usia 45 tahun dengan hiperpireksia suhu 39.8 C.' },
  { page_number: 3, ocr_text: 'Hipertensi emergensi, TD 150/90, tidak ada tanda kerusakan organ.' },
];

function kandidatDasar(over = {}) {
  return {
    kode: 'R10.4', sistem: 'icd10', judul: 'Nyeri abdomen lainnya dan tidak spesifik', lapis: 1, skor: 1,
    ref: { ditemukan: true, punya_turunan: false, kode_gejala: true, jenis_kelamin: null, umur_min: null, umur_maks: null, asterisk: false, sebab_luar: false },
    ...over,
  };
}

describe('terapkanAturanKode — aturan a-g', () => {
  test('a: kode tidak ada di ref_kode -> ditolak', () => {
    const k = kandidatDasar({ kode: 'I16.0', ref: { ditemukan: false } });
    const { diterima, ditolak } = terapkanAturanKode([k], {});
    expect(diterima).toHaveLength(0);
    expect(ditolak[0].alasan).toBe(ALASAN_TOLAK.TIDAK_DI_REF_KODE);
  });

  test('a: kode ada di ref_kode -> lolos (tidak ditolak oleh aturan a)', () => {
    const k = kandidatDasar({ kode: 'I10', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false } });
    const { diterima } = terapkanAturanKode([k], {});
    expect(diterima.map((d) => d.kode)).toContain('I10');
  });

  test('b: punya_turunan=true (kode induk, mis. R10) -> ditolak, wajib anak lebih spesifik', () => {
    const k = kandidatDasar({ kode: 'R10', ref: { ditemukan: true, punya_turunan: true, kode_gejala: true } });
    const { diterima, ditolak } = terapkanAturanKode([k], {});
    expect(diterima).toHaveLength(0);
    expect(ditolak[0].alasan).toBe(ALASAN_TOLAK.PUNYA_TURUNAN);
  });

  test('b: punya_turunan=false (mis. I10, tidak ada subkode) -> lolos', () => {
    const k = kandidatDasar({ kode: 'I10', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false } });
    const { diterima } = terapkanAturanKode([k], {});
    expect(diterima).toHaveLength(1);
  });

  test('c: kode gejala (R50.9 demam) dibuang kalau ada diagnosis penyebab terkonfirmasi di daftar yang sama', () => {
    const k = kandidatDasar({ kode: 'R50.9', judul: 'Demam, tidak spesifik', ref: { ditemukan: true, punya_turunan: false, kode_gejala: true } });
    const { diterima, ditolak } = terapkanAturanKode([k], { adaDiagnosisPenyebabLain: true });
    expect(diterima).toHaveLength(0);
    expect(ditolak[0].alasan).toBe(ALASAN_TOLAK.GEJALA_TERGANTIKAN);
  });

  test('c: kode gejala TETAP lolos kalau tidak ada diagnosis penyebab lain di daftar', () => {
    const k = kandidatDasar({ kode: 'R50.9', ref: { ditemukan: true, punya_turunan: false, kode_gejala: true } });
    const { diterima } = terapkanAturanKode([k], { adaDiagnosisPenyebabLain: false });
    expect(diterima).toHaveLength(1);
  });

  test('d: jenis kelamin tidak cocok (kode khusus perempuan, pasien laki-laki) -> ditolak', () => {
    const k = kandidatDasar({ kode: 'O21.0', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false, jenis_kelamin: 'P' } });
    const { diterima, ditolak } = terapkanAturanKode([k], { jenisKelamin: 'L' });
    expect(diterima).toHaveLength(0);
    expect(ditolak[0].alasan).toBe(ALASAN_TOLAK.JENIS_KELAMIN_TIDAK_COCOK);
  });

  test('d: jenis kelamin cocok -> lolos', () => {
    const k = kandidatDasar({ kode: 'O21.0', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false, jenis_kelamin: 'P' } });
    const { diterima } = terapkanAturanKode([k], { jenisKelamin: 'P' });
    expect(diterima).toHaveLength(1);
  });

  test('d: umur di luar rentang umur_min/umur_maks -> ditolak', () => {
    const k = kandidatDasar({ kode: 'P07.3', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false, umur_min: 0, umur_maks: 0 } });
    const { diterima, ditolak } = terapkanAturanKode([k], { umurTahun: 45 });
    expect(diterima).toHaveLength(0);
    expect(ditolak[0].alasan).toBe(ALASAN_TOLAK.UMUR_TIDAK_COCOK);
  });

  test('d: umur di dalam rentang -> lolos', () => {
    const k = kandidatDasar({ kode: 'I10', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false, umur_min: 18, umur_maks: 120 } });
    const { diterima } = terapkanAturanKode([k], { umurTahun: 45 });
    expect(diterima).toHaveLength(1);
  });

  test('e: kode asterisk sebagai primer tanpa dagger -> ditolak', () => {
    const k = kandidatDasar({ kode: 'G63.2*', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false, asterisk: true } });
    const { diterima, ditolak } = terapkanAturanKode([k], { posisi: 'primer', daggerHadir: false });
    expect(diterima).toHaveLength(0);
    expect(ditolak[0].alasan).toBe(ALASAN_TOLAK.ASTERISK_TANPA_DAGGER);
  });

  test('e: kode asterisk dengan dagger hadir di daftar -> lolos', () => {
    const k = kandidatDasar({ kode: 'G63.2*', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false, asterisk: true } });
    const { diterima } = terapkanAturanKode([k], { posisi: 'primer', daggerHadir: true });
    expect(diterima).toHaveLength(1);
  });

  test('f: kode sebab luar (V01-Y98) sebagai primer -> ditolak', () => {
    const k = kandidatDasar({ kode: 'V89.9', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false, sebab_luar: true } });
    const { diterima, ditolak } = terapkanAturanKode([k], { posisi: 'primer' });
    expect(diterima).toHaveLength(0);
    expect(ditolak[0].alasan).toBe(ALASAN_TOLAK.SEBAB_LUAR_SEBAGAI_PRIMER);
  });

  test('f: kode sebab luar sebagai sekunder -> lolos', () => {
    const k = kandidatDasar({ kode: 'V89.9', ref: { ditemukan: true, punya_turunan: false, kode_gejala: false, sebab_luar: true } });
    const { diterima } = terapkanAturanKode([k], { posisi: 'sekunder' });
    expect(diterima).toHaveLength(1);
  });

  test('g: kutipan tidak ada di teks halaman -> ditolak', () => {
    const k = kandidatDasar();
    const { diterima, ditolak } = terapkanAturanKode([k], {
      kutipan: { teks: 'kalimat yang tidak pernah ada di berkas ini', halaman: 1, halamanBerkas: HALAMAN },
    });
    expect(diterima).toHaveLength(0);
    expect(ditolak[0].alasan).toBe(ALASAN_TOLAK.KUTIPAN_TIDAK_TERVERIFIKASI);
  });

  test('g: kutipan persis ada di teks halaman -> lolos', () => {
    const k = kandidatDasar();
    const { diterima } = terapkanAturanKode([k], {
      kutipan: { teks: 'kolik abdomen, nyeri di daerah epigastrium', halaman: 1, halamanBerkas: HALAMAN },
    });
    expect(diterima).toHaveLength(1);
  });
});

describe('deteksiRencana (bagian 6 — "belum dilakukan")', () => {
  test.each([
    'Rencana USG abdomen',
    'Pro endoskopi',
    'Advis dr. Sp.PD: cek darah lengkap',
    'Usul kolonoskopi',
    'Planning CT scan kepala',
    'Cek tanpa hasil: rontgen thorax',
    'Cek-tanpa-hasil rontgen thorax',
    'Konsul Sp.B untuk apendektomi',
    'USG abdomen jika perlu',
    'EKG k/p',
  ])('menandai "%s" sebagai rencana (belum dilakukan)', (teks) => {
    expect(deteksiRencana(teks)).toBe(true);
  });

  test.each([
    'Appendektomi',
    'Debridement luka',
    'Pemasangan infus',
    'Problem keperawatan: nyeri akut', // "pro" tidak boleh match substring "problem"
  ])('TIDAK menandai "%s" sebagai rencana', (teks) => {
    expect(deteksiRencana(teks)).toBe(false);
  });
});

describe('normalisasiJenisKelamin', () => {
  test.each([['1', 'L'], ['2', 'P'], ['L', 'L'], ['P', 'P'], ['Laki-laki', 'L'], ['Perempuan', 'P'], ['', null], [null, null]])(
    '%s -> %s', (input, expected) => {
      expect(normalisasiJenisKelamin(input)).toBe(expected);
    },
  );
});

describe('verifikasiKutipanDenganNfkc — ligatur NFKC', () => {
  test('kutipan dengan ligatur "ﬁ" tetap cocok dengan teks halaman berligatur sama', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Hasil pemeriksaan ﬁsik dalam batas normal.' }];
    const r = verifikasiKutipanDenganNfkc('pemeriksaan ﬁsik dalam batas normal', 1, halaman);
    expect(r.valid).toBe(true);
  });

  test('kutipan tanpa ligatur tetap cocok dengan teks halaman BERligatur (NFKC menyamakan keduanya)', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Hasil pemeriksaan ﬁsik dalam batas normal.' }];
    const r = verifikasiKutipanDenganNfkc('pemeriksaan fisik dalam batas normal', 1, halaman);
    expect(r.valid).toBe(true);
  });

  test('kutipan yang benar-benar tidak ada tetap ditolak', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Hasil pemeriksaan fisik dalam batas normal.' }];
    const r = verifikasiKutipanDenganNfkc('tidak ada kalimat seperti ini', 1, halaman);
    expect(r.valid).toBe(false);
  });
});

describe('validasiJawabanAi — AI hanya boleh pilih dari kandidat', () => {
  const kandidat = [
    { kode: 'R10.4', judul: 'Nyeri abdomen lainnya' },
    { kode: 'R10.1', judul: 'Nyeri epigastrium' },
  ];

  test('kode di luar daftar kandidat -> ditolak', () => {
    const r = validasiJawabanAi({ status: 'terpilih', kode: 'R10.84', kutipan: 'nyeri di daerah epigastrium', halaman: 1 }, kandidat, HALAMAN);
    expect(r.diterima).toBe(false);
    expect(r.alasan).toBe('kode_di_luar_daftar_kandidat');
  });

  test('kode ada di daftar tapi kutipan tidak ditemukan -> ditolak', () => {
    const r = validasiJawabanAi({ status: 'terpilih', kode: 'R10.1', kutipan: 'kalimat karangan yang tidak ada', halaman: 1 }, kandidat, HALAMAN);
    expect(r.diterima).toBe(false);
    expect(r.alasan).toMatch(/^kutipan_tidak_ditemukan/);
  });

  test('kode valid + kutipan terverifikasi -> diterima', () => {
    const r = validasiJawabanAi({ status: 'terpilih', kode: 'R10.1', kutipan: 'nyeri di daerah epigastrium', halaman: 1 }, kandidat, HALAMAN);
    expect(r.diterima).toBe(true);
    expect(r.hasil.status).toBe('terpilih');
    expect(r.hasil.kode).toBe('R10.1');
  });

  test('model menjawab tidak_ada_padanan -> diterima apa adanya (bukan ditebak)', () => {
    const r = validasiJawabanAi({ status: 'tidak_ada_padanan', alasan: 'tidak ada kandidat yang sesuai istilah' }, kandidat, HALAMAN);
    expect(r.diterima).toBe(true);
    expect(r.hasil.status).toBe('tidak_ada_padanan');
  });

  test('jawaban bukan objek -> ditolak, tidak pernah crash', () => {
    expect(validasiJawabanAi(null, kandidat, HALAMAN).diterima).toBe(false);
    expect(validasiJawabanAi(undefined, kandidat, HALAMAN).diterima).toBe(false);
    expect(() => validasiJawabanAi('bukan objek', kandidat, HALAMAN)).not.toThrow();
  });
});

describe('pilihDenganAiDariKandidat — integrasi gatewayModelService (mock)', () => {
  const kandidat = [
    { kode: 'R10.4', judul: 'Nyeri abdomen lainnya' },
    { kode: 'R10.1', judul: 'Nyeri epigastrium' },
  ];

  test('model mengembalikan ok:false -> ditolak dengan rapi, tidak crash', async () => {
    const panggilModelFn = jest.fn().mockResolvedValue({ ok: false, error: 'tanpa kunci' });
    const r = await pilihDenganAiDariKandidat({ teks: 'kolik abdomen', kandidat, halamanBerkas: HALAMAN, panggilModelFn });
    expect(r.diterima).toBe(false);
    expect(r.alasan).toMatch(/^model_gagal/);
  });

  test('model mengarang kode di luar daftar -> ditolak (TIDAK ditebak ulang)', async () => {
    const panggilModelFn = jest.fn().mockResolvedValue({ ok: true, hasil: { status: 'terpilih', kode: 'R10.84', kutipan: 'nyeri di daerah epigastrium', halaman: 1 } });
    const r = await pilihDenganAiDariKandidat({ teks: 'kolik abdomen', kandidat, halamanBerkas: HALAMAN, panggilModelFn });
    expect(r.diterima).toBe(false);
    expect(r.alasan).toBe('kode_di_luar_daftar_kandidat');
    expect(panggilModelFn).toHaveBeenCalledTimes(1);
  });

  test('model memilih dari daftar dengan kutipan sah -> diterima', async () => {
    const panggilModelFn = jest.fn().mockResolvedValue({ ok: true, hasil: { status: 'terpilih', kode: 'R10.1', kutipan: 'nyeri di daerah epigastrium', halaman: 1 } });
    const r = await pilihDenganAiDariKandidat({ teks: 'kolik abdomen', kandidat, halamanBerkas: HALAMAN, panggilModelFn });
    expect(r.diterima).toBe(true);
    expect(r.hasil.kode).toBe('R10.1');
  });

  test('prompt memuat instruksi larangan ICD-10-CM dan daftar kandidat', () => {
    const prompt = buatPromptPilihKode({ teks: 'kolik abdomen', kandidat });
    expect(prompt).toContain('R10.4');
    expect(prompt).toContain('R10.1');
  });
});

describe('prosesDaftarKode — 5 status (contoh dari spek)', () => {
  function buatDeps(peta) {
    return {
      cariKandidatKode: jest.fn(async (db, { teks }) => peta[teks] || []),
    };
  }

  test('tidak_tertulis: kolom diagnosis kosong/"-"', async () => {
    const deps = buatDeps({});
    const hasil = await prosesDaftarKode({
      items: [{ teks: '-', halaman: 3 }],
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0]).toEqual({ status: 'tidak_tertulis', halaman: 3 });
    expect(deps.cariKandidatKode).not.toHaveBeenCalled();
  });

  test('tidak_dikenali: pencarian layer 1-3 tidak menemukan apa pun', async () => {
    const deps = buatDeps({ 'istilah ajaib tak dikenal': [] });
    const hasil = await prosesDaftarKode({
      items: [{ teks: 'istilah ajaib tak dikenal', halaman: 1 }],
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0]).toEqual({ status: 'tidak_dikenali', teks_asli: 'istilah ajaib tak dikenal' });
  });

  test('terpilih: kolik abdomen -> satu kandidat lapis-1 lolos semua aturan (contoh spek)', async () => {
    const deps = {
      cariKandidatKode: jest.fn(async () => [
        { kode: 'R10.4', sistem: 'icd10', judul: 'Nyeri abdomen lainnya dan tidak spesifik', lapis: 1, skor: 1 },
      ]),
      ambilAtributKode: jest.fn(async () => new Map([
        ['R10.4', { ditemukan: true, punya_turunan: false, kode_gejala: true, jenis_kelamin: null, umur_min: null, umur_maks: null, asterisk: false, sebab_luar: false }],
      ])),
    };
    const hasil = await prosesDaftarKode({
      items: [{ teks: 'kolik abdomen, nyeri di daerah epigastrium', halaman: 1 }],
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0].status).toBe('terpilih');
    expect(hasil[0].kode).toBe('R10.4');
    expect(hasil[0].halaman).toBe(1);
  });

  test('pilih_kandidat: 2+ kandidat setara lolos aturan a-g (hiperpireksia, contoh spek)', async () => {
    const deps = {
      cariKandidatKode: jest.fn(async () => [
        { kode: 'R50.9', sistem: 'icd10', judul: 'Demam, tidak spesifik', lapis: 2, skor: 0.8 },
        { kode: 'R50.8', sistem: 'icd10', judul: 'Demam spesifik lainnya', lapis: 2, skor: 0.8 },
      ]),
      ambilAtributKode: jest.fn(async () => new Map([
        ['R50.9', { ditemukan: true, punya_turunan: false, kode_gejala: true }],
        ['R50.8', { ditemukan: true, punya_turunan: false, kode_gejala: true }],
      ])),
    };
    const hasil = await prosesDaftarKode({
      items: [{ teks: 'hiperpireksia', kutipan: 'hiperpireksia suhu 39.8 C', halaman: 2 }],
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0].status).toBe('pilih_kandidat');
    expect(hasil[0].kandidat.length).toBe(2);
    expect(hasil[0].kandidat.map((k) => k.kode).sort()).toEqual(['R50.8', 'R50.9']);
  });

  test('pilih_kandidat: satu-satunya kandidat tersisa berasal dari lapis 3 (lemah)', async () => {
    const deps = {
      cariKandidatKode: jest.fn(async () => [
        { kode: 'I10', sistem: 'icd10', judul: 'Hipertensi esensial', lapis: 3, skor: 0.3 },
      ]),
      ambilAtributKode: jest.fn(async () => new Map([
        ['I10', { ditemukan: true, punya_turunan: false, kode_gejala: false }],
      ])),
    };
    const hasil = await prosesDaftarKode({
      items: [{ teks: 'tekanan darah tinggi', kutipan: 'tidak ada tanda kerusakan organ', halaman: 3 }],
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0].status).toBe('pilih_kandidat');
    expect(hasil[0].kandidat).toEqual([{ kode: 'I10', judul: 'Hipertensi esensial', lapis: 3 }]);
  });

  test('tidak_ada_padanan: HT urgensi/emergensi -> I16.x (ICD-10-CM) ditolak aturan a; TIDAK ada kode_terdekat otomatis karena I10 beda kategori (keterbatasan terdokumentasi)', async () => {
    const deps = {
      cariKandidatKode: jest.fn(async () => [
        { kode: 'I16.0', sistem: 'icd10', judul: 'Hipertensi urgensi', lapis: 3, skor: 0.4 },
        { kode: 'I16.1', sistem: 'icd10', judul: 'Hipertensi emergensi', lapis: 3, skor: 0.4 },
      ]),
      // I16.x TIDAK ada di ref_kode (bukan WHO/2010) -> ditemukan:false, keduanya ditolak aturan a.
      ambilAtributKode: jest.fn(async () => new Map()),
    };
    const hasil = await prosesDaftarKode({
      items: [{ teks: 'HT urgensi', kutipan: 'Hipertensi emergensi, TD 150/90', halaman: 3 }],
      halamanBerkas: HALAMAN,
      deps,
      // db sengaja tidak diisi -> mekanisme kode_terdekat (yang pun hanya
      // bekerja untuk kesamaan kategori 3-karakter, lihat ambilKodeTerdekat)
      // tidak dipanggil sama sekali; I10 beda kategori dari I16 jadi memang
      // tidak akan pernah ditemukan olehnya walau db diisi.
    });
    expect(hasil[0].status).toBe('tidak_ada_padanan');
    expect(hasil[0].kode_terdekat).toBeUndefined();
  });

  test('kode_terdekat: kategori 3-karakter sama & persis satu sibling valid -> disarankan (pola R10.84 -> R10.4, konsisten dgn kodeDiagnosisWhoService)', async () => {
    const dbMock = { all: jest.fn().mockResolvedValue([{ kode: 'R10.4' }]) };
    const deps = {
      cariKandidatKode: jest.fn(async () => [
        { kode: 'R10.84', sistem: 'icd10', judul: 'Nyeri perut menyeluruh (ICD-10-CM)', lapis: 3, skor: 0.5 },
      ]),
      ambilAtributKode: jest.fn(async () => new Map()), // R10.84 tidak ada di ref_kode
    };
    const hasil = await prosesDaftarKode({
      db: dbMock,
      items: [{ teks: 'nyeri perut menyeluruh', kutipan: 'tidak ada tanda kerusakan organ', halaman: 3 }],
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0].status).toBe('tidak_ada_padanan');
    expect(hasil[0].kode_terdekat).toBe('R10.4');
    expect(dbMock.all).toHaveBeenCalledWith(expect.stringContaining('ref_kode'), ['R10%']);
  });

  test('kode_terdekat: ambigu (lebih dari satu sibling valid) -> TIDAK dipaksakan', async () => {
    const dbMock = { all: jest.fn().mockResolvedValue([{ kode: 'R10.1' }, { kode: 'R10.4' }]) };
    const deps = {
      cariKandidatKode: jest.fn(async () => [
        { kode: 'R10.84', sistem: 'icd10', judul: 'Nyeri perut menyeluruh (ICD-10-CM)', lapis: 3, skor: 0.5 },
      ]),
      ambilAtributKode: jest.fn(async () => new Map()),
    };
    const hasil = await prosesDaftarKode({
      db: dbMock,
      items: [{ teks: 'nyeri perut menyeluruh', kutipan: 'tidak ada tanda kerusakan organ', halaman: 3 }],
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0].status).toBe('tidak_ada_padanan');
    expect(hasil[0].kode_terdekat).toBeUndefined();
  });

  test('tidak_ada_padanan: kandidat ditemukan tapi kutipan tidak terverifikasi -> ditolak via aturan g, bukan diterima diam-diam', async () => {
    const deps = {
      cariKandidatKode: jest.fn(async () => [
        { kode: 'R10.4', sistem: 'icd10', judul: 'Nyeri abdomen lainnya', lapis: 1, skor: 1 },
      ]),
      ambilAtributKode: jest.fn(async () => new Map([
        ['R10.4', { ditemukan: true, punya_turunan: false, kode_gejala: true }],
      ])),
    };
    const hasil = await prosesDaftarKode({
      items: [{ teks: 'nyeri perut', kutipan: 'kalimat karangan yang tidak pernah ada di berkas', halaman: 1 }],
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0].status).toBe('tidak_ada_padanan');
    expect(hasil[0].alasan).toBe(ALASAN_TOLAK.KUTIPAN_TIDAK_TERVERIFIKASI);
  });

  test('aturan c lintas-daftar: R50.9 (demam) dibuang kalau A91 (DHF) ada di daftar diagnosis yang sama', async () => {
    const peta = new Map([
      ['A91', { ditemukan: true, punya_turunan: false, kode_gejala: false }],
      ['R50.9', { ditemukan: true, punya_turunan: false, kode_gejala: true }],
    ]);
    const deps = {
      cariKandidatKode: jest.fn(async (db, { teks }) => {
        if (teks === 'demam dengue') return [{ kode: 'A91', sistem: 'icd10', judul: 'Demam dengue hemoragik', lapis: 1, skor: 1 }];
        if (teks === 'demam tinggi') return [{ kode: 'R50.9', sistem: 'icd10', judul: 'Demam, tidak spesifik', lapis: 1, skor: 1 }];
        return [];
      }),
      ambilAtributKode: jest.fn(async (db, kodeList) => {
        const hasil = new Map();
        for (const k of kodeList) if (peta.has(k)) hasil.set(k, peta.get(k));
        return hasil;
      }),
    };
    const hasil = await prosesDaftarKode({
      items: [
        { teks: 'demam dengue', kutipan: 'demam dengue', halaman: 1 },
        { teks: 'demam tinggi', kutipan: 'demam tinggi', halaman: 1 },
      ],
      halamanBerkas: [{ page_number: 1, ocr_text: 'demam dengue, demam tinggi, pasien dirawat inap.' }],
      deps,
    });
    expect(hasil[0].status).toBe('terpilih');
    expect(hasil[0].kode).toBe('A91');
    // R50.9 tunggal yang tersisa dibuang aturan c -> nol kandidat -> tidak_ada_padanan.
    expect(hasil[1].status).toBe('tidak_ada_padanan');
    expect(hasil[1].alasan).toBe(ALASAN_TOLAK.GEJALA_TERGANTIKAN);
  });

  test('prosedur: penanda "belum dilakukan" dikeluarkan dari daftar (tidak_tertulis + rencana:true), bukan dikodekan', async () => {
    const deps = { cariKandidatKode: jest.fn() };
    const hasil = await prosesDaftarKode({
      items: [{ teks: 'Rencana USG abdomen', halaman: 2 }],
      jenisDaftar: 'prosedur',
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0]).toEqual({ status: 'tidak_tertulis', rencana: true, halaman: 2, teks_asli: 'Rencana USG abdomen' });
    expect(deps.cariKandidatKode).not.toHaveBeenCalled();
  });

  test('ANTI-UPCODING: dua kandidat prosedur hanya beda tarif tersirat, determinan (pendekatan) tidak terdokumentasi -> pilih_kandidat, BUKAN memilih diam-diam yang tarifnya lebih tinggi', async () => {
    // "appendektomi laparoskopik" (tarif lebih tinggi) vs "appendektomi" (terbuka,
    // tarif lebih rendah) -- teks sumber TIDAK menyebut pendekatan sama sekali.
    const kandidatMahal = { kode: '47.01', sistem: 'icd9', judul: 'Appendektomi laparoskopik', lapis: 2, skor: 0.9, tarifPerkiraan: 9000000 };
    const kandidatMurah = { kode: '47.09', sistem: 'icd9', judul: 'Appendektomi lainnya (terbuka)', lapis: 2, skor: 0.9, tarifPerkiraan: 4000000 };
    const deps = {
      cariKandidatKode: jest.fn(async () => [kandidatMahal, kandidatMurah]),
      ambilAtributKode: jest.fn(async () => new Map([
        ['47.01', { ditemukan: true, punya_turunan: false, kode_gejala: false }],
        ['47.09', { ditemukan: true, punya_turunan: false, kode_gejala: false }],
      ])),
    };
    const halamanProsedur = [{ page_number: 2, ocr_text: 'Dilakukan appendektomi atas indikasi apendisitis akut.' }];
    const hasil = await prosesDaftarKode({
      items: [{ teks: 'appendektomi', kutipan: 'Dilakukan appendektomi atas indikasi apendisitis akut', halaman: 2 }],
      jenisDaftar: 'prosedur',
      sistem: 'icd9',
      halamanBerkas: halamanProsedur,
      deps,
    });
    expect(hasil[0].status).toBe('pilih_kandidat');
    expect(hasil[0].kandidat.map((k) => k.kode).sort()).toEqual(['47.01', '47.09']);
    // Tidak ada field yang mengindikasikan satu kode "terpilih otomatis" karena tarifnya lebih tinggi.
    expect(hasil[0].kode).toBeUndefined();
  });

  test('saran AI (panggilAi:true) hanya metadata — status tetap pilih_kandidat walau AI berhasil memilih valid', async () => {
    const panggilModelFn = jest.fn().mockResolvedValue({
      ok: true,
      hasil: { status: 'terpilih', kode: 'R50.9', kutipan: 'hiperpireksia suhu 39.8', halaman: 2 },
    });
    const deps = {
      cariKandidatKode: jest.fn(async () => [
        { kode: 'R50.9', sistem: 'icd10', judul: 'Demam, tidak spesifik', lapis: 2, skor: 0.8 },
        { kode: 'R50.8', sistem: 'icd10', judul: 'Demam spesifik lainnya', lapis: 2, skor: 0.8 },
      ]),
      ambilAtributKode: jest.fn(async () => new Map([
        ['R50.9', { ditemukan: true, punya_turunan: false, kode_gejala: true }],
        ['R50.8', { ditemukan: true, punya_turunan: false, kode_gejala: true }],
      ])),
      panggilAi: true,
      panggilModelFn,
    };
    const hasil = await prosesDaftarKode({
      items: [{ teks: 'hiperpireksia', kutipan: 'hiperpireksia suhu 39.8 C', halaman: 2 }],
      halamanBerkas: HALAMAN,
      deps,
    });
    expect(hasil[0].status).toBe('pilih_kandidat');
    expect(hasil[0].saran_ai).toEqual({ status: 'terpilih', kode: 'R50.9', judul: 'Demam, tidak spesifik', kutipan: 'hiperpireksia suhu 39.8', halaman: 2 });
  });

  test('cariKandidatKode wajib disuntikkan — melempar error yang jelas kalau lupa', async () => {
    await expect(prosesDaftarKode({ items: [{ teks: 'x', halaman: 1 }] })).rejects.toThrow(/cariKandidatKode wajib/);
  });
});

describe('ambilKodeTerdekat (unit langsung)', () => {
  test('tidak ada sibling valid sama sekali -> null', async () => {
    const dbMock = { all: jest.fn().mockResolvedValue([]) };
    expect(await ambilKodeTerdekat(dbMock, ['I16.0'])).toBeNull();
  });

  test('query gagal (tabel ref_kode belum ada) -> null, tidak melempar', async () => {
    const dbMock = { all: jest.fn().mockRejectedValue(new Error('relation "ref_kode" does not exist')) };
    await expect(ambilKodeTerdekat(dbMock, ['R10.84'])).resolves.toBeNull();
  });

  test('kode tanpa pola kategori yang dikenali (mis. kode prosedur ICD-9) -> dilewati, null', async () => {
    const dbMock = { all: jest.fn() };
    expect(await ambilKodeTerdekat(dbMock, ['47.09'])).toBeNull();
    expect(dbMock.all).not.toHaveBeenCalled();
  });
});
