const { rentangBulan, ringkasanBulanan, gabung, bulanKini, biayaBerkas } = require('../../services/penggunaanAiService');
const konteks = require('../../services/konteksPenggunaanAiService');
const catatan = require('../../services/catatanPanggilanModelService');

test('rentang mengikuti WIB, termasuk pergantian tahun dan tahun kabisat', () => {
  expect(rentangBulan('2026-01')).toEqual(['2025-12-31 17:00:00', '2026-01-31 17:00:00']);
  expect(rentangBulan('2024-02')).toEqual(['2024-01-31 17:00:00', '2024-02-29 17:00:00']);
  expect(rentangBulan('2026-12')).toEqual(['2026-11-30 17:00:00', '2026-12-31 17:00:00']);
});
test.each(['2026-00', '2026-13', '2026-2', '2026-01 OR 1=1', ['2026-01'], ''])('menolak bulan tidak valid %s', bulan => {
  expect(() => rentangBulan(bulan)).toThrow('Pilih bulan');
});
test('bulan saat ini menggunakan Jakarta saat UTC masih bulan sebelumnya', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-30T18:00:00Z'));
  expect(bulanKini()).toBe('2026-10');
  jest.useRealTimers();
});
const row = (extra = {}) => ({ day: '2026-10-02', model: 'gpt-6.1-sol', provider: 'openai_compat', effort: 'high', task: 'tinjau_kasus_lanjutan', claim_type: 'RAWAT_INAP',
  calls: '1', failed_calls: '0', measured_calls: '1', priced_calls: '1', input_tokens: '200', output_tokens: '100', total_tokens: '300', cached_tokens: '100', reasoning_tokens: '75', estimated_usd: .00121, estimated_idr: 21.78, ...extra });
test('token cache dan reasoning bukan token tambahan; kegagalan berbiaya tetap masuk', async () => {
  const db = { all: jest.fn(async () => [row(), row({ failed_calls: '1', estimated_idr: 24.2 })]) };
  const hasil = await ringkasanBulanan(db, 'RS-A', '2026-10');
  expect(hasil.summary).toMatchObject({ calls: 2, failed_calls: 1, total_tokens: 600, input_tokens: 400, output_tokens: 200, cached_tokens: 200, reasoning_tokens: 150, unmeasured_calls: 0 });
  expect(hasil.summary.estimated_usd).toBeCloseTo(.00242);
  // Nilai historis rupiah dijumlahkan, tidak dihitung ulang memakai kurs baru.
  expect(hasil.summary.estimated_idr).toBeCloseTo(45.98);
  expect(hasil.models).toHaveLength(1);
  expect(hasil.days).toHaveLength(1);
  expect(db.all.mock.calls[0][0]).toContain('WHERE hospital_code = ?');
  expect(db.all.mock.calls[0][1]).toEqual(['RS-A', '2026-09-30 17:00:00', '2026-10-31 17:00:00']);
});
test('catatan lama tidak dibuat seolah memiliki estimasi nol', () => {
  const old = row({ calls: 5, measured_calls: 0, priced_calls: 0, total_tokens: null, input_tokens: null, output_tokens: null, cached_tokens: null, reasoning_tokens: null, estimated_usd: null, estimated_idr: null });
  expect(gabung([old])).toMatchObject({ unmeasured_calls: 5, unpriced_calls: 5, estimated_usd: null, estimated_idr: null });
  expect(gabung([old, row()])).toMatchObject({ calls: 6, total_tokens: 300, unmeasured_calls: 5, unpriced_calls: 5, estimated_idr: 21.78 });
  expect(gabung([])).toMatchObject({ calls: 0, total_tokens: 0, estimated_idr: 0 });
});
test('akun tanpa rumah sakit tidak memperoleh ringkasan global', async () => {
  const db = { all: jest.fn() };
  await expect(ringkasanBulanan(db, null, '2026-10')).rejects.toMatchObject({ status: 403 });
  expect(db.all).not.toHaveBeenCalled();
});
test('konteks rumah sakit tetap terpisah dalam dua pekerjaan bersamaan', async () => {
  const results = await Promise.all(['RS-A', 'RS-B'].map(hospital_code => konteks.jalankan({ hospital_code }, async () => {
    await new Promise(resolve => setTimeout(resolve, hospital_code === 'RS-A' ? 10 : 1));
    return konteks.saatIni().hospital_code;
  })));
  expect(results).toEqual(['RS-A', 'RS-B']);
  expect(konteks.saatIni()).toEqual({});
});
test('worker memperoleh rumah sakit dari record tersimpan tanpa mempercayai isi berkas', async () => {
  const db = { get: jest.fn(async () => ({ hospital_code: 'RS-B', jenis_klaim: 'RAWAT_INAP' })) };
  await konteks.untukRecord(db, { id: 'rec', hospital_code: 'RS-PALSU' }, () => {
    expect(konteks.saatIni()).toMatchObject({ hospital_code: 'RS-B', record_id: 'rec', jenis_klaim: 'RAWAT_INAP' });
  });
  expect(db.get.mock.calls[0][1]).toEqual(['rec']);
});
test('catatan hanya menyimpan metadata token dan rumah sakit, tanpa prompt/pasien', async () => {
  const db = { run: jest.fn(async () => ({})) };
  expect(await catatan.catat(db, { tugas: 'baca_berkas', ok: false, hospital_code: 'RS-A', record_id: 'rec', penggunaan: { total_tokens: 123 }, prompt: 'RAHASIA', nama_pasien: 'RAHASIA' })).toBe(true);
  const [sql, params] = db.run.mock.calls[0];
  expect(sql).toContain("timezone('UTC', CURRENT_TIMESTAMP)");
  expect(params.slice(-4)).toEqual([123, 'RS-A', 'rec',null]);
  expect(params).not.toContain('RAHASIA');
});

test('biaya per berkas dibatasi RS dan dipaginasi tanpa mengubah catatan biaya',async()=>{
 const db={all:jest.fn(async()=>[{file_id:'f',file_name:'simulasi.pdf',calls:'3',priced_calls:'2',total_tokens:'1000',estimated_idr:'216',total_files:'30',target_idr:'500',batas_idr:'600',terpakai_idr:'250',dicadangkan_idr:'5',belum_pasti_idr:'7',gagal_idr:'10',tambahan_alasan:[]}])};
 const r=await biayaBerkas(db,'RS-A','2026-10',2);
 expect(r).toMatchObject({page:2,page_size:25,total_files:30,files:[{file_id:'f',calls:3,priced_calls:2,estimated_idr:216,budget:{terpakai_idr:250,dicadangkan_idr:5,belum_pasti_idr:7,gagal_idr:10}}]});
 expect(db.all.mock.calls[0][1]).toEqual(['RS-A','2026-09-30 17:00:00','2026-10-31 17:00:00','RS-A','2026-09-30 17:00:00','2026-10-31 17:00:00',25,25]);
});
test('biaya lama tanpa estimasi dan tanpa anggaran tidak dianggap gratis',async()=>{
 const db={all:async()=>[{file_id:'f',file_name:'simulasi.pdf',calls:2,priced_calls:0,total_tokens:null,estimated_idr:null,total_files:1}]};
 expect((await biayaBerkas(db,'RS','2026-10')).files[0]).toMatchObject({estimated_idr:null,budget:null,total_tokens:null});
});
test('biaya berkas tidak membuka scope global untuk akun tanpa RS',async()=>{
 const db={all:jest.fn()};await expect(biayaBerkas(db,null,'2026-10')).rejects.toMatchObject({status:403});expect(db.all).not.toHaveBeenCalled();
});
test.each([0,-1,'x','1 OR 1=1',100001])('paginasi biaya menolak %s',async page=>{
 const db={all:jest.fn()};await expect(biayaBerkas(db,'RS','2026-10',page)).rejects.toMatchObject({status:400});expect(db.all).not.toHaveBeenCalled();
});
