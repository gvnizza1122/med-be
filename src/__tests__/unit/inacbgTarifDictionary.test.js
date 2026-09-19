const { INACBG_TARIF_DICTIONARY, getInacbgEstimasi } = require('../../services/inacbgTarifDictionary');

describe('getInacbgEstimasi — fix 19 Sep 2026: tidak boleh mengarang tarif', () => {
  test('kode yang ADA di kamus hardcoded (data nyata) tetap mengembalikan tarif itu', () => {
    const result = getInacbgEstimasi('J-4-15-I');
    expect(result).toEqual({
      deskripsi: 'INFEKSI SALURAN NAPAS BAWAH RINGAN',
      tarif: 3500000,
      source: 'DICTIONARY',
    });
  });

  test('semua entri kamus hardcoded masih bisa diakses lewat lookup case-insensitive', () => {
    const codes = Object.keys(INACBG_TARIF_DICTIONARY);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const result = getInacbgEstimasi(code.toLowerCase());
      expect(result.source).toBe('DICTIONARY');
      expect(result.tarif).toBe(INACBG_TARIF_DICTIONARY[code].tarif);
    }
  });

  test('kode format valid tapi TIDAK ADA di kamus -> NOT_FOUND, bukan angka fiktif', () => {
    // Sebelum fix: kode ini akan menghasilkan tarif sintetis dari
    // baseByFamily['J'] * multiplier severity 'II' (fiktif, tidak berdasar
    // Permenkes). Sekarang harus eksplisit "tidak ditemukan".
    const result = getInacbgEstimasi('J-4-99-II');
    expect(result).toEqual({ source: 'NOT_FOUND', tarif: null });
  });

  test('kode dari family yang tidak dikenal sama sekali (mis. luar A-Z Permenkes) juga NOT_FOUND', () => {
    const result = getInacbgEstimasi('ZZ-9-99-III');
    expect(result).toEqual({ source: 'NOT_FOUND', tarif: null });
  });

  test('kode dengan format pendek (kurang dari 4 segmen) tetap NOT_FOUND, bukan null', () => {
    const result = getInacbgEstimasi('J-4-15');
    expect(result).toEqual({ source: 'NOT_FOUND', tarif: null });
  });

  test('input kosong/null tetap mengembalikan null (bukan NOT_FOUND)', () => {
    expect(getInacbgEstimasi(null)).toBeNull();
    expect(getInacbgEstimasi('')).toBeNull();
    expect(getInacbgEstimasi(undefined)).toBeNull();
  });
});
