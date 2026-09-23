const {
  bukanHasilPengukuran, tekananDarahTertulisNol, lookupBand, GCS_MINIMUM,
} = require('../../services/kegawatdaruratanReference');

describe('bukanHasilPengukuran — TTV nol berarti tidak diukur', () => {
  // Kenapa ini penting: tanpa penyaringan ini, angka 0 jatuh di bawah
  // gawatUnder sehingga klaim terlihat gawat darurat atas dasar sesuatu yang
  // bukan pengukuran.
  test.each(['RR', 'SpO2', 'HR', 'TD_sistolik', 'TD_diastolik', 'Suhu'])(
    '%s bernilai 0 ditolak sebagai pengukuran', (key) => {
      expect(bukanHasilPengukuran(key, 0)).toBe(true);
    },
  );

  test('nilai wajar tetap diterima', () => {
    expect(bukanHasilPengukuran('HR', 45)).toBe(false);
    expect(bukanHasilPengukuran('SpO2', 88)).toBe(false);
    expect(bukanHasilPengukuran('Suhu', 36.5)).toBe(false);
    expect(bukanHasilPengukuran('TD_sistolik', 90)).toBe(false);
    expect(bukanHasilPengukuran('RR', 12)).toBe(false);
  });

  // Nilai rendah yang memang gawat TIDAK boleh ikut tersaring — kalau ikut,
  // pasien yang benar-benar gawat justru jadi tidak terdeteksi.
  test('nilai rendah tapi mungkin secara klinis tetap dinilai', () => {
    expect(bukanHasilPengukuran('SpO2', 1)).toBe(false);
    expect(bukanHasilPengukuran('HR', 20)).toBe(false);
    expect(bukanHasilPengukuran('TD_sistolik', 40)).toBe(false);
  });

  describe('Nyeri dikecualikan', () => {
    // 0 pada skala nyeri adalah nilai yang sah dan sering benar.
    // THRESHOLD_TABLE.Nyeri menetapkan normal = [0, 0].
    test('Nyeri 0 diterima sebagai pengukuran sungguhan', () => {
      expect(bukanHasilPengukuran('Nyeri', 0)).toBe(false);
    });

    test('dan tetap dinilai normal, bukan dikosongkan', () => {
      expect(lookupBand('Nyeri', 0, 'dewasa')).toBe('normal');
    });
  });

  describe('GCS memakai batas bawah 3, bukan 0', () => {
    // GCS terendah yang mungkin adalah 3 (tiap komponen minimal 1), jadi
    // 0/1/2 tidak bisa berasal dari penilaian yang benar-benar dilakukan.
    test('GCS di bawah 3 ditolak', () => {
      expect(GCS_MINIMUM).toBe(3);
      expect(bukanHasilPengukuran('GCS', 0)).toBe(true);
      expect(bukanHasilPengukuran('GCS', 1)).toBe(true);
      expect(bukanHasilPengukuran('GCS', 2)).toBe(true);
    });

    test('GCS 3 adalah koma dalam — sah dan harus tetap dinilai gawat', () => {
      expect(bukanHasilPengukuran('GCS', 3)).toBe(false);
      expect(lookupBand('GCS', 3, 'dewasa')).toBe('gawat');
    });

    test('GCS 15 normal', () => {
      expect(bukanHasilPengukuran('GCS', 15)).toBe(false);
    });
  });

  test('bukan angka tidak dianggap tertulis nol', () => {
    expect(bukanHasilPengukuran('HR', null)).toBe(false);
    expect(bukanHasilPengukuran('HR', NaN)).toBe(false);
    expect(bukanHasilPengukuran('HR', undefined)).toBe(false);
  });
});

describe('tekananDarahTertulisNol — TD sebagai satu teks', () => {
  // Bentuk ini tidak lolos Number() sehingga tanpa pengenalan khusus ia cuma
  // tampak seperti kolom kosong, dan tampilan tidak bisa menjelaskan bahwa di
  // dokumennya memang tertulis 0.
  test.each(['0/0', '0/', '0 / 0', '000/00', '  0/0  ', '0/000'])(
    '%s dikenali sebagai tertulis nol', (teks) => {
      expect(tekananDarahTertulisNol(teks)).toBe(true);
    },
  );

  test.each(['120/80', '0/80', '90/0', '', 'tidak diukur', '-'])(
    '%s bukan tertulis nol', (teks) => {
      expect(tekananDarahTertulisNol(teks)).toBe(false);
    },
  );

  test('null/undefined aman', () => {
    expect(tekananDarahTertulisNol(null)).toBe(false);
    expect(tekananDarahTertulisNol(undefined)).toBe(false);
  });
});
