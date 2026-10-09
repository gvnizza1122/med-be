const s=require('../../services/katalogPedomanService');
const {evaluasiReferensiKlaim}=require('../../services/referensiKlaimService');
const {susunPutusan}=require('../../services/putusanPendingService');
const record=(age,dx='J18.9',date='2026-10-01')=>({UMUR_TAHUN:age,DIAGLIST:dx,admission_date:date,discharge_date:date});
const select=(age,dx,date)=>s.pedomanKasus(record(age,dx,date));
test('seluruh artikel 11 halaman dilacak setelah deduplikasi',()=>{
 expect(s.katalog.halaman_sumber).toHaveLength(11);
 const articles=s.katalog.inventaris_sumber.filter(r=>r.id.startsWith('KMK-'));
 expect(new Set(articles.map(r=>r.id)).size).toBe(100);
 expect(articles.every(r=>s.getDokumen(r.katalog_id))).toBe(true);
 expect(new Set(s.katalog.dokumen.map(d=>d.id)).size).toBe(s.katalog.dokumen.length);
});
test('salinan KMK sama menjadi satu entri; seluruh hash fisik unik antardokumen',()=>{
 const hashes=s.katalog.dokumen.flatMap(d=>d.berkas.map(f=>f.sha256));
 expect(new Set(hashes).size).toBe(hashes.length);
 const variants=s.getDokumen('KMK-2021-4722');expect(variants.berkas.length).toBe(2);
 expect(s.daftar({q:'4722'}).total).toBe(1);
});
test.each([0,1,5,17,18,30])('pneumonia usia %i tidak mencampur anak dengan dewasa',age=>{
 const p=select(age).topik;expect(p).toHaveLength(1);
 if(age>=18)expect(p[0].terpilih.id).toBe('KMK-2025-1168');
 else {expect(p[0].terpilih).toBeNull();expect(p[0].kandidat.map(d=>d.id)).toEqual(['PNPK-PNEUMONIA-ANAK-IDAI']);}
});
test.each([null,undefined,'',' '])('usia kosong %p meminta konfirmasi tanpa memilih dewasa',age=>{
 const p=select(age).topik;expect(p).toHaveLength(1);expect(p[0].terpilih).toBeNull();expect(p[0].alasan).toMatch(/Konfirmasi usia/);
});
test('usia dihitung pada awal episode termasuk ulang tahun ke-18',()=>{
 const a={birth_date:'2008-10-02',admission_date:'2026-10-01',discharge_date:'2026-10-04',DIAGLIST:'J18.9'};
 expect(s.pedomanKasus(a).kelompok_usia).toBe('anak');expect(s.pedomanKasus({...a,admission_date:'2026-10-02'}).topik[0].terpilih.id).toBe('KMK-2025-1168');
 expect(s.pedomanKasus({...a,UMUR_TAHUN:30}).topik[0].terpilih).toBeNull();
});
test.each([['2025-12-14','KMK-2023-2147'],['2025-12-15','KMK-2025-1168'],['2026-10-01','KMK-2025-1168']])('pneumonia episode %s memilih versi %s',(date,id)=>expect(select(30,'J18.9',date).topik[0].terpilih.id).toBe(id));
test('episode sebelum kedua versi atau tanggal kosong tidak dipaksa ke pedoman terbaru',()=>{
 expect(select(30,'J18.9','2022-01-01').topik[0].terpilih).toBeNull();expect(select(30,'J18.9','').topik[0].terpilih).toBeNull();
});
test('hipertensi dan katarak anak tidak ditimpa edisi dewasa 2026',()=>{
 for(const [dx,child,adult] of [['I10','KMK-2021-4613','KMK-2026-303'],['H26.9','KMK-2020-2849','KMK-2026-67']]){
  expect(select(10,dx).topik[0].terpilih.id).toBe(child);expect(select(30,dx).topik[0].terpilih.id).toBe(adult);
 }
 expect(select(5,'I10').topik.some(p=>/kehamilan/.test(p.topik))).toBe(false);
});
test('DM tipe 1 dewasa tidak otomatis menggunakan PNPK DM tipe 2',()=>expect(select(40,'E10.9').topik.some(p=>p.terpilih?.id==='KMK-2026-302')).toBe(false));
test('tanggal penetapan berbeda tahun nomor KMK ditahan',()=>{
 const d=s.getDokumen('KMK-2026-304');expect(d.berlaku_mulai).toBeNull();expect(d.catatan.join(' ')).toMatch(/berbeda/);
 expect(select(40,'I63.9').topik.every(p=>p.terpilih===null)).toBe(true);
});
test('judul artikel pneumonia generik tidak membuat PDF dewasa menjadi pediatrik',()=>{
 const d=s.getDokumen('KMK-2025-1168');expect(d.cakupan_usia).toBe('dewasa');expect(d.judul).toMatch(/Dewasa/);
});
test('pencarian isi memberikan halaman PDF dan hash sumber tanpa path internal',()=>{
 const d=s.getDokumen('KMK-2025-1168');expect(JSON.stringify(d)).not.toMatch(/arsip_teks|docs\/referensi/);
 const snippets=s.cuplikan(d,'pneumonia',2);expect(snippets).toHaveLength(2);expect(snippets[0]).toMatchObject({dokumen_id:d.id,halaman:1});expect(snippets[0].kutipan).toMatch(/PNEUMONIA/i);
});
test('pencarian isi penuh dapat menemukan istilah di luar judul',()=>{
 const d=s.daftar({q:'Mycobacterium tuberculosis',isi:'1',jenis:'pnpk',limit:50});
 expect(d.dokumen.some(d=>d.id==='KMK-2025-1168' && d.cuplikan.length)).toBe(true);
});
test('kesenjangan BA 2017 dan koleksi sumber terlihat tanpa aturan palsu',()=>{
 expect(s.daftar({status:'belum_terunduh'}).dokumen.map(d=>d.id).sort()).toEqual(['BA-KLAIM-2017-1','BA-KLAIM-2017-2']);
 expect(s.daftar({jenis:'koleksi'}).total).toBe(1);
 expect(s.getDokumen('BA-KLAIM-2023-1-2').digantikan_oleh).toEqual([]);
});
test('referensi baru tidak menambah temuan pending dan tidak mengubah data pasien',()=>{
 const r={...record(30,'E03.9'),hospital_code:'3371084'};const before=JSON.stringify(r);const h=evaluasiReferensiKlaim(r,[]);
 expect(h.pedoman_terkait.topik[0].terpilih.id).toBe('KMK-2026-582');
 const without={...h};delete without.pedoman_terkait;
 expect(susunPutusan({referensi_klaim:h})).toEqual(susunPutusan({referensi_klaim:without}));expect(JSON.stringify(r)).toBe(before);
});
test('berkas hanya dapat diambil dari ID katalog dan varian terdaftar',()=>{
 expect(s.berkasDokumen('../../.env')).toBeNull();expect(s.berkasDokumen('KMK-2025-1168',999)).toBeNull();expect(s.berkasDokumen('BA-KLAIM-2017-1')).toBeNull();expect(s.berkasDokumen('KMK-2025-1168')).toMatch(/\.pdf$/);
});
test('nomor KMK lama mempertahankan prefix HK.02.02 sesuai PDF',()=>{
 expect(s.getDokumen('KMK-2014-305').nomor).toBe('HK.02.02/MENKES/305/2014');expect(s.getDokumen('KMK-2015-73').nomor).toBe('HK.02.02/MENKES/73/2015');
});
test('LLA anak dan dewasa memakai tanggal penetapan masing-masing',()=>{
 expect(s.getDokumen('KMK-2026-160').berlaku_mulai).toBe('2026-03-03');expect(s.getDokumen('KMK-2025-986').berlaku_mulai).toBe('2025-10-17');
 expect(select(5,'C91.0').topik[0].terpilih.id).toBe('KMK-2025-986');expect(select(40,'C91.0').topik[0].terpilih.id).toBe('KMK-2026-160');
});

test('PNPK perdarahan menyediakan PDF, ringkasan berhalaman dan cakupan aturan yang sebenarnya',()=>{
 const svc=require('../../services/katalogPedomanService');
 const d=svc.getDokumen('KMK-2023-2162');
 expect(d.status_unduh).toBe('terunduh');expect(d.berkas[0].jumlah_halaman).toBe(82);
 expect(d.status_telaah).toBe('memiliki_aturan_ditelaah');
 expect(d.pengetahuan_agen.tersedia).toBe(true);
 expect(d.pengetahuan_agen.bagian).toContainEqual(expect.objectContaining({topik:'tata_laksana',halaman:20,kutipan:expect.stringContaining('Resusitasi')}));
 expect(svc.berkasDokumen(d.id)).not.toBeNull();
});
