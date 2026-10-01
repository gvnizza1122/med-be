const fs = require('fs');
const path = require('path');
const { groupCodesToInaCBG } = require('../../services/inacbgGroupingService');
const { lookupTarifInacbg, getTarifResmi } = require('../../services/tarifInacbgLookup');
const { hitungInacbgDanTarif } = require('../../services/aiReviewService');

describe('groupCodesToInaCBG', () => {
  test('setiap kategori di tabel aturan ada di PMK 3/2023', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../services/inacbgGroupingService.js'), 'utf8');
    const target = [...src.matchAll(/'([A-Z]-[45]-\d{2}(?:-0)?)'\]/g)].map(m => m[1]);
    expect(target.length).toBeGreaterThan(50);
    const hilang = target.filter(k => (k.endsWith('-0')
      ? !lookupTarifInacbg(k)
      : !['I', 'II', 'III'].every(s => lookupTarifInacbg(`${k}-${s}`))));
    expect(hilang).toEqual([]);
  });

  test.each([
    ['J18.9', 'J-4-16-I'], // pneumonia, bukan "peradangan pernafasan"
    ['I10', 'I-4-17-I'], // hipertensi, bukan infark miokard
    ['A09', 'K-4-16-I'], // gastroenteritis infeksi, bukan HIV
    ['J45.9', 'J-4-18-I'], // asma
    ['R10.4', 'K-4-17-I'], // nyeri abdomen (dulu R-4-18, tidak ada di PMK)
    ['S06.0', 'G-4-25-I'], // gegar otak
  ])('rawat inap %s -> %s', (dx, kode) => {
    expect(groupCodesToInaCBG([dx], [], 'RAWAT_INAP').code).toBe(kode);
  });

  test.each([
    ['R10.4', 'Q-5-25-0'],
    ['A09', 'Q-5-25-0'],
    ['J45.9', 'Q-5-26-0'],
    ['I10', 'Q-5-44-0'],
    ['Z09.8', 'Q-5-18-0'],
  ])('rawat jalan %s -> kode ambulatori %s', (dx, kode) => {
    expect(groupCodesToInaCBG([dx], [], 'RAWAT_JALAN').code).toBe(kode);
  });

  test('hemodialisis rawat jalan -> N-3-15-0 Prosedur Dialisis', () => {
    expect(groupCodesToInaCBG(['N18.5'], ['39.95'], 'RAWAT_JALAN').code).toBe('N-3-15-0');
  });

  test('komorbiditas menaikkan severity rawat inap', () => {
    expect(groupCodesToInaCBG(['K29.7', 'E11.9'], [], 'RAWAT_INAP').code).toBe('K-4-11-II');
  });

  test('tanpa pemetaan resmi -> null, bukan kode karangan', () => {
    expect(groupCodesToInaCBG(['P07.3'], [], 'RAWAT_INAP')).toBeNull();
    expect(groupCodesToInaCBG(['V01'], [], 'RAWAT_JALAN')).toBeNull();
    expect(groupCodesToInaCBG(['bukan-kode'], [], 'RAWAT_INAP')).toBeNull();
  });
});

describe('hitungInacbgDanTarif rawat jalan', () => {
  test('tarif terbaca walau kelas rawat kosong (tarif tunggal kelas D)', () => {
    const { inacbgCodeForLookup, tarifResult } = hitungInacbgDanTarif(['R10.4'], [], 'RAWAT_JALAN', '', null);
    expect(inacbgCodeForLookup).toBe('Q-5-25-0');
    expect(tarifResult.amount).toBe(getTarifResmi('Q-5-25-0', '').tarif);
    expect(tarifResult.amount).toBeGreaterThan(0);
  });
});

describe('usulan INA-CBG dari AI harus sesuai jenis klaim', () => {
  // Klaim rawat jalan EIFFELIN (R06.0;J45.3): AI mengusulkan J-4-13-I "Trauma
  // Dada" (rawat inap, Rp3.276.500) dan dulu langsung dipakai.
  test('kode rawat inap usulan AI ditolak untuk rawat jalan', () => {
    const { inacbgCodeForLookup } = hitungInacbgDanTarif(['R06.0', 'J45.3'], [], 'RAWAT_JALAN', '2', 'J-4-13-I');
    expect(inacbgCodeForLookup).toBe('Q-5-42-0');
  });

  test('kode rawat jalan usulan AI ditolak untuk rawat inap', () => {
    const { inacbgCodeForLookup } = hitungInacbgDanTarif(['J18.9'], [], 'RAWAT_INAP', '3', 'Q-5-38-0');
    expect(inacbgCodeForLookup).toBe('J-4-16-I');
  });

  test('usulan AI yang sesuai tetap dipakai', () => {
    const { inacbgCodeForLookup } = hitungInacbgDanTarif(['J18.9'], [], 'RAWAT_JALAN', '', 'Q-5-26-0');
    expect(inacbgCodeForLookup).toBe('Q-5-26-0');
  });
});
