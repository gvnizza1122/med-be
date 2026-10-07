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
    expect(r.inacbg.hitungan_medaudit).toMatchObject({ kode: 'I-4-24-I', tarif: 2116600, perlu_verifikasi_grouper: true });
    expect(r.inacbg.cocok).toBe(true);
  });
  test('lembar iDRG (bila ada) memberi tarif resmi', () => {
    const r = susunTarifGanda({ jenis_klaim: 'RAWAT_INAP', raw_data: {} },
      { lembar_grouper_idrg: { drg: '1807119', total_cost_weight: 7.1976662361692, total_tarif: 57848075 } });
    expect(r.idrg).toMatchObject({ status: 'tersedia', drg: '1807119', tarif: 57848075 });
  });
  test('tanpa data INA-CBG sama sekali', () => {
    const r = susunTarifGanda({ jenis_klaim: 'RAWAT_JALAN', raw_data: '{}' }, {});
    expect(r.inacbg).toEqual({ resmi: null, hitungan_medaudit: null, perkiraan_klaim: null, cocok: null });
    expect(r.idrg.status).toBe('belum_dapat_dihitung');
    expect(r.idrg.alasan).toMatch(/grouper iDRG/);
  });
  test('kode/prosedur terkini mengganti perkiraan lama tanpa mengikuti hasil pembanding', () => {
    const rec={jenis_klaim:'RAWAT_JALAN',diagnosa_list:'J45.9',prosedur_list:'93.94',raw_data:{INACBG:'Q-5-44-0',TARIF_INACBG:192400}};
    const ai={inacbg_result:{code:'Q-5-44-0'},tariff_result:{amount:192400}};
    const before=JSON.stringify({rec,ai});
    const r=susunTarifGanda(rec,ai);
    expect(r.inacbg.resmi.kode).toBe('Q-5-44-0');
    expect(r.inacbg.hitungan_medaudit).toMatchObject({kode:'J-3-13-0',tarif:321700});
    expect(r.inacbg.cocok).toBe(false);
    expect(JSON.stringify({rec,ai})).toBe(before);
  });
  test('ekspor MIX membaca kode, tarif, CW dan NBR iDRG tanpa memakai NBR rancangan',()=>{
    const r=susunTarifGanda({jenis_klaim:'RAWAT_JALAN',raw_data:{IDRG_DRG_CODE:'1234567',IDRG_DRG_DESCRIPTION:'contoh',
      IDRG_TOTAL_COST_WEIGHT:'0.5',IDRG_NBR:'500000',IDRG_TOTAL_TARIF:'250000',IDRG_GROUPER_VERSION:'contoh-uji'}},{});
    expect(r.idrg).toMatchObject({sumber:'data_klaim',drg:'1234567',cost_weight:0.5,tarif:250000,verifikasi_rumus:true,
      nbr:{nilai:500000,status:'dari_ekspor_eklaim'}});
  });
  test('selisih rumus iDRG tidak ditutupi dan NBR kosong tidak diganti rancangan',()=>{
    const raw={IDRG_DRG_CODE:'1234567',IDRG_TOTAL_COST_WEIGHT:'0,5',IDRG_NBR:'500000',IDRG_TOTAL_TARIF:'240000'};
    expect(susunTarifGanda({jenis_klaim:'RAWAT_JALAN',raw_data:raw},{}).idrg.verifikasi_rumus).toBe(false);
    expect(susunTarifGanda({jenis_klaim:'RAWAT_JALAN',raw_data:{...raw,IDRG_NBR:''}},{}).idrg.nbr)
      .toMatchObject({nilai:null,status:'tidak_tersedia'});
  });
});

describe('kamus iDRG (IM)', () => {
  test('kamus termuat', () => {
    expect(JUMLAH.diagnosis).toBeGreaterThan(1000);
    expect(JUMLAH.prosedur).toBeGreaterThan(200);
  });
  test.each([
    ['J45.3', 'diagnosis', 'im'], ['S73.02', 'diagnosis', 'im'], ['36.050', 'prosedur', 'im'],
    ['S73.0', 'diagnosis', 'perlu_verifikasi'], ['I51.7', 'diagnosis', 'sama'], ['89.52', 'prosedur', 'sama'],
    ['R10.84', 'diagnosis', 'tidak_dikenal'],
  ])('%s (%s) -> %s', (kode, jenis, status) => {
    expect(statusIdrg(kode, jenis).status).toBe(status);
  });
  test('padanan INA-CBG tidak ditebak dengan memotong kode IM', () => {
    expect(padananInacbg('S73.02')).toBeNull();
    expect(padananInacbg('J45.3')).toBeNull();
    expect(padananInacbg('36.050', 'prosedur')).toBeNull();
    expect(padananInacbg('04.420', 'prosedur')).toBeNull();
    expect(padananInacbg('57.940', 'prosedur')).toBeNull();
    expect(padananInacbg('57.94', 'prosedur')).toBe('57.94');
  });
  test('konversi membuang pengali jumlah tindakan dan mencatatnya', () => {
    const k = konversiKeIdrg('S73.0;E11.9', '86.28+2;81.53');
    expect(k.prosedur.map(p => p.kode)).toEqual(['86.28', '81.53']);
    expect(k.lengkap).toBe(false);
    expect(k.catatan.join(' ')).toMatch(/jumlah tindakan/);
  });
});

 test.each([['R33','diagnosis'],['88.76','prosedur'],['57.94','prosedur']])('%s tidak dikonversi ke entri yang hanya memiliki awalan serupa',(kode,jenis)=>{
   expect(statusIdrg(kode,jenis)).toMatchObject({kode,status:'perlu_verifikasi',kode_idrg:null,kandidat:[]});
 });
 test('CW saja pada lembar tidak dihitung dengan NBR rancangan',()=>{
   const idrg=susunTarifGanda({jenis_klaim:'RAWAT_INAP',raw_data:{}},{lembar_grouper_idrg:{drg:'contoh',total_cost_weight:0.5}}).idrg;
   expect(idrg).toMatchObject({status:'belum_dapat_dihitung',cost_weight:0.5,tarif:null,nbr:{nilai:null,status:'tidak_tersedia'}});
 });
 test('tarif lembar dihitung hanya bila NBR lembar tersedia dan selisih tidak ditutupi',()=>{
   const rec={jenis_klaim:'RAWAT_INAP',raw_data:{}};
   const lembar={drg:'contoh',total_cost_weight:0.5,nbr:500000};
   expect(susunTarifGanda(rec,{lembar_grouper_idrg:lembar}).idrg).toMatchObject({status:'tersedia',tarif:250000,nbr:{nilai:500000,status:'dari_lembar_eklaim'}});
   expect(susunTarifGanda(rec,{lembar_grouper_idrg:{...lembar,total_tarif:240000}}).idrg.verifikasi_rumus).toBe(false);
 });

test('perkiraan klaim L02.1 tersedia mandiri tanpa hasil E-Klaim',()=>{
  const r=susunTarifGanda({jenis_klaim:'RAWAT_INAP',diagnosa_list:'L02.1',kelas_rawat:'3',raw_data:{KELAS_RAWAT:'3'}},{});
  expect(r.inacbg.resmi).toBeNull();
  expect(r.inacbg.perkiraan_klaim).toMatchObject({label:'Perkiraan klaim kasus ini',kode:'L-4-12-I',tarif:1433000,status:'tersedia'});
  expect(r.inacbg.perkiraan_klaim.keterangan).toMatch(/acuan sementara/);
});
test('pembanding E-Klaim tidak mengganti perkiraan kasus',()=>{
  const r=susunTarifGanda({jenis_klaim:'RAWAT_INAP',diagnosa_list:'L02.1',raw_data:{KELAS_RAWAT:'3',INACBG:'L-4-12-II',TOTAL_TARIF:999}},{});
  expect(r.inacbg.perkiraan_klaim).toMatchObject({kode:'L-4-12-I',tarif:1433000});
  expect(r.inacbg.resmi).toMatchObject({kode:'L-4-12-II',tarif:999});expect(r.inacbg.cocok).toBe(false);
});
