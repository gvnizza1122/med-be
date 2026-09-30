const {
  putuskanSumberHalaman, punyaLapisanTeksNyata, rencanakanSumberHalaman, ukurMutuTeks, SUMBER, ALASAN,
} = require('../../services/keputusanSumberHalamanService');

const KALIMAT = 'Pasien datang dengan keluhan batuk dan sesak sejak tiga hari yang lalu, tidak ada demam, tekanan darah 120/80 mmHg. ';
const TEKS_NYATA = KALIMAT.repeat(6); // > 500 karakter
const SAMPAH = '#@$%^&*~`|<>{}[]\\ ¤¦§ ¬ ■□▲ '.repeat(30);

describe('putuskanSumberHalaman (mode all, perilaku ocrService)', () => {
  test('halaman ber-teks nyata >= 500 karakter memakai lapisan teks, tanpa OCR', () => {
    const r = putuskanSumberHalaman(TEKS_NYATA);
    expect(r.sumber).toBe(SUMBER.NATIVE);
    expect(r.alasan).toBe(ALASAN.TEKS_CUKUP);
  });

  test('halaman pindai (tanpa teks) di-OCR', () => {
    expect(putuskanSumberHalaman('')).toMatchObject({ sumber: SUMBER.OCR, alasan: ALASAN.TANPA_TEKS });
    expect(putuskanSumberHalaman(null).sumber).toBe(SUMBER.OCR);
    expect(putuskanSumberHalaman('  12  \n').sumber).toBe(SUMBER.OCR);
  });

  test('teks sedikit (50-499) tetap di-OCR karena bisa campuran teks + tabel gambar', () => {
    const r = putuskanSumberHalaman(KALIMAT); // ~120 karakter
    expect(r.sumber).toBe(SUMBER.OCR);
    expect(r.alasan).toBe(ALASAN.TEKS_SEDIKIT);
  });

  test('lapisan teks sampah di-OCR walau panjang', () => {
    const r = putuskanSumberHalaman(SAMPAH);
    expect(r.sumber).toBe(SUMBER.OCR);
    expect(r.alasan).toBe(ALASAN.TEKS_SAMPAH);
  });

  test('teks panjang tanpa vokal (kode terpotong) dianggap rusak bila banyak kata', () => {
    const teks = 'xzq wrt plk mnb vcx zdf ghj klm qwr tyn '.repeat(15);
    expect(putuskanSumberHalaman(teks).alasan).toBe(ALASAN.TEKS_SAMPAH);
  });

  test('halaman tabel lab bernilai angka tetap dianggap teks nyata', () => {
    const tabel = ('Hemoglobin  12,3  g/dL  12.0 - 16.0  L\nLeukosit  9.500  /uL  4.000 - 10.000\n').repeat(8);
    expect(putuskanSumberHalaman(tabel).sumber).toBe(SUMBER.NATIVE);
  });
});

describe('mode auto-scan', () => {
  test('cukup 50 karakter bermutu untuk memakai teks', () => {
    expect(putuskanSumberHalaman(KALIMAT, { mode: 'auto-scan' }).sumber).toBe(SUMBER.NATIVE);
  });
  test('sampah tetap OCR', () => {
    expect(putuskanSumberHalaman(SAMPAH, { mode: 'auto-scan' }).sumber).toBe(SUMBER.OCR);
  });
});

describe('rencanakanSumberHalaman', () => {
  test('memisahkan halaman teks dan halaman OCR per dokumen', () => {
    const r = rencanakanSumberHalaman([
      { page_num: 1, text_full: TEKS_NYATA },
      { page_num: 2, text_full: '' },
      { page_number: 3, text: SAMPAH },
      { page_num: 4, text_full: TEKS_NYATA },
    ]);
    expect(r.native_text).toEqual([1, 4]);
    expect(r.ocr).toEqual([2, 3]);
    expect(r.rincian[2].alasan).toBe(ALASAN.TEKS_SAMPAH);
  });

  test('daftar kosong', () => {
    expect(rencanakanSumberHalaman(null)).toEqual({ native_text: [], ocr: [], rincian: [] });
  });
});

describe('punyaLapisanTeksNyata dan ukurMutuTeks', () => {
  test('boolean pintasan', () => {
    expect(punyaLapisanTeksNyata(TEKS_NYATA)).toBe(true);
    expect(punyaLapisanTeksNyata(SAMPAH)).toBe(false);
  });
  test('ukuran mutu teks nyata tinggi', () => {
    const m = ukurMutuTeks(TEKS_NYATA);
    expect(m.rasio_alfanumerik).toBeGreaterThan(0.9);
    expect(m.rasio_kata_berbunyi).toBeGreaterThan(0.8);
  });
});
