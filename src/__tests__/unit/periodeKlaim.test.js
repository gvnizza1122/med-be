const {
  tentukanPeriode, periodeDariSep, periodeDariTanggal, labelPeriode, simpanPeriode,
} = require('../../services/periodeKlaimService');

describe('periodeDariSep — digit ke-9..12 nomor SEP adalah MMYY', () => {
  test('SEP nyata dari basis data', () => {
    expect(periodeDariSep('0170R0110826V003068')).toBe('2026-08');
    expect(periodeDariSep('0170R0110726V000001')).toBe('2026-07');
    expect(periodeDariSep('0170R0110126V000431')).toBe('2026-01');
    expect(periodeDariSep('0170R0110526V002576')).toBe('2026-05');
  });

  test('spasi dan huruf kecil tetap terbaca', () => {
    expect(periodeDariSep('  0170r0110826v003068  ')).toBe('2026-08');
  });

  // Periode salah lebih berbahaya daripada periode kosong: klaim bisa terarsip
  // ke bulan yang keliru dan luput dari pencocokan rekap pending.
  test('bulan/tahun mustahil ditolak, bukan dipaksakan', () => {
    expect(periodeDariSep('0170R0119926V000001')).toBeNull(); // bulan 99
    expect(periodeDariSep('0170R0110026V000001')).toBeNull(); // bulan 00
    expect(periodeDariSep('0170R0110899V000001')).toBeNull(); // tahun 2099
    expect(periodeDariSep('0170R0110813V000001')).toBeNull(); // tahun 2013, sebelum JKN
  });

  test('SEP cacat/kosong tidak bikin error', () => {
    expect(periodeDariSep('ABC')).toBeNull();
    expect(periodeDariSep('0170R011XX26V0001')).toBeNull();
    expect(periodeDariSep('')).toBeNull();
    expect(periodeDariSep(null)).toBeNull();
    expect(periodeDariSep(undefined)).toBeNull();
  });
});

describe('periodeDariTanggal', () => {
  test('dd/mm/yyyy yang dipakai berkas RS', () => {
    expect(periodeDariTanggal('15/07/2026')).toBe('2026-07');
    expect(periodeDariTanggal('1/7/2026')).toBe('2026-07');
    expect(periodeDariTanggal('31-12-2025')).toBe('2025-12');
  });

  test('ISO dan objek Date', () => {
    expect(periodeDariTanggal('2026-08-21')).toBe('2026-08');
    expect(periodeDariTanggal(new Date(2026, 7, 21))).toBe('2026-08');
  });

  // Bedanya dd/mm vs mm/dd menentukan bulan arsip, jadi diuji eksplisit.
  test('dibaca hari-bulan, bukan bulan-hari ala Amerika', () => {
    expect(periodeDariTanggal('03/09/2026')).toBe('2026-09'); // 3 September
  });

  test('sampah menghasilkan null', () => {
    expect(periodeDariTanggal('bukan tanggal')).toBeNull();
    expect(periodeDariTanggal('')).toBeNull();
    expect(periodeDariTanggal(null)).toBeNull();
  });
});

describe('tentukanPeriode — urutan sumber', () => {
  test('SEP menang atas tanggal masuk dan tanggal unggah', () => {
    expect(tentukanPeriode({
      sep: '0170R0110826V003068', admissionDate: '01/09/2026', createdAt: '2026-09-22',
    })).toEqual({ periode: '2026-08', sumber: 'sep' });
  });

  test('SEP tidak terbaca -> tanggal masuk', () => {
    expect(tentukanPeriode({
      sep: '', admissionDate: '15/07/2026', createdAt: '2026-09-22',
    })).toEqual({ periode: '2026-07', sumber: 'tgl_masuk' });
  });

  test('keduanya kosong -> tanggal unggah, ditandai sebagai tebakan', () => {
    expect(tentukanPeriode({ createdAt: '2026-09-22' }))
      .toEqual({ periode: '2026-09', sumber: 'tgl_upload' });
  });

  test('tidak ada apa pun -> null, bukan bulan berjalan', () => {
    expect(tentukanPeriode({})).toEqual({ periode: null, sumber: null });
  });

  // Inti aturannya: berkas periode Agustus yang baru diunggah September tetap
  // masuk Agustus. Kalau ikut tanggal unggah, rekap pending Agustus tidak akan
  // pernah cocok dengan klaim yang sebenarnya ada.
  test('berkas Agustus diunggah September tetap jadi Agustus', () => {
    const { periode } = tentukanPeriode({
      sep: '0170R0110826V003068', createdAt: '2026-09-23',
    });
    expect(periode).toBe('2026-08');
  });
});

describe('labelPeriode', () => {
  test('bulan Indonesia', () => {
    expect(labelPeriode('2026-08')).toBe('Agustus 2026');
    expect(labelPeriode('2026-01')).toBe('Januari 2026');
    expect(labelPeriode('2025-12')).toBe('Desember 2025');
  });

  test('periode kosong diberi label jujur, bukan tanggal palsu', () => {
    expect(labelPeriode(null)).toBe('Periode belum pasti');
    expect(labelPeriode('')).toBe('Periode belum pasti');
    expect(labelPeriode('2026-13')).toBe('Periode belum pasti');
  });
});

describe('simpanPeriode — penulisan ke basis data', () => {
  function dbPalsu() {
    const tulisan = [];
    return {
      tulisan,
      prepare: () => ({ run: async (...p) => { tulisan.push(p); } }),
    };
  }

  test('menulis periode + sumber per record dan menghitung hasilnya', async () => {
    const db = dbPalsu();
    const hitung = await simpanPeriode(db, [
      { id: 'a', sep: '0170R0110826V003068', admission_date: null, created_at: '2026-09-22' },
      { id: 'b', sep: '', admission_date: '15/07/2026', created_at: '2026-09-22' },
      { id: 'c', sep: null, admission_date: null, created_at: '2026-09-22' },
    ]);

    expect(hitung).toEqual({ sep: 1, tgl_masuk: 1, tgl_upload: 1, gagal: 0 });
    expect(db.tulisan).toEqual([
      ['2026-08', 'sep', 'a'],
      ['2026-07', 'tgl_masuk', 'b'],
      ['2026-09', 'tgl_upload', 'c'],
    ]);
  });

  test('record tanpa petunjuk apa pun dilewati, tidak ditulisi periode tebakan', async () => {
    const db = dbPalsu();
    const hitung = await simpanPeriode(db, [
      { id: 'x', sep: null, admission_date: null, created_at: null },
    ]);
    expect(hitung.gagal).toBe(1);
    expect(db.tulisan).toEqual([]);
  });
});
