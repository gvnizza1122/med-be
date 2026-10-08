const {resolveUsia}=require('../../services/usiaPasienService');
const {evaluasiReferensiKlaim,konteksReferensiUntukAi}=require('../../services/referensiKlaimService');
const {nilaiPneumoniaAnak}=require('../../services/pneumoniaAnakService');
const {evaluasiSyaratPenunjang}=require('../../services/syaratPenunjangService');
const {evaluasiKonsistensi}=require('../../services/konsistensiAntarDataService');
const {susunPutusan}=require('../../services/putusanPendingService');
const {perbaruiRisikoTampilan}=require('../../services/risikoKlaimTampilanService');
const rec=o=>({diagnosa_list:'J18.9',jenis_klaim:'RAWAT_INAP',discharge_date:'2026-10-08',hospital_code:'3371084',...o});
const p=text=>({page_number:3,ocr_text:'RESUME MEDIS RAWAT INAP\n'+text});
// Butir BA 2018 dapat berdiri sendiri atau ditempel ke kartu aturan bertopik sama (rujukan_ba_2018).
const cariBa=(temuan,id)=>temuan.find(t=>t.id===id)||temuan.flatMap(t=>t.rujukan_ba_2018||[]).find(b=>b.id===id);
const nilai=(rr,o={})=>nilaiPneumoniaAnak({record:rec({umur_tahun:3,...o}),dx:['J18.9'],pages:[p(`RR : ${rr} x/mnt\nSpO2 : 95%\nretraksi (-)`)]});
test.each([null,undefined,'',' '])('usia kosong %p tidak memilih dewasa',v=>{
 const r=rec({umur_tahun:v});expect(resolveUsia(r).tahun).toBeNull();const h=evaluasiReferensiKlaim(r,[]);
 expect(h.temuan.map(t=>t.id)).toContain('RK-USIA');expect(h.temuan.some(t=>['RK-03','RK-19','TK-25-03','BA-18-M03'].includes(t.id))).toBe(false);expect(susunPutusan({referensi_klaim:h}).status).toBe('perlu_dicek');
});
test.each([0,1,3,5,12,17,18,19,60])('pneumonia usia %i memakai satu jalur',tahun=>{
 const h=evaluasiReferensiKlaim(rec({umur_tahun:tahun}),[]).temuan;
 expect(h.some(t=>t.id==='RK-19')).toBe(tahun<18);expect(h.some(t=>t.id==='RK-03')).toBe(tahun>=18);expect(h.some(t=>t.id==='TK-25-03')).toBe(tahun>=18);expect(Boolean(cariBa(h,'BA-18-M03'))).toBe(tahun>=18);expect(h.some(t=>t.id==='BA-18-M03')).toBe(false);expect(h.some(t=>t.id==='BDD-08')).toBe(false);
});
test('umur dihitung pada awal episode, mendukung Date dan tanggal Indonesia',()=>{
 expect(resolveUsia(rec({birth_date:'2008-10-08',admission_date:'2026-10-07'})).tahun).toBe(17);
 expect(resolveUsia(rec({birth_date:new Date('2008-10-08T00:00:00Z'),admission_date:'08/10/2026'})).tahun).toBe(18);
});
test('umur bertentangan dan tanggal mustahil ditahan',()=>{
 expect(resolveUsia(rec({birth_date:'2023-01-01',admission_date:'2026-10-01',umur_tahun:40})).tahun).toBeNull();expect(resolveUsia(rec({birth_date:'2023-02-30'})).tahun).toBeNull();
});
test('tahun 0 bukan bukti neonatus; 27/28 hari dipisahkan',()=>{
 const r=rec({diagnosa_list:'P21.9',umur_tahun:0});expect(evaluasiReferensiKlaim(r,[]).temuan.map(t=>t.id)).toContain('RK-USIA');
 for(const hari of [27,28]){const ids=evaluasiReferensiKlaim({...r,umur_hari:hari},[]).temuan.map(t=>t.id);expect(ids.includes('TK-25-07')).toBe(hari===27);expect(Boolean(cariBa(evaluasiReferensiKlaim({...r,umur_hari:hari},[]).temuan,'BA-18-M31'))).toBe(hari===27);}
});
test.each([[40,false],[41,true]])('rawat anak RR %i memakai >40',(rr,sesuai)=>expect(nilai(rr).rawat_inap_terdukung).toBe(sesuai));
test.each([[60,false],[61,true]])('rawat bayi RR %i memakai >60',(rr,sesuai)=>expect(nilai(rr,{birth_date:'2026-09-10',admission_date:'2026-10-08',umur_tahun:0}).rawat_inap_terdukung).toBe(sesuai));
test('napas cepat 50 pada bayi enam bulan berbeda dari rawat >60',()=>{const r=nilai(50,{birth_date:'2026-04-08',admission_date:'2026-10-08',umur_tahun:0});expect(r.napas_cepat).toBe(true);expect(r.rawat_inap_terdukung).toBe(false);});
test.each([[92,true],[93,false]])('SpO2 %i memakai <=92',(n,sesuai)=>{const r=nilaiPneumoniaAnak({record:rec({umur_tahun:3}),dx:['J18.9'],pages:[p(`SpO2 : ${n}%\nRR : 30 x/mnt`)]});expect(r.rawat_inap_terdukung).toBe(sesuai);});
test('negasi, riwayat, suspek dan grouper tidak memenuhi indikasi',()=>{
 const pages=[p('retraksi (-)\ntidak ada dehidrasi\nkejang disangkal\nriwayat dehidrasi\nsuspek distres napas'),{page_number:4,ocr_text:'BERKAS KLAIM INDIVIDUAL\nINA-CBG\nSpO2 : 80%\nRR : 70 x/mnt'}];
 const r=nilaiPneumoniaAnak({record:rec({umur_tahun:3}),dx:['J18.9'],pages});expect(r.rawat_inap_terdukung).toBe(false);expect(r.status_penilaian).toBe('belum_dapat_dinilai');expect(susunPutusan({pneumonia_anak:r}).status).toBe('perlu_dicek');
});
test('surat perintah dengan suspek dan retraksi saja belum mengonfirmasi diagnosis',()=>{
 const r=nilaiPneumoniaAnak({record:rec({umur_tahun:3}),dx:['J18.9'],pages:[{page_number:1,ocr_text:'SURAT PERINTAH RAWAT INAP\nDiagnosis: susp BRPN dehidrasi sedang'},p('RR : 30 x/mnt\nretraksi subkostal\nkejang')]});expect(r.rawat_inap_terdukung).toBe(false);expect(r.klasifikasi_who).toBeNull();
});
test('rekap lokal anak tetap ditelaah, Gram dewasa tidak dipaksakan',()=>{
 const s=evaluasiSyaratPenunjang('J18.9','',[],{hospitalCode:'3371084',usia:3});expect(s[0].syarat.some(x=>x.nama==='Pemeriksaan gram sputum')).toBe(false);expect(s[0].syarat.every(x=>x.status==='perlu_cek_manual')).toBe(true);expect(susunPutusan({syarat_penunjang:s}).status).toBe('perlu_dicek');
 const a=evaluasiSyaratPenunjang('J18.9','',[],{hospitalCode:'3371084',usia:35});expect(a[0].syarat.find(x=>x.nama==='Pemeriksaan gram sputum').status).toBe('tidak_ada');
 const u=evaluasiSyaratPenunjang('J18.9','',[],{hospitalCode:'3371084',usia:null});expect(u[0].syarat.every(x=>x.status==='perlu_cek_manual')).toBe(true);
});
test('ambang natrium/kalium dewasa tidak masuk anak',()=>{
 const h=evaluasiReferensiKlaim(rec({diagnosa_list:'E87.1;E87.6',umur_tahun:3}),[]).temuan;expect(h.some(t=>['RK-04','RK-05'].includes(t.id))).toBe(false);expect(cariBa(h,'BA-18-M05-ANAK').catatan).toMatch(/<130/);expect(cariBa(h,'BA-18-M06-ANAK').catatan).toMatch(/<3/);
});
test('sepsis anak hanya PELOD, dewasa hanya SOFA',()=>{
 for(const age of [3,35]){const t=evaluasiReferensiKlaim(rec({diagnosa_list:'A41.9',umur_tahun:age}),[p('PELOD-2: 4\nSOFA: 7')]).temuan.find(t=>t.id==='TK-25-09');const b=t.bukti.find(b=>b.id==='skor_sepsis');expect(b.bukti).toHaveLength(1);expect(b.bukti[0].kutipan).toContain(age<18?'PELOD':'SOFA');expect(t.catatan).not.toContain(age<18?'SOFA':'PELOD');}
});
test('penunjang generik paru tidak menjadi persyaratan dewasa pada anak/usia kosong',()=>{
 for(const age of [3,null])expect(evaluasiKonsistensi(rec({umur_tahun:age}),[p('Diagnosis Utama: Pneumonia')]).some(t=>t.id==='KD-09')).toBe(false);expect(evaluasiKonsistensi(rec({umur_tahun:35}),[p('Diagnosis Utama: Pneumonia')]).some(t=>t.id==='KD-09')).toBe(true);
});
test('alasan Gram lama disegarkan untuk anak tanpa mengubah record',()=>{
 const r=rec({umur_tahun:3,ai_review:{putusan_pending:{status:'berisiko_pending',alasan:[{kode:'SP-01',sumber_pemeriksaan:'Syarat penunjang diagnosis',ringkas:'Gram sputum tidak ada',keparahan:'tinggi'}]}}});const before=JSON.stringify(r);const a=perbaruiRisikoTampilan(r,[],{pages:[p('RR : 30 x/mnt\nSpO2 : 92%')]});expect(a.putusan_pending.alasan.some(x=>/gram sputum tidak ada/i.test(x.ringkas))).toBe(false);expect(JSON.stringify(r)).toBe(before);
});
test('konteks AI anak tidak membawa skor dewasa',()=>{const c=konteksReferensiUntukAi(rec({umur_tahun:3}),[p('RR : 41 x/mnt\nSpO2 : 95%')]);expect(c).toContain('CAKUPAN USIA PASIEN: anak');expect(c).not.toMatch(/CURB|PSI/);expect(c).toContain('RR : 41');});

test('flag triase lama tidak menduplikasi penilaian PNPK seluruh bukti',()=>{
 const r=rec({umur_tahun:3,ai_review:{pending_risk_notes:[{pattern:'pneumonia_severity_vs_rawat_inap'},{pattern:'lain'}]}});
 const a=perbaruiRisikoTampilan(r,[],{pages:[p('Dehidrasi sedang\nRR : 30 x/mnt\nSpO2 : 95%')]});
 expect(a.pneumonia_anak.rawat_inap_terdukung).toBe(true);expect(a.pending_risk_notes).toEqual([{pattern:'lain'}]);
});
