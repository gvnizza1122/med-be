const ba=require('../../services/baTkmkbService');
const {susunPutusan}=require('../../services/putusanPendingService');
const {periksaOperasiTanpaKode}=require('../../services/kodingBedahService');
const {evaluasiKonsistensi}=require('../../services/konsistensiAntarDataService');
const {bacaGramSputum}=require('../../services/pemeriksaanSputumService');
const {tentukanBase}=require('../../services/inacbgGrouperResmi');
const p=(ocr_text,page_number=3)=>({ocr_text,page_number});
const r={jenis_klaim:'RAWAT_INAP',diagnosa_list:'J96.0;J46;J18.0',umur_tahun:70,discharge_date:'2026-09-01',kunjungan_igd:true};
const resume=p('RESUME MEDIS RAWAT INAP\nBangsal Masuk Keluar\nICU III 24-08-2026 17:10 01-09-2026 11:09\nAlasan Masuk Rawat Inap :\nGagal napas\nDiagnosis Utama :\nGagal napas\nTerapi/pengobatan selama di rumah sakit :\nINJ Ceftriaxone 1 gr\nDPJP: dr. Penguji Sp.P');
test('asma: dua kelompok obat dikenali pada tindakan, steroid inhalasi bukan sistemik',()=>{
 const pages=ba.halamanBukti([p('TRIAGE IGD\nTindakan Keperawatan\nmemberikan :\nnebulizer dgn lasalcom:budesma = 1:1\nInj Methylprednisolon 62,5 mg',44)]);
 expect(ba.cari(pages,'terapi_asma')).toMatchObject({status:'bukti_ditemukan',bukti:expect.arrayContaining([expect.objectContaining({kutipan:'Inj Methylprednisolon 62,5 mg',page_number:44})])});
 for(const text of ['Tindakan Keperawatan\nnebulizer dgn lasalcom:budesma = 1:1','Intervensi Keperawatan\nRencana nebul lasalcom\nInj Methylprednisolon 62,5 mg','RINCIAN BIAYA\nMemberikan salbutamol\nInj Methylprednisolon 62,5 mg']) expect(ba.cari(ba.halamanBukti([p(text)]),'terapi_asma').status).toBe('bukti_belum_cukup');
});
test('Gram hasil tanpa titik dua terbaca, order/hasil tertunda tidak dianggap hasil',()=>{
 expect(bacaGramSputum([p('LABORATORIUM\nPemeriksaan Gram\nJenis Spesimen : Sputum\nGram Negatif Tidak ditemukan\nGram Positif Coccus (+)',18)])[0]).toMatchObject({page_number:18,hasil_terbaca:true});
 expect(bacaGramSputum([p('Order pemeriksaan Gram sputum\nGram Positif : menunggu hasil')])).toEqual([]);
});
test('judul lembar anestesi intubasi dan template post op tidak menjadi bukti operasi',()=>{
 const pages=[p('LEMBAR ANESTHESI\nDiagnosa pre operasi :\nDiagnosa post operasi :\nTindakan operasi :\nKetamin 10 mg inj\nPost op\nintubasi ETT')];
 expect(periksaOperasiTanpaKode([],pages)).toBeNull();
 expect(evaluasiKonsistensi({},pages).some(t=>t.id==='KD-05')).toBe(false);
 expect(periksaOperasiTanpaKode([],[p('RESUME MEDIS\nTindakan operasi: ORIF femur')])).not.toBeNull();
});
test('ventilasi dewasa tanpa trakeostomi tidak memilih kelompok dengan trakeostomi/neonatus',()=>{
 expect(tentukanBase(['J96.0'],['96.72'],true).base).toBe('J-1-02');
 expect(tentukanBase(['J96.0'],['96.72','31.1'],true).base).toBe('J-1-01');
 expect(tentukanBase(['J96.0'],['96.71'],true).base).not.toBe('J-1-02');
});
test('ICU dengan indikasi, terapi, DPJP dan kegawatan: waktu IGD yang hilang menjadi catatan manual',()=>{
 const pages=[resume,p('TRIAGE IGD\nRR 35 x/menit\nSpO2 80%\nGagal napas',22)];
 const b=ba.matriksIgd(r,pages).find(b=>b.id==='matriks_durasi_igd');
 expect(b).toMatchObject({status:'perlu_cek_manual',info:true});
 const tanpa=ba.matriksIgd(r,[p('TRIAGE IGD\nICU')]).find(b=>b.id==='matriks_durasi_igd');
 expect(tanpa.status).toBe('bukti_belum_cukup');
});
test('perpindahan dari bangsal ke ICU tetap terlihat pada bukti ruang rawat',()=>{
 const {ruangDanDpjp}=require('../../services/matriksIgdService');
 const out=ruangDanDpjp([p('RESUME MEDIS RAWAT INAP\nBangsal Masuk Keluar\nGraha III 23-08-2026 14:37 24-08-2026 17:10\nICU III I01 24-08-2026 17:10 01-09-2026 11:09\nVital Sign\nTD 160/88')]);
 expect(out.ruang[0].kutipan).toContain('ICU III I01');expect(out.ruang[0].kutipan).not.toContain('Vital Sign');
});
test('skor audit belum tertulis pada ICU tetap ada untuk casemix, tidak otomatis dihitung pending',()=>{
 const t=ba.evaluasiDokumen(r,[resume]).find(t=>t.id==='TK-25-03');
 expect(t).toMatchObject({tanpa_putusan:true,telaah_casemix:true,perlu_telaah_dokumen:true});
 expect(susunPutusan({referensi_klaim:{temuan:[t]}}).alasan).toEqual([]);
 expect(ba.temuanKritis([t])).toEqual([]);
 const biasa=ba.evaluasiDokumen(r,[p('RESUME MEDIS\nDiagnosis Utama: Pneumonia')]).find(t=>t.id==='TK-25-03');
 expect(biasa.tanpa_putusan).not.toBe(true);
});
test('temuan paru oleh pemeriksa/waktu berbeda tidak otomatis menjadi alasan pending',()=>{
 const t=evaluasiKonsistensi({},[p('RESUME MEDIS\nrh +/+'),p('TRIAGE IGD\nThorak Normal',5)]);
 expect(t.find(t=>t.id==='KD-10').tanpa_putusan).toBe(true);
 expect(susunPutusan({konsistensi_data:t}).alasan).toEqual([]);
});

test('perbedaan severity acuan I dengan E-Klaim III saja tidak memicu pembacaan AI berulang',()=>{
 const {ambilPemicu}=require('../../services/tinjauanLanjutanService');
 const ai={inacbg_result:{code:'J-1-02-I',severity_estimasi:true},tariff_result:{amount:100},lembar_grouper:{inacbg:{kode:'J-1-02-III'}}};
 expect(ambilPemicu(r,ai,{persenSampel:0})).not.toContain('inacbg_atau_tarif_belum_pasti');
 ai.lembar_grouper.inacbg.kode='J-1-01-III';
 expect(ambilPemicu(r,ai,{persenSampel:0})).toContain('inacbg_atau_tarif_belum_pasti');
});
