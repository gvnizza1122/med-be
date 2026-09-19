const { getTarifResmi, lookupTarifInacbg, validateTarifDiscrepancy } = require('../../services/tarifInacbgLookup');

// Fix 19 Sep 2026: ~287 dari 1075 kode di tabel PMK 3/2023 Regional 1 Kelas D
// Swasta adalah kode day-care/RJTL yang tarifnya HANYA ada di kolom kelasD
// (satu tarif tunggal, tidak distratifikasi per kelas kamar 1/2/3). Sebelum
// fix ini, getTarifResmi() tidak pernah membaca kelasD sama sekali, jadi
// kode-kode itu selalu tampil "tidak ditemukan"/"tarif tidak berlaku"
// meskipun sebenarnya valid & ada tarif resminya.
describe('getTarifResmi — fallback ke kelasD untuk kode day-care/RJTL', () => {
  test('kode dengan tarif hanya di kelasD tetap dapat tarif untuk kelas_rawat 1/2/3', () => {
    const row = lookupTarifInacbg('B-2-12-0');
    expect(row).toBeDefined();
    expect(row.kelasA).toBeNull();
    expect(row.kelasB).toBeNull();
    expect(row.kelasC).toBeNull();
    expect(row.kelasD).toBeGreaterThan(0);

    for (const kelas of ['1', '2', '3']) {
      const resmi = getTarifResmi('B-2-12-0', kelas);
      expect(resmi).toBeDefined();
      expect(resmi.tarif).toBe(row.kelasD);
    }
  });

  test('kode dengan tarif hanya di kelasD tetap dapat tarif walau kelas_rawat kosong/tidak dikenal (kasus RAWAT_JALAN)', () => {
    const row = lookupTarifInacbg('B-2-12-0');
    expect(getTarifResmi('B-2-12-0', undefined).tarif).toBe(row.kelasD);
    expect(getTarifResmi('B-2-12-0', '').tarif).toBe(row.kelasD);
    expect(getTarifResmi('B-2-12-0', '4').tarif).toBe(row.kelasD);
  });

  test('kode dengan tarif per-kelas (kelasA/B/C) TIDAK terpengaruh -- tetap pakai kolom kelas yang sesuai', () => {
    const resmiKelas1 = getTarifResmi('G-4-17-II', '1');
    const resmiKelas3 = getTarifResmi('G-4-17-II', '3');
    expect(resmiKelas1.tarif).toBe(5509200);
    expect(resmiKelas3.tarif).toBe(4142300);
  });

  test('kode benar-benar tidak ada di tabel tetap undefined (bukan diperlakukan seperti kelasD)', () => {
    expect(getTarifResmi('ZZ-9-99-XYZ', '3')).toBeUndefined();
  });

  test('validateTarifDiscrepancy match untuk kode day-care yang tarifnya ada di kelasD', () => {
    const result = validateTarifDiscrepancy('B-2-12-0', '3', 2501900);
    expect(result.status).toBe('MATCH');
    expect(result.valid).toBe(true);
    expect(result.tarifResmi).toBe(2501900);
  });
});
