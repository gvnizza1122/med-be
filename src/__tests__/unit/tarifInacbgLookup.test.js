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

// Kasus produksi 21 Sep 2026: klaim IGD anak (G40.9 / epilepsi, prosedur
// 90.59) -- panel INA-CBG & Tarif menampilkan kode G-4-22-I dan deskripsi
// "SERANGAN KEJANG(RINGAN)" (lookup kode BERHASIL), tapi tarif tampil
// "Tidak ditemukan". Akar masalah: G-4-22-I adalah kode rawat-inap MURNI
// (kelasA/B/C terisi, kelasD null -- BEDA dari kasus kelasD di atas), dan
// kelas_rawat yang diteruskan ke getTarifResmi() untuk klaim ini tidak
// diketahui/tidak valid (kosong atau sampah non-numerik hasil ekstraksi).
// Sebelum fix, pemanggil (aiReviewService.js) diam-diam mendefault ke '3'
// HANYA kalau field itu falsy -- tidak menyelamatkan kasus field berisi
// sampah truthy (mis. "-"/"IGD") -- lalu tarif jatuh ke null TANPA
// penjelasan. Test ini mengunci: (a) baris G-4-22-I di data memang
// kelasD-nya null (bukan bug parsing), (b) tarif tetap bisa didapat kalau
// kelas_rawat valid diketahui, (c) kalau kelas_rawat genuinely tidak
// diketahui/tidak valid, tarif null TAPI disertai alasan spesifik yang
// menjelaskan sebabnya -- bukan diam-diam ditebak kelas 3 atau ditampilkan
// tanpa penjelasan sama sekali.
describe('getTarifResmi — kasus produksi G-4-22-I (kode rawat inap murni, kelasD null)', () => {
  test('baris G-4-22-I di data PMK 3/2023: kelasA/B/C terisi, kelasD null', () => {
    const row = lookupTarifInacbg('G-4-22-I');
    expect(row).toBeDefined();
    expect(row.description).toBe('SERANGAN KEJANG(RINGAN)');
    expect(row.kelasA).toBeGreaterThan(0);
    expect(row.kelasB).toBeGreaterThan(0);
    expect(row.kelasC).toBeGreaterThan(0);
    expect(row.kelasD).toBeNull();
  });

  test('kelas_rawat valid (1/2/3) tetap menghasilkan tarif resmi seperti biasa', () => {
    const resmi1 = getTarifResmi('G-4-22-I', '1');
    const resmi3 = getTarifResmi('G-4-22-I', 3);
    expect(resmi1.tarif).toBe(3459500);
    expect(resmi1.kelasRawatValid).toBe(true);
    expect(resmi1.alasanTarifKosong).toBeNull();
    expect(resmi3.tarif).toBe(2601200);
  });

  test('kelas_rawat kosong/tidak valid -> tarif null DENGAN alasan spesifik (bukan ditebak kelas 3, bukan tanpa penjelasan)', () => {
    for (const kelasRawatSampah of [undefined, '', null, '-', 'IGD', 'RAJAL']) {
      const resmi = getTarifResmi('G-4-22-I', kelasRawatSampah);
      expect(resmi).toBeDefined(); // kode & baris TETAP ketemu
      expect(resmi.sumber.description).toBe('SERANGAN KEJANG(RINGAN)');
      expect(resmi.tarif).toBeNull();
      expect(resmi.kelasRawatValid).toBe(false);
      expect(resmi.alasanTarifKosong).toEqual(expect.stringContaining('kelas rawat pasien tidak diketahui'));
      expect(resmi.alasanTarifKosong).toEqual(expect.stringContaining('G-4-22-I'));
    }
  });

  test('validateTarifDiscrepancy: kelas_rawat tidak valid -> status TARIF_TIDAK_BERLAKU disertai field alasan & kelasRawatValid', () => {
    const result = validateTarifDiscrepancy('G-4-22-I', 'IGD', 3000000);
    expect(result.status).toBe('TARIF_TIDAK_BERLAKU');
    expect(result.valid).toBe(false);
    expect(result.kelasRawatValid).toBe(false);
    expect(result.alasan).toEqual(expect.stringContaining('kelas rawat pasien tidak diketahui'));
  });
});
