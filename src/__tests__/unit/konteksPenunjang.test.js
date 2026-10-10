const {periksaKritis}=require('../../services/pemeriksaKritisService');
const {sesuaikanKritik}=require('../../services/konteksPenunjangService');
const {perbaruiRisikoTampilan}=require('../../services/risikoKlaimTampilanService');
const {hashBukti}=require('../../services/laporanOperasiService');
const p=(ocr_text,page_number)=>({ocr_text,page_number});
const resume=p('RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nSyok hipovolemia\nDiagnosis Sekunder :\nAKI\nTindakan/Prosedur :\nResusitasi cairan\nTerapi :\nInf Asering loading 500cc',3);
const lab=p('LABORATORIUM\nNatrium 122.0 L 136-145 mmol/L\nKalium 2.90 L 3.5-5.1 mmol/L\nCreatinin 1.67 H 0.7-1.2 mg/dL',7);
const record={jenis_klaim:'RAWAT_INAP',kelas_rawat:3,diagnosa_list:'R57.1;N17.9',prosedur_list:'90.59'};
const dasar={skor_keyakinan:100,tingkat:'tinggi',temuan:[],ai_gagal:false,dinilai:{dx:['R57.1','N17.9'],px:['90.59']}};
const hiponat={jenis:'kode_terlewat',keparahan:'tinggi',pesan:'Hiponatremia E87.1 belum dikode',saran:'Tambahkan diagnosis E87.1',bukti:{kutipan:'Natrium 122.0 L 136-145 mmol/L',page_number:7},sumber:'ai'};
test('angka Na/K dan koreksi untuk terapi tidak menjadi kode terlewat, penalti keyakinan atau rugi RS',async()=>{
 const pages=[resume,lab,p('CATATAN KEPERAWATAN\nDiberikan KCl sesuai instruksi untuk koreksi',8)];
 const ai={penalaran_diagnosis:{status:'selesai',diagnosis:[],kondisi_tersirat:[{kondisi:'Hipokalemi',kutipan:'Kalium 2.90 L 3.5-5.1 mmol/L',halaman:7}]}};
 const gateway={panggilModel:jest.fn(async()=>({ok:true,hasil:{keberatan:[{...hiponat,halaman:7,kutipan:hiponat.bukti.kutipan}],kesimpulan:'Cek'}}))};
 const out=await periksaKritis({record,ai,pages,gateway,hitungInacbgDanTarif:()=>({inacbgResult:{code:'A-4-10-I',severity_estimasi:true},tarifResult:{amount:100}})});
 expect(out.temuan).toEqual([]);expect(out).toMatchObject({skor_keyakinan:100,perlu_analisis_mendalam:false,ringkas:{total:0,potensi_rugi_rs:0}});
 expect(out.catatan_klinis).toHaveLength(2);
 expect(out.catatan_klinis.map(c=>c.bukti.kutipan)).toEqual(expect.arrayContaining([hiponat.bukti.kutipan,'Kalium 2.90 L 3.5-5.1 mmol/L']));
 expect(gateway.panggilModel.mock.calls[0][1].system).toContain('Infus, koreksi elektrolit, transfusi atau pemantauan saja tidak menetapkan diagnosis baru');
});
test('diagnosis hiponatremia yang benar-benar ditulis dokter tetapi terlewat tetap ditelaah; DD/negasi bukan diagnosis final',()=>{
 for(const teks of ['Hiponatremia','E87.1']){
  const pages=[{...resume,ocr_text:resume.ocr_text.replace('AKI','AKI\n'+teks)},lab];
  expect(sesuaikanKritik({...dasar,temuan:[hiponat]},{record,pages}).temuan).toEqual([hiponat]);
 }
 for(const teks of ['dd Hiponatremia','Tidak ada hiponatremia','Hiponatremia (-)']){
  const pages=[{...resume,ocr_text:resume.ocr_text.replace('AKI',teks)},lab];
  expect(sesuaikanKritik({...dasar,temuan:[hiponat]},{record,pages}).temuan).toEqual([]);
 }
});
test('kritik terhadap diagnosis yang telah dikode dan prosedur penting tidak dibuang oleh konteks lab',()=>{
 const aki={...hiponat,jenis:'kode_tidak_didukung',pesan:'N17.9 perlu dukungan kreatinin serial',saran:'Telaah diagnosis AKI'};
 const labBelumKode={...hiponat,pesan:'Pemeriksaan laboratorium 90.59 belum dikode',saran:'Cek 90.59'};
 const sedangDinilai={...hiponat,pesan:'E87.1 yang dikode belum sesuai bukti'};
 const out=sesuaikanKritik({...dasar,dinilai:{dx:['R57.1','E87.1']},temuan:[aki,labBelumKode,sedangDinilai]},{record,pages:[resume,lab]});
 expect(out.temuan).toEqual([aki,labBelumKode,sedangDinilai]);
});
test('hasil lama disesuaikan saat dibaca; angka tinggi juga menjadi konteks, dan kutipan harus dari baris asli',()=>{
 const pages=[resume,p('LABORATORIUM\nNatrium 153.0 H 136-145 mmol/L\nChlorida 126.0 H 98-107 mmol/L',14)];
 const ai={analisis_kritis:{...dasar,temuan:[{...hiponat,jenis:'potensi_rugi_rs',pesan:'Bukti mengarah ke Hipernatremia tetapi belum ditulis',bukti:{kutipan:'Natrium 153.0 mmol/L (tinggi; rujukan 136-145)',page_number:14}}]}};
 const out=perbaruiRisikoTampilan({...record,ai_review:ai},[],{pages});
 expect(out.analisis_kritis.temuan).toEqual([]);
 expect(out.analisis_kritis.catatan_klinis[0].bukti).toEqual({kutipan:'Natrium 153.0 H 136-145 mmol/L',page_number:14});
 expect(ai.analisis_kritis.temuan).toHaveLength(1);
});
test('klarifikasi sedasi ETT terikat berkas, tidak menjadi operasi/kode baru; gangguan AI tetap dinyatakan gagal',()=>{
 const pages=[resume,p('LEMBAR ANESTHESI\nObat ketamin injeksi',34)];
 const ai={klarifikasi_berkas:[{jenis:'sedasi_ett',sumber:'klarifikasi_pengguna',halaman:34,hash_bukti:hashBukti(pages)}]};
 const out=sesuaikanKritik({...dasar,temuan:[hiponat],ai_gagal:true,pesan_gangguan:'gangguan nyata'},{record,ai,pages:[...pages,lab]});
 expect(out.ai_gagal).toBe(true);expect(out.kesimpulan).toContain('gangguan nyata');expect(out.skor_keyakinan).toBe(70);
 expect(out.catatan_klinis.some(c=>c.jenis==='konteks_anestesi')).toBe(false);
 const sesuai=sesuaikanKritik(dasar,{record,ai,pages});
 expect(sesuai.catatan_klinis[0].pesan).toContain('sedasi pemasangan ETT');expect(sesuai.temuan).toEqual([]);
 expect(sesuaikanKritik(sesuai,{record,ai,pages:[...pages,lab]}).catatan_klinis).toEqual([]);
});

test('diagnosis dokter terverifikasi dari saran lain tidak hilang meskipun kritik mengutip lab',()=>{
 const temuan={...hiponat,pesan:'N17.9 belum dikode',saran:'Cocokkan kode N17.9',bukti:{kutipan:'Creatinin 1.67 H 0.7-1.2 mg/dL',page_number:7}};
 const ai={suggested_codes:[{code:'N17.9',type:'diagnosis',quotation:'AKI',page_number:3}]};
 const out=sesuaikanKritik({...dasar,dinilai:{dx:['R57.1']},temuan:[temuan]},{record,ai,pages:[resume,lab]});
 expect(out.temuan).toEqual([temuan]);
});

test('manifestasi klinis dan dasar resusitasi tidak otomatis menjadi diagnosis terlewat; kritik kode tetap memengaruhi keyakinan',async()=>{
 const klinis=p('CATATAN PERJALANAN\nSpO2 85% room air\nTD 80/43 mmHg diberikan fluid challenge dan norepinefrin\nKejang seluruh tubuh\nGCS 1-1-1 terpasang ventilator',4);
 const kondisi_tersirat=[
  {kondisi:'Desaturasi',kutipan:'SpO2 85% room air',halaman:4},
  {kondisi:'Kemungkinan syok',kutipan:'TD 80/43 mmHg diberikan fluid challenge dan norepinefrin',halaman:4},
  {kondisi:'Kejang',kutipan:'Kejang seluruh tubuh',halaman:4},
  {kondisi:'Penurunan kesadaran',kutipan:'GCS 1-1-1 terpasang ventilator',halaman:4},
 ];
 const ai={penalaran_diagnosis:{status:'selesai',kondisi_tersirat,diagnosis:[{kode:'N17.9',status:'perlu_klarifikasi',alasan:'Periksa baseline dan serial kreatinin'}]}};
 const out=await periksaKritis({record,ai,pages:[resume,lab,klinis],gateway:{panggilModel:async()=>({ok:true,hasil:{keberatan:[]}})},hitungInacbgDanTarif:()=>({inacbgResult:{code:'A-4-10-I'},tarifResult:null})});
 expect(out.temuan).toHaveLength(1);expect(out.temuan[0].pesan).toContain('N17.9 perlu klarifikasi');
 expect(out.skor_keyakinan).toBe(95);expect(out.ringkas.potensi_rugi_rs).toBe(0);
 expect(out.catatan_klinis).toHaveLength(4);expect(out.catatan_klinis.every(c=>c.jenis==='konteks_klinis')).toBe(true);
 expect(out.dasar_keyakinan).toMatchObject({penalti_temuan:5,konteks_tanpa_penalti:4,jumlah_temuan:1});
});
test('hasil tersimpan tidak mempertahankan penalti lama atau menggandakan konteks saat dibaca berulang',()=>{
 const tersirat={kondisi:'Desaturasi',kutipan:'SpO2 85% room air',halaman:4};
 const pages=[resume,p('CATATAN PERJALANAN\nSpO2 85% room air',4),lab];
 const old={jenis:'potensi_rugi_rs',keparahan:'rendah',sumber:'aturan',pesan:`Bukti mengarah ke "${tersirat.kondisi}" tetapi tidak ditulis dokter sebagai diagnosis.`,bukti:{kutipan:tersirat.kutipan,page_number:4}};
 const nyata={jenis:'inkonsistensi',keparahan:'sedang',pesan:'N17.9 tertulis; periksa baseline kreatinin',sumber:'ai'};
 const ai={penalaran_diagnosis:{status:'selesai',kondisi_tersirat:[tersirat]},analisis_kritis:{...dasar,skor_keyakinan:1,temuan:[old,hiponat,nyata],pembaruan_ba_tkmkb:{dasar:{skor_keyakinan:1}}}};
 const once=perbaruiRisikoTampilan({...record,ai_review:ai},[],{pages}).analisis_kritis;
 const twice=perbaruiRisikoTampilan({...record,ai_review:{...ai,analisis_kritis:once}},[],{pages}).analisis_kritis;
 expect(once.skor_keyakinan).toBe(88);expect(twice).toEqual(once);
 expect(once.temuan).toEqual([nyata]);expect(once.catatan_klinis).toHaveLength(2);
 expect(ai.analisis_kritis.temuan).toHaveLength(3);
});
test('label temuan AI tidak boleh menjadikan Na/K rendah diagnosis baru, tetapi penetapan dokter tetap dipertahankan',()=>{
 for(const jenis of ['kode_terlewat','potensi_rugi_rs','kode_tidak_didukung','inkonsistensi']){
  const t={...hiponat,jenis};
  expect(sesuaikanKritik({...dasar,temuan:[t]},{record,pages:[resume,lab]}).skor_keyakinan).toBe(100);
  const tertulis={...resume,ocr_text:resume.ocr_text.replace('AKI','AKI\nHiponatremia')};
  expect(sesuaikanKritik({...dasar,temuan:[t]},{record,pages:[tertulis,lab]}).temuan).toEqual([t]);
 }
});
test('keberatan nyata dengan kutipan sama tidak dibuang hanya karena cocok dengan kondisi tersirat',()=>{
 const tersirat={kondisi:'Desaturasi',kutipan:'SpO2 85% room air',halaman:4};
 const pages=[resume,p('CATATAN PERJALANAN\nSpO2 85% room air',4)];
 const nyata={jenis:'potensi_rugi_rs',keparahan:'sedang',sumber:'ai',pesan:'Tindakan tercatat tetapi kode belum sesuai',bukti:{kutipan:tersirat.kutipan,page_number:4}};
 const out=sesuaikanKritik({...dasar,temuan:[nyata]},{record,pages,ai:{penalaran_diagnosis:{status:'selesai',kondisi_tersirat:[tersirat]}}});
 expect(out.temuan).toEqual([nyata]);expect(out.skor_keyakinan).toBe(88);
});
