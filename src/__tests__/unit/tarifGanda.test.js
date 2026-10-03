const { susunTarifGanda, hitungTarifIdrg, nbrIdrg } = require('../../services/tarifGandaService');
const { statusIdrg, padananInacbg, konversiKeIdrg, JUMLAH } = require('../../services/kamusIdrgService');

describe('rumus tarif iDRG = CW x NBR', () => {
  test('cocok dengan contoh respons E-Klaim (total CW 7,1976662 -> Rp 57.848.075)', () => {
    expect(hitungTarifIdrg(7.1976662361692, 'RAWAT_INAP').tarif).toBe(57848075);
  });
  test('NBR rancangan per jenis rawat, bisa ditimpa env', () => {
    expect(nbrIdrg('RAWAT_INAP')).toMatchObject({ nilai: 8037060, status: 'rancangan_kemenkes' });
    expect(nbrIdrg('RAWAT_JALAN').nilai).toBe(461474);
    process.env.IDRG_NBR_RANAP = '9000000';
    try { expect(nbrIdrg('RAWAT_INAP')).toMatchObject({ nilai: 9000000, status: 'dari_konfigurasi' }); } finally { delete process.env.IDRG_NBR_RANAP; }
  });
  test('tanpa cost weight tidak ada tarif yang ditebak', () => {
    expect(hitungTarifIdrg(null, 'RAWAT_INAP')).toBeNull();
    expect(hitungTarifIdrg(0, 'RAWAT_INAP')).toBeNull();
  });
});

describe('susunTarifGanda', () => {
  test('lembar grouper E-Klaim didahulukan atas data klaim; hitungan medaudit terpisah', () => {
    const r = susunTarifGanda(
      { jenis_klaim: 'RAWAT_INAP', diagnosa_list: 'I51.7', raw_data: { INACBG: 'X-0-00-I', TOTAL_TARIF: '1' } },
      {
        lembar_grouper: { inacbg: { kode: 'I-4-24-I', deskripsi: 'GANGGUAN', tarif: 2116600 }, total_tarif: 2116600, versi_eklaim: '5.10.6' },
        inacbg_result: { code: 'I-4-24-II' }, tariff_result: { amount: 4873800 },
      },
    );
    expect(r.inacbg.resmi).toMatchObject({ sumber: 'lembar_grouper_eklaim', kode: 'I-4-24-I', tarif: 2116600 });
    expect(r.inacbg.hitungan_medaudit).toMatchObject({ kode: 'I-4-24-II', tarif: 4873800 });
    expect(r.inacbg.cocok).toBe(false);
  });
  test('lembar iDRG (bila ada) memberi tarif resmi', () => {
    const r = susunTarifGanda({ jenis_klaim: 'RAWAT_INAP', raw_data: {} },
      { lembar_grouper_idrg: { drg: '1807119', total_cost_weight: 7.1976662361692, total_tarif: 57848075 } });
    expect(r.idrg).toMatchObject({ status: 'tersedia', drg: '1807119', tarif: 57848075 });
  });
  test('tanpa data INA-CBG sama sekali', () => {
    const r = susunTarifGanda({ jenis_klaim: 'RAWAT_JALAN', raw_data: '{}' }, {});
    expect(r.inacbg).toEqual({ resmi: null, hitungan_medaudit: null, cocok: null });
    expect(r.idrg.status).toBe('belum_dapat_dihitung');
    expect(r.idrg.alasan).toMatch(/grouper iDRG/);
  });
});

describe('kamus iDRG (IM)', () => {
  test('kamus termuat', () => {
    expect(JUMLAH.diagnosis).toBeGreaterThan(1000);
    expect(JUMLAH.prosedur).toBeGreaterThan(200);
  });
  test.each([
    ['J45.3', 'diagnosis', 'im'], ['S73.02', 'diagnosis', 'im'], ['36.050', 'prosedur', 'im'],
    ['S73.0', 'diagnosis', 'perlu_dipilih'], ['I51.7', 'diagnosis', 'sama'], ['89.52', 'prosedur', 'sama'],
    ['R10.84', 'diagnosis', 'tidak_dikenal'],
  ])('%s (%s) -> %s', (kode, jenis, status) => {
    expect(statusIdrg(kode, jenis).status).toBe(status);
  });
  test('padanan INA-CBG hanya kode akhir, judul kelompok tidak ditebak', () => {
    expect(padananInacbg('S73.02')).toBe('S73.0');
    expect(padananInacbg('J45.3')).toBeNull();
    expect(padananInacbg('36.050', 'prosedur')).toBeNull();
    expect(padananInacbg('04.420', 'prosedur')).toBe('04.42');
  });
  test('konversi membuang pengali jumlah tindakan dan mencatatnya', () => {
    const k = konversiKeIdrg('S73.0;E11.9', '86.28+2;81.53');
    expect(k.prosedur.map(p => p.kode)).toEqual(['86.28', '81.53']);
    expect(k.lengkap).toBe(false);
    expect(k.catatan.join(' ')).toMatch(/jumlah tindakan/);
  });
});
