const {
  bacaSatuBaris, bacaBarisLab, bacaLabDariHalaman, barisPerParameter, nilaiLabDariBaris,
  periksaKewajaran, normalisasiSatuan, bacaAngka, kunciParameter, PESAN_TIDAK_DAPAT_DIPAKAI,
} = require('../../services/bacaLabService');

describe('bacaSatuBaris: satu baris = satu parameter lengkap', () => {
  test('baris lengkap dengan kolom dipisah spasi ganda', () => {
    const r = bacaSatuBaris('Hemoglobin  12,3  g/dL  12.0 - 16.0  L  15/03/2026');
    expect(r.parameter).toBe('hemoglobin');
    expect(r.nilai).toBe(12.3);
    expect(r.satuan).toBe('g/dL');
    expect(r.rujukan).toMatchObject({ min: 12, max: 16 });
    expect(r.flag_cetak).toBe('L');
    expect(r.tanggal).toBe('2026-03-15');
    expect(r.tanggal_dari).toBe('baris');
  });

  test('baris dengan spasi tunggal dan nama singkatan', () => {
    const r = bacaSatuBaris('Hb 9.8 g/dL');
    expect(r.parameter).toBe('hemoglobin');
    expect(r.nilai).toBe(9.8);
    expect(r.dapat_dipakai_memutuskan_syarat).toBe(true);
  });

  test('nama dengan kurung: Hemoglobin (Hb)', () => {
    expect(bacaSatuBaris('Hemoglobin (Hb)  13,1  g/dL').parameter).toBe('hemoglobin');
  });

  test('kalimat biasa bukan baris lab', () => {
    expect(bacaSatuBaris('Pasien mengeluh batuk 3 hari')).toBeNull();
    expect(bacaSatuBaris('')).toBeNull();
  });

  test('nilai tidak diambil dari baris tetangga', () => {
    const rows = bacaBarisLab('Hemoglobin\nLeukosit  9.500  /uL');
    expect(rows.find(r => r.parameter === 'hemoglobin')).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0].parameter).toBe('leukosit');
  });
});

describe('kewajaran', () => {
  test('Hb 120 g/dL mustahil, kemungkinan 12.0, tidak dapat dipakai', () => {
    const r = bacaSatuBaris('Hemoglobin  120  g/dL');
    expect(r.kewajaran.status).toBe('mustahil');
    expect(r.kewajaran.kemungkinan_nilai).toBe(12);
    expect(r.dapat_dipakai_memutuskan_syarat).toBe(false);
    expect(r.alasan_tidak_dapat_dipakai).toContain(PESAN_TIDAK_DAPAT_DIPAKAI);
  });

  test('Hb 120 g/L wajar setelah konversi satuan (12.0 g/dL)', () => {
    const r = bacaSatuBaris('Hemoglobin  120  g/L');
    expect(r.kewajaran.nilai_dinormalkan).toBe(12);
    expect(r.dapat_dipakai_memutuskan_syarat).toBe(true);
  });

  test('Ht 470% mustahil', () => {
    const r = bacaSatuBaris('Hematokrit  470  %');
    expect(r.kewajaran.status).toBe('mustahil');
    expect(r.kewajaran.kemungkinan_nilai).toBe(47);
    expect(r.dapat_dipakai_memutuskan_syarat).toBe(false);
  });

  test('trombosit 150.000 /uL vs 150 ribu/uL sama nilainya', () => {
    const a = bacaSatuBaris('Trombosit  150.000  /uL');
    const b = bacaSatuBaris('Trombosit  150  10^3/uL');
    expect(a.kewajaran.nilai_dinormalkan).toBe(150000);
    expect(b.kewajaran.nilai_dinormalkan).toBe(150000);
    expect(a.dapat_dipakai_memutuskan_syarat).toBe(true);
    expect(b.dapat_dipakai_memutuskan_syarat).toBe(true);
  });

  test('trombosit 150 berlabel /uL atau tanpa satuan: ambigu, tidak dipakai', () => {
    for (const baris of ['Trombosit  150  /uL', 'Trombosit  150']) {
      const r = bacaSatuBaris(baris);
      expect(r.kewajaran.ambigu_satuan).toBe(true);
      expect(r.kewajaran.kemungkinan_nilai).toBe(150000);
      expect(r.dapat_dipakai_memutuskan_syarat).toBe(false);
    }
  });

  test('huruf O pada angka (1O,2): dikoreksi dan ditandai, tidak dipakai', () => {
    const r = bacaSatuBaris('Hb  1O,2  g/dL');
    expect(r.nilai).toBe(10.2);
    expect(r.kewajaran.koreksi_huruf).toBe(true);
    expect(r.dapat_dipakai_memutuskan_syarat).toBe(false);
    expect(r.perlu_cek_manusia).toBe(true);
  });

  test('satuan tidak cocok menandai kolom bergeser', () => {
    const r = bacaSatuBaris('Hemoglobin  12,3  mg/dL');
    expect(r.kewajaran.satuan_tidak_cocok).toBe(true);
    expect(r.dapat_dipakai_memutuskan_syarat).toBe(false);
  });

  test('parameter tak dikenal dengan angka wajar tidak dinilai', () => {
    const r = periksaKewajaran('tidak_ada', 5, 'mg/dL');
    expect(r.status).toBe('tidak_diperiksa');
  });
});

describe('uji silang flag cetak', () => {
  test('cetak L tetapi nilai di dalam rujukan => konflik', () => {
    const r = bacaSatuBaris('Hemoglobin  13,5  g/dL  12.0 - 16.0  L');
    expect(r.kewajaran.konflik_flag).toBe(true);
    expect(r.dapat_dipakai_memutuskan_syarat).toBe(false);
    expect(r.alasan_tidak_dapat_dipakai).toMatch(/flag cetak L/);
  });

  test('cetak L dan nilai memang di bawah rujukan => konsisten', () => {
    const r = bacaSatuBaris('Hemoglobin  9,5  g/dL  12.0 - 16.0  L');
    expect(r.kewajaran.konflik_flag).toBe(false);
    expect(r.dapat_dipakai_memutuskan_syarat).toBe(true);
  });

  test('cetak H tetapi nilai di rentang => konflik', () => {
    expect(bacaSatuBaris('Leukosit  8.000  /uL  4.000 - 10.000  H').kewajaran.konflik_flag).toBe(true);
  });

  test('tanpa rujukan cetak memakai rentang inti parameter', () => {
    const r = bacaSatuBaris('Hemoglobin  14,0  g/dL  L');
    expect(r.kewajaran.konflik_flag).toBe(true);
  });

  test('flag melekat pada angka (12,3L)', () => {
    expect(bacaSatuBaris('Hemoglobin  9,1L  g/dL').flag_cetak).toBe('L');
  });
});

describe('beberapa tanggal', () => {
  const TEKS = [
    'Tanggal: 10/03/2026',
    'Trombosit  180.000  /uL',
    'Hemoglobin  12,0  g/dL',
    'Tanggal: 12/03/2026',
    'Trombosit  90.000  /uL',
    'Hemoglobin  11,0  g/dL  15/03/2026',
  ].join('\n');

  test('trombosit hari 1 dan hari 3 adalah dua baris, tidak saling menimpa', () => {
    const rows = bacaBarisLab(TEKS, { halaman: 4 });
    const tr = barisPerParameter(rows, 'trombosit');
    expect(tr.map(r => [r.tanggal, r.nilai])).toEqual([['2026-03-10', 180000], ['2026-03-12', 90000]]);
    expect(tr[0].tanggal_dari).toBe('judul');
  });

  test('tanggal pada baris didahulukan atas judul', () => {
    const hb = barisPerParameter(bacaBarisLab(TEKS), 'hemoglobin');
    expect(hb.map(r => r.tanggal)).toEqual(['2026-03-10', '2026-03-15']);
    expect(hb[1].tanggal_dari).toBe('baris');
  });
});

describe('bacaLabDariHalaman dan nilaiLabDariBaris', () => {
  const HAL = [{ page_number: 3, ocr_text: 'HEMATOLOGI\nHemoglobin  7,6  g/dL  12.0 - 16.0  L\nHb  76  g/dL\nMCV  85  fL' }];

  test('mengembalikan baris dikenal dan daftar tidak dikenali terpisah', () => {
    const r = bacaLabDariHalaman(HAL);
    expect(r.baris.filter(b => b.parameter === 'hemoglobin')).toHaveLength(2);
    expect(r.tidak_dikenali.map(t => t.nama)).toContain('MCV');
  });

  test('nilai terendah hanya dari baris yang dapat dipakai (76 diabaikan)', () => {
    const r = nilaiLabDariBaris(HAL, 'hemoglobin');
    expect(r.nilai).toBe(7.6);
    expect(r.tidak_dapat_dipakai).toBe(false);
    expect(r.page_number).toBe(3);
    expect(r.jumlah_baris).toBe(2);
  });

  test('semua baris tidak dapat dipakai: dinyatakan, tidak ditebak', () => {
    const r = nilaiLabDariBaris([{ page_number: 1, ocr_text: 'Hb  76  g/dL' }], 'hemoglobin');
    expect(r.nilai).toBeNull();
    expect(r.tidak_dapat_dipakai).toBe(true);
    expect(r.alasan).toContain(PESAN_TIDAK_DAPAT_DIPAKAI);
  });

  test('parameter tidak ada: null', () => {
    expect(nilaiLabDariBaris(HAL, 'kreatinin')).toBeNull();
  });
});

describe('helper', () => {
  test('normalisasiSatuan', () => {
    expect(normalisasiSatuan('10^3/µL')).toBe('ribu/ul');
    expect(normalisasiSatuan('x10^3/uL')).toBe('ribu/ul');
    expect(normalisasiSatuan('/mm3')).toBe('/ul');
    expect(normalisasiSatuan(null)).toBeNull();
  });

  test('bacaAngka', () => {
    expect(bacaAngka('7,2').nilai).toBe(7.2);
    expect(bacaAngka('150.000', { ribuanBolehTitik: true }).nilai).toBe(150000);
    expect(bacaAngka('abc')).toBeNull();
    expect(bacaAngka('OO')).toBeNull();
  });

  test('kunciParameter memakai kamus dan alias', () => {
    expect(kunciParameter('Kreatinin').key).toBe('kreatinin');
    expect(kunciParameter('Gula darah puasa').key).toBe('gula_darah_puasa');
    expect(kunciParameter('PLT').istilah_id).toBe('trombosit');
    expect(kunciParameter('Foo').key).toBeNull();
  });
});

describe('syaratPenunjangService dengan opsi pakaiBacaLab', () => {
  const { evaluasiSyaratPenunjang, STATUS } = require('../../services/syaratPenunjangService');
  const cari = (r) => r[0].syarat.find(s => s.nama.startsWith('Hemoglobin'));

  test('default (opsi mati): perilaku lama, nilai 76 terbaca apa adanya', () => {
    const r = evaluasiSyaratPenunjang(['D63.8'], ['90.59'], [{ page_number: 1, ocr_text: 'Hb  76  g/dL' }]);
    expect(cari(r).nilai).toBe(76);
  });

  test('opsi hidup: Hb 76 tidak dapat dipakai, syarat jadi perlu cek manual', () => {
    const r = evaluasiSyaratPenunjang(['D63.8'], ['90.59'], [{ page_number: 1, ocr_text: 'Hb  76  g/dL' }], { pakaiBacaLab: true });
    expect(cari(r).status).toBe(STATUS.PERLU_CEK_MANUAL);
    expect(cari(r).nilai).toBeNull();
    expect(cari(r).catatan_batasan).toContain('tidak dapat dipakai memutuskan syarat klaim');
  });

  test('opsi hidup: nilai wajar di bawah ambang terpenuhi', () => {
    const r = evaluasiSyaratPenunjang(['D63.8'], ['90.59'], [{ page_number: 1, ocr_text: 'Hemoglobin  7,2  g/dL  12.0 - 16.0  L' }], { pakaiBacaLab: true });
    expect(cari(r).status).toBe(STATUS.TERPENUHI);
    expect(cari(r).nilai).toBe(7.2);
  });

  test('opsi hidup tetapi tidak ada baris: jatuh ke pembacaan lama', () => {
    const r = evaluasiSyaratPenunjang(['D63.8'], ['90.59'], [{ page_number: 1, ocr_text: 'Hemoglobin: 7,2 mg' }], { pakaiBacaLab: true });
    expect(cari(r).nilai).toBe(7.2);
  });
});
