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
    ['A09', 'K-4-17-I'], // gastroenteritis (resmi: A09 -> K-4-17, dulu heuristik K-4-16)
    ['J45.9', 'J-4-18-I'], // asma
    ['R10.4', 'K-4-17-I'], // nyeri abdomen (dulu R-4-18, tidak ada di PMK)
    ['S06.0', 'G-4-25-I'], // gegar otak
  ])('rawat inap %s -> %s', (dx, kode) => {
    expect(groupCodesToInaCBG([dx], [], 'RAWAT_INAP').code).toBe(kode);
  });

  test.each([
    ['R10.4', 'Q-5-25-0'],
    ['A09', 'Q-5-42-0'], // resmi (kolom Outpatient alt_diagnosis)
    ['J45.9', 'Q-5-44-0'], // resmi (dulu heuristik Q-5-26)
    ['I10', 'Q-5-44-0'],
    ['Z09.8', 'Q-5-44-0'], // resmi (dulu heuristik Q-5-18)
  ])('rawat jalan %s -> kode ambulatori %s', (dx, kode) => {
    expect(groupCodesToInaCBG([dx], [], 'RAWAT_JALAN').code).toBe(kode);
  });

  test('hemodialisis rawat jalan -> N-3-15-0 Prosedur Dialisis', () => {
    expect(groupCodesToInaCBG(['N18.5'], ['39.95'], 'RAWAT_JALAN').code).toBe('N-3-15-0');
  });

  test('CC tidak sendiri menentukan tingkat II tanpa matriks kelompok', () => {
    expect(groupCodesToInaCBG(['K29.7', 'E11.9'], [], 'RAWAT_INAP')).toMatchObject({ code: 'K-4-11-I', severity_status: 'belum_terverifikasi', cc_potensial: ['E119'] });
  });

  test('tanpa pemetaan resmi -> null, bukan kode karangan', () => {
    // U09.9 (kondisi pasca COVID-19) belum ada di tabel resmi alt_diagnosis
    // maupun heuristik -> null. (P07.3 kini terpetakan resmi ke P-8-17, lihat
    // tes di bawah, jadi bukan lagi contoh "tak terpetakan".)
    expect(groupCodesToInaCBG(['U09.9'], [], 'RAWAT_INAP')).toBeNull();
    expect(groupCodesToInaCBG(['V01'], [], 'RAWAT_JALAN')).toBeNull();
    expect(groupCodesToInaCBG(['bukan-kode'], [], 'RAWAT_INAP')).toBeNull();
  });

  test('base CBG kini dari tabel resmi E-Klaim (alt_diagnosis/alt_procedures)', () => {
    // P07.3 (bayi prematur) -> P-8-17 di tabel resmi; dulu heuristik tak punya
    // bab P sehingga tanpa tarif.
    expect(groupCodesToInaCBG(['P07.3'], [], 'RAWAT_INAP').code).toBe('P-8-17-I');
    // A09 (diare) -> K-4-17 (resmi), bukan K-4-16 (tebakan heuristik lama).
    expect(groupCodesToInaCBG(['A09'], [], 'RAWAT_INAP').code).toBe('K-4-17-I');
  });
});

describe('hitungInacbgDanTarif rawat jalan', () => {
  test('tarif terbaca walau kelas rawat kosong (tarif tunggal kelas D)', () => {
    const { inacbgCodeForLookup, tarifResult } = hitungInacbgDanTarif(['R10.4'], [], 'RAWAT_JALAN', '', null);
    expect(inacbgCodeForLookup).toBe('Q-5-25-0');
    expect(tarifResult.amount).toBe(getTarifResmi('Q-5-25-0', '').tarif);
    expect(tarifResult.amount).toBeGreaterThan(0);
  });
  test('kelompok OP tetap perkiraan; label dan kandidat tidak menyebut severity rawat inap', () => {
    const { inacbgResult, tarifResult } = hitungInacbgDanTarif(['R57.0'], ['93.96', '99.60'], 'RAWAT_JALAN', 3, 'J-3-13-0');
    expect(inacbgResult).toMatchObject({ code: 'I-3-10-0', grouper_resmi: false, base_perlu_verifikasi: true, versi_perkiraan: '2026-10-07.1' });
    expect(inacbgResult.kandidat_base.map(c => c.base)).toEqual(['I-3-10', 'J-3-13']);
    expect(inacbgResult.usulan_ai_ditahan).toBe('J-3-13-0');
    expect(tarifResult).toMatchObject({ perlu_verifikasi_grouper: true, amount: 893100 });
    expect(tarifResult.note).not.toMatch(/tingkat I/);
  });
});

describe('usulan INA-CBG dari AI harus sesuai jenis klaim', () => {
  // Klaim rawat jalan EIFFELIN (R06.0;J45.3): AI mengusulkan J-4-13-I "Trauma
  // Dada" (rawat inap, Rp3.276.500) dan dulu langsung dipakai.
  test('kode rawat inap usulan AI ditolak untuk rawat jalan', () => {
    const { inacbgCodeForLookup } = hitungInacbgDanTarif(['R06.0', 'J45.3'], [], 'RAWAT_JALAN', '2', 'J-4-13-I');
    // R06.0 -> Q-5-44 (kolom Outpatient tabel resmi alt_diagnosis).
    expect(inacbgCodeForLookup).toBe('Q-5-44-0');
  });

  test('kode rawat jalan usulan AI ditolak untuk rawat inap', () => {
    const { inacbgCodeForLookup } = hitungInacbgDanTarif(['J18.9'], [], 'RAWAT_INAP', '3', 'Q-5-38-0');
    expect(inacbgCodeForLookup).toBe('J-4-16-I');
  });

  test('kode AI yang ada di tarif tetap tidak mengganti pemetaan dari diagnosis', () => {
    const { inacbgCodeForLookup, inacbgResult } = hitungInacbgDanTarif(['J18.9'], [], 'RAWAT_JALAN', '', 'Q-5-26-0');
    expect(inacbgCodeForLookup).toBe('Q-5-38-0');
    expect(inacbgResult.usulan_ai_ditahan).toBe('Q-5-26-0');
  });
});

describe('severity hanya dari diagnosis sekunder, bukan prosedur', () => {
  // PASIEN CONTOH A (0000R0000126V000001): casemix I51.7 + 90.59;89.52;87.44 -> I-4-24-I.
  test('prosedur penunjang tidak menaikkan severity', () => {
    expect(groupCodesToInaCBG(['I51.7'], ['90.59', '89.52', '87.44'], 'RAWAT_INAP').code).toBe('I-4-24-I');
  });
  test('diagnosis sekunder tetap tercatat, tingkat II/III hanya skenario sampai ada grouper resmi', () => {
    const r = groupCodesToInaCBG(['I51.7', 'J81', 'E11.9'], ['87.44'], 'RAWAT_INAP');
    expect(r).toMatchObject({ code: 'I-4-24-I', severity_status: 'belum_terverifikasi' });
    expect(r.cc_potensial).toEqual(expect.arrayContaining(['J81', 'E119']));
    expect(r.skenario_severity).toEqual(['I-4-24-I', 'I-4-24-II', 'I-4-24-III']);
  });
});

test('perhitungan menahan usulan AI tingkat III dan menyediakan tarif skenario berkelas sama', () => {
  const r = hitungInacbgDanTarif(['I63.9', 'N18.5', 'E16.2'], ['39.95'], 'RAWAT_INAP', '1', 'G-4-14-III');
  expect(r.inacbgResult).toMatchObject({ code: 'G-4-14-I', grouper_resmi: false, severity_estimasi: true });
  expect(r.tarifResult).toMatchObject({ amount: 4683200, perlu_verifikasi_grouper: true });
  expect(r.tarifResult.skenario_severity).toEqual(['I', 'II', 'III'].map(s => ({code:`G-4-14-${s}`,severity:s,amount:getTarifResmi(`G-4-14-${s}`,'1').tarif})));
});

test('kode tarif valid dari AI tidak menghasilkan grouper bila diagnosis tidak terpetakan', () => {
  expect(hitungInacbgDanTarif(['U09.9'], [], 'RAWAT_INAP', '3', 'J-4-16-I')).toMatchObject({ inacbgResult: null, tarifResult: null });
});

test('debridemen tanpa pemetaan bedah rawat inap tidak mengganti kelompok diagnosis; eksisi nyata tetap kelompok bedah', () => {
  expect(groupCodesToInaCBG(['E11.5'], ['86.22'], 'RAWAT_INAP').code).toBe('I-4-15-I');
  expect(groupCodesToInaCBG(['L02.3'], ['86.22'], 'RAWAT_INAP').code).toBe('L-4-12-I');
  expect(groupCodesToInaCBG(['D17.1'], ['86.3'], 'RAWAT_INAP').code).toBe('L-1-40-I');
});
