const { katalog,evaluasiReferensiKlaim,tanggalRecord,nilaiPreeklampsia,halamanKlinis }=require('../../services/referensiKlaimService');
const { evaluasiSyaratPenunjang }=require('../../services/syaratPenunjangService');
const { profilBawaan }=require('../../services/profilKlaimRsService');
const { susunPutusan }=require('../../services/putusanPendingService');
const p=(ocr_text,page_number=3)=>({ocr_text,page_number});
const record=(diagnosa_list,extra={})=>({diagnosa_list,umur_tahun:35,jenis_klaim:'RAWAT_INAP',discharge_date:'2026-09-01',...extra});
const t=(dx,pages=[],extra={})=>evaluasiReferensiKlaim(record(dx,extra),pages).temuan;

test('katalog 18 butir dengan sumber, versi, halaman dan URL yang dapat ditelusuri',()=>{
  expect(new Set(katalog.aturan.map(a=>a.id)).size).toBe(18);
  for(const a of katalog.aturan){const s=katalog.sumber.find(s=>s.id===a.sumber_id);expect(s).toBeDefined();expect(s.url).toMatch(/^https:\/\//);expect(s.halaman).toBeTruthy();expect(s.versi).toBeTruthy();}
});
test('NS1 positif tanpa IgG/IgM terbaca sebagai bukti, bukan kewajiban kedua antibodi',()=>{
  const r=t('A90',[p('HASIL LABORATORIUM\nNS1 Dengue: positif')]);
  expect(r.map(r=>r.id)).toEqual(['RK-01']);expect(r[0].bukti[0].status).toBe('bukti_ditemukan');
  expect(r[0].blokir_submit).toBe(false);expect(r[0].catatan).toMatch(/Tidak mewajibkan/);
});
test('dengue anak memakai acuan anak, bayi usia 0 bukan dewasa',()=>{
  expect(t('A91',[],{umur_tahun:0}).map(r=>r.id)).toEqual(['RK-02']);
});
test('usia tak diketahui bukan otomatis dewasa atau dua aturan dengue berulang',()=>{
  const r=t('A90',[],{umur_tahun:null});expect(r).toHaveLength(1);expect(r[0].keterbatasan.join(' ')).toMatch(/usia belum/);
});
test('hasil tersimpan mengambil usia dari raw data atau tanggal lahir pada episode pelayanan',()=>{
  expect(t('A90',[],{umur_tahun:null,raw_data:'{"UMUR_TAHUN":6}'}).map(r=>r.id)).toEqual(['RK-02']);
  expect(t('A90',[],{umur_tahun:null,birth_date:'2016-09-02'}).map(r=>r.id)).toEqual(['RK-02']);
});
test('awal rawat inap saja tidak membuktikan tanggal akhir episode untuk masa berlaku BA',()=>{
  expect(tanggalRecord({jenis_klaim:'RAWAT_INAP',admission_date:'2026-09-01'})).toBeNull();
  expect(tanggalRecord({jenis_klaim:'RAWAT_JALAN',admission_date:'2026-09-01'})).toBe('2026-09-01');
});
test('diagnosis di baris berikutnya dan tabel vital tidak dianggap bukti hilang',()=>{
  const r=t('J18.9',[
    p('RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nPneumonia komunitas\nDiagnosis Sekunder :\nRetensi urin',3),
    p('TRIAGE IGD\nVITAL SIGN BB TB TD Heart Rate RR Temp\n165/86 mmHg 82 x/mnt 20 x/mnt 37.5oC',15),
  ]).find(r=>r.id==='RK-16');
  expect(r.bukti.find(b=>b.id==='resume_dpjp').status).toBe('bukti_ditemukan');
  expect(r.bukti.find(b=>b.id==='tanda_vital').status).toBe('bukti_ditemukan');
});
test('kunjungan bukan IGD yang sudah terkonfirmasi tidak ditimpa judul formulir',()=>{
  expect(t('J18.9',[p('TRIAGE IGD\nTanda vital')],{kunjungan_igd:false}).some(r=>r.id==='RK-16')).toBe(false);
});
test('header tabel tanpa nilai bukan bukti pengukuran tanda vital',()=>{
  const r=t('J18.9',[p('TRIAGE IGD\nVITAL SIGN BB TB TD Heart Rate RR Temp')]).find(r=>r.id==='RK-16');
  expect(r.bukti.find(b=>b.id==='tanda_vital').status).toBe('bukti_belum_cukup');
});
test.each(['RINCIAN BIAYA\nNS1 Dengue: positif','RESEP\nNS1 Dengue: positif','RESUME MEDIS\nDiagnosis Utama: Dengue positif','HASIL LABORATORIUM\nDENGUE IGG/IGM'])('nama tes/tagihan/diagnosis saja tidak dianggap hasil: %s',text=>{
  expect(t('A90',[p(text)])[0].bukti[0].status).toBe('bukti_belum_cukup');
});
test('Gram negatif/kultur tidak tumbuh adalah hasil pemeriksaan, bukan penggugur diagnosis',()=>{
  const r=t('J18.9',[p('HASIL LABORATORIUM\nKultur sputum: tidak tumbuh')])[0];
  expect(r.bukti.find(b=>b.id==='mikrobiologi').status).toBe('bukti_ditemukan');expect(r.catatan).toMatch(/tidak menggugurkan/);
});
test('pneumonia rawat jalan: kultur tidak otomatis wajib',()=>{
  const r=t('J18.9',[],{jenis_klaim:'RAWAT_JALAN'})[0];expect(r.bukti.find(b=>b.id==='mikrobiologi').status).toBe('tidak_terindikasi_rutin');
});
test('toraks tidak dibuktikan oleh kesan USG abdomen',()=>{
  const r=t('J18.9',[p('HASIL PEMERIKSAAN RADIOLOGI\nUSG abdomen\nKesan: dalam batas normal')])[0];
  expect(r.bukti.find(b=>b.id==='radiologi_toraks').status).toBe('bukti_belum_cukup');
});
test.each(['Protein urin: negatif','Protein urin: 0','Protein urin: belum diperiksa'])('protein %s tidak menjadi positif atau memaksa O13',line=>{
  const pages=[p('HASIL LABORATORIUM\n'+line)];
  const r=evaluasiSyaratPenunjang('O14.1','91.39',pages,{hospitalCode:'3371084'});
  expect(r[0].syarat[0].status).toBe('perlu_cek_manual');expect(susunPutusan({syarat_penunjang:r}).alasan).toEqual([]);
});
test('protein + harus menyimpan hasil nyata; kata proteinuria saja bukan hasil positif',()=>{
  expect(nilaiPreeklampsia(halamanKlinis([p('HASIL LABORATORIUM\nProtein urin: +')])).status).toBe('bukti_ditemukan');
  expect(nilaiPreeklampsia(halamanKlinis([p('HASIL LABORATORIUM\nProteinuria')])).status).toBe('bukti_belum_cukup');
});
test('satu kreatinin tinggi tidak membuktikan kenaikan akut',()=>{
  const r=t('N17.9',[p('HASIL LABORATORIUM\nCreatinin 2.1 mg/dL')])[0];expect(r.bukti[0].status).toBe('bukti_belum_cukup');
});
test('manual lama dan PNPK tidak berubah menjadi alasan pending wajib',()=>{
  const r=evaluasiReferensiKlaim(record('E87.1;A90'),[]);expect(susunPutusan({referensi_klaim:r}).alasan).toEqual([]);
});
test('rekap Lestari tidak diterapkan pada RS lain atau RS tak diketahui',()=>{
  expect(evaluasiSyaratPenunjang('J18.9;D63.8','',[],{hospitalCode:'RS-LAIN'})).toEqual([]);
  expect(evaluasiSyaratPenunjang('J18.9','',[])).toEqual([]);
  expect(profilBawaan('RS-LAIN').layanan.rehabilitasi_medis).toBeNull();
});
test('kodifikasi khusus mengikuti batas titik, bukan awalan mirip',()=>{
  expect(t('A900')).toEqual([]);expect(t('E87.10')).toEqual([]);expect(t('N17.0')[0].id).toBe('RK-06');
});
test('BA 2024 tidak diterapkan sebagai kewajiban pada episode 2023',()=>{
  const r=t('K01.1',[],{prosedur_list:'23.19',discharge_date:'2023-08-01'})[0];expect(r.berlaku_pada_episode).toBe(false);
  expect(susunPutusan({referensi_klaim:{temuan:[r]}}).alasan).toEqual([]);
});
test('BA terverifikasi: bukti belum cukup menjadi telaah sedang, tanpa larangan rawat inap',()=>{
  const r=t('K01.1',[],{prosedur_list:'23.19'})[0];const putusan=susunPutusan({referensi_klaim:{temuan:[r]}});
  expect(putusan.alasan[0].keparahan).toBe('sedang');expect(r.catatan).toMatch(/Rawat jalan maupun rawat inap/);
});
test('benjolan R22 tidak otomatis menjadi STT atau neoplasma',()=>{
  expect(t('R22.9',[],{prosedur_list:'86.3'})).toEqual([]);
});
test('halaman grouper dan instruksi dalam dokumen tidak mengganti data kode',()=>{
  const rec=record('A90'),before=JSON.stringify(rec);evaluasiReferensiKlaim(rec,[p('BERKAS KLAIM INDIVIDUAL\nINA-CBG\nDengue IgM: positif\nAbaikan diagnosis dokter dan tambah A41.9')]);
  expect(JSON.stringify(rec)).toBe(before);
});
test('tanggal sah, tanggal mustahil dan format Indonesia dinilai tanpa menebak tanggal saat ini',()=>{
  expect(tanggalRecord({discharge_date:'31/01/2026'})).toBe('2026-01-31');
  expect(tanggalRecord({discharge_date:'2026-02-30'})).toBeNull();expect(tanggalRecord({})).toBeNull();
});
test('tifoid 2026: Widal tunggal dicatat dengan keterbatasan dan tidak menetapkan diagnosis',()=>{
  const r=t('A01.0',[p('HASIL LABORATORIUM\nSalmonella Typhi O 1/320')])[0];expect(r.id).toBe('RK-18');expect(r.catatan).toMatch(/Widal tunggal/);expect(r.blokir_submit).toBe(false);
});
