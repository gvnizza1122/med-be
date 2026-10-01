const pk = require('../../services/pencarianKodeService');

describe('normalisasiIstilah', () => {
  test('ligatur PDF (NFKC) dilebur', () => {
    expect(pk.normalisasiIstilah('ﬁbrosis hepar')).toBe('fibrosis hepar');
  });

  test('huruf besar -> kecil', () => {
    expect(pk.normalisasiIstilah('Hyperpyrexia NOS')).toBe('hyperpyrexia nos');
  });

  test('tanda baca -> spasi, spasi dirapatkan', () => {
    expect(pk.normalisasiIstilah('acute abdomen, unspecified (NOS)')).toBe('acute abdomen unspecified nos');
  });

  test('aksen dilucuti', () => {
    expect(pk.normalisasiIstilah('Prééclampsia')).toBe('preeclampsia');
  });

  test('spasi berlebih & tab dirapatkan, trim', () => {
    expect(pk.normalisasiIstilah('  nyeri   perut\tbagian   atas  ')).toBe('nyeri perut bagian atas');
  });

  test('null/undefined/angka aman', () => {
    expect(pk.normalisasiIstilah(null)).toBe('');
    expect(pk.normalisasiIstilah(undefined)).toBe('');
    expect(pk.normalisasiIstilah('')).toBe('');
  });

  test('istilah bahasa Indonesia dari description_id tetap bisa dinormalisasi', () => {
    expect(pk.normalisasiIstilah('Nyeri lokal ke perut bagian atas')).toBe('nyeri lokal ke perut bagian atas');
  });
});

describe('tandaiPunyaTurunan', () => {
  test('kode kategori dengan anak subkategori (ICD-10, titik baru)', () => {
    const hasil = pk.tandaiPunyaTurunan(['R10', 'R10.0', 'R10.1', 'R10.4', 'R11']);
    expect(hasil.has('R10')).toBe(true);
    expect(hasil.has('R11')).toBe(false); // leaf, tidak punya anak
    expect(hasil.has('R10.4')).toBe(false); // leaf
  });

  test('kode ICD-9 dengan anak lewat digit tambahan tanpa titik baru', () => {
    const hasil = pk.tandaiPunyaTurunan(['00', '00.0', '00.01', '00.02', '00.1']);
    expect(hasil.has('00')).toBe(true);
    expect(hasil.has('00.0')).toBe(true); // punya anak 00.01, 00.02
    expect(hasil.has('00.01')).toBe(false);
    expect(hasil.has('00.1')).toBe(false);
  });

  test('dua level turunan (ICD-10 enam karakter)', () => {
    const hasil = pk.tandaiPunyaTurunan(['M00', 'M00.0', 'M00.00', 'M00.01', 'M00.1']);
    expect(hasil.has('M00')).toBe(true);
    expect(hasil.has('M00.0')).toBe(true);
    expect(hasil.has('M00.00')).toBe(false);
  });

  test('tidak ada turunan sama sekali', () => {
    const hasil = pk.tandaiPunyaTurunan(['A00', 'B01', 'C02']);
    expect(hasil.size).toBe(0);
  });

  test('duplikat kode tidak merusak hasil', () => {
    const hasil = pk.tandaiPunyaTurunan(['R10', 'R10', 'R10.0']);
    expect(hasil.has('R10')).toBe(true);
  });
});

describe('deriveSebabLuar (V01-Y98, bab XX)', () => {
  test.each([
    ['V01', true], ['V01.0', true], ['W20', true], ['X59', true], ['Y98', true],
    ['A00', false], ['R10', false], ['O80', false], ['P07', false],
  ])('%s -> %s', (kode, expected) => {
    expect(pk.deriveSebabLuar(kode)).toBe(expected);
  });
});

describe('deriveKodeGejala (bab R / XVIII)', () => {
  test('cocok lewat chapter_number', () => {
    expect(pk.deriveKodeGejala({ kode: 'R10', chapterNumber: 'XVIII' })).toBe(true);
  });
  test('cocok lewat prefix kode walau chapter_number kosong', () => {
    expect(pk.deriveKodeGejala({ kode: 'R10.4', chapterNumber: undefined })).toBe(true);
  });
  test('bukan kode gejala', () => {
    expect(pk.deriveKodeGejala({ kode: 'A00', chapterNumber: 'I' })).toBe(false);
  });
});

describe('deriveUsiaKelaminIcd10', () => {
  test('bab XV (kehamilan) -> jenis_kelamin P, umur null', () => {
    expect(pk.deriveUsiaKelaminIcd10({ chapterNumber: 'XV' })).toEqual({ jenisKelamin: 'P', umurMin: null, umurMaks: null });
  });
  test('bab XVI (perinatal) -> umur 0-1 (heuristik tahun), jenis_kelamin null', () => {
    expect(pk.deriveUsiaKelaminIcd10({ chapterNumber: 'XVI' })).toEqual({ jenisKelamin: null, umurMin: 0, umurMaks: 1 });
  });
  test('bab lain -> semua null', () => {
    expect(pk.deriveUsiaKelaminIcd10({ chapterNumber: 'I' })).toEqual({ jenisKelamin: null, umurMin: null, umurMaks: null });
  });
});

describe('deriveJenisKelaminIcd9DariBlok', () => {
  test('blok organ genital laki-laki -> L', () => {
    expect(pk.deriveJenisKelaminIcd9DariBlok('Operations on the Male Genital Organs')).toBe('L');
  });
  test('blok organ genital perempuan -> P', () => {
    expect(pk.deriveJenisKelaminIcd9DariBlok('Operations on the Female Genital Organs')).toBe('P');
  });
  test('blok lain -> null', () => {
    expect(pk.deriveJenisKelaminIcd9DariBlok('Operations on the Cardiovascular System')).toBe(null);
    expect(pk.deriveJenisKelaminIcd9DariBlok(null)).toBe(null);
  });
});

describe('deriveAsterisk', () => {
  test('selalu false (tidak terdeteksi di data sumber)', () => {
    expect(pk.deriveAsterisk()).toBe(false);
  });
});

describe('modul tidak memakai jaringan', () => {
  test('tidak ada fetch/axios/http', () => {
    const src = require('fs').readFileSync(require.resolve('../../services/pencarianKodeService'), 'utf8');
    expect(src).not.toMatch(/fetch\(|require\('https?'\)|axios/);
  });
});
