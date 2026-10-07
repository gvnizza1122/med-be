const { nilaiKelengkapanAnalisis, masalahAnalisisRecord } = require('../../services/kelengkapanAnalisisService');
const { finalisasiAnalisisPdf } = require('../../routes/claimFiles');
const lengkap = () => ({ dasar_diagnosis: {}, temuan_tindakan: [], syarat_penunjang: [],
  putusan_pending: { status: 'tidak_ditemukan_alasan' }, analisis_kritis: {ai_gagal:false},
  penalaran_diagnosis:{status:'selesai'}, pemeriksaan_lanjutan:{status:'tidak_diperlukan'} });

test('kelengkapan proses terpisah dari ketepatan atau hasil klinis', () => {
  const ai = {...lengkap(), putusan_pending:{status:'berisiko_pending'}, tinjauan_diagnosis:{status:'perlu_klarifikasi'}};
  expect(nilaiKelengkapanAnalisis(ai,{wajibTahap:true}).status).toBe('lengkap');
});
test.each([null, {}, 'bukan JSON', {analisis_tidak_tersedia:true}])('review tidak tersedia tidak dinyatakan lengkap: %j', ai => {
  expect(nilaiKelengkapanAnalisis(ai).status).toBe('gagal');
});
test.each([
  ['tinjauan_diagnosis',{status:'belum_dinilai'}], ['penalaran_diagnosis',{status:'gagal'}],
  ['analisis_kritis',{ai_gagal:true}], ['putusan_pending',{sumber_keputusan:'ai_tidak_tersedia'}],
  ['pemeriksaan_lanjutan',{status:'gagal'}],
  ['kegawatdaruratan_assessment',{analisis_gagal:true}],
])('tahap gagal ditandai sebagian: %s', (field, value) => {
  expect(nilaiKelengkapanAnalisis({...lengkap(), [field]:value},{wajibTahap:true}).status).toBe('sebagian');
});
test('hasil model kosong atau tahap wajib terlewat tidak dianggap analisis PDF lengkap',()=>{
  expect(nilaiKelengkapanAnalisis({generated_at:'2026-10-06'}, {wajibTahap:true}).alasan.map(a=>a.kode))
    .toEqual(expect.arrayContaining(['dasar_diagnosis','tindakan','penunjang','putusan','pemeriksa_kritis']));
});
test('kegagalan pola risiko tidak boleh tampak seperti hasil risiko kosong yang bersih',()=>{
  expect(nilaiKelengkapanAnalisis({...lengkap(),gangguan_tahap:[{kode:'pola_risiko',pesan:'Belum selesai.'}]}).status).toBe('sebagian');
});
test('halaman grouper dikecualikan; halaman penunjang yang tidak terbaca tetap terlihat',()=>{
  const classification={pages:[{page_num:1},{page_num:2},{page_num:3,is_lembar_grouper:true},{page_num:4,is_primary_source:true}]};
  const a=nilaiKelengkapanAnalisis(lengkap(),{classification,evidencePool:[{page_number:1,ocr_text:'Resume'},{page_number:2,ocr_text:''}]});
  expect(a.status).toBe('sebagian'); expect(a.alasan).toContainEqual(expect.objectContaining({kode:'halaman_belum_terbaca',pesan:expect.stringContaining('Halaman 2')}));
  expect(nilaiKelengkapanAnalisis(lengkap(),{classification,evidencePool:[{page_number:1,ocr_text:'Resume'},{page_number:2,ocr_text:'Hasil pemeriksaan'}]}).status).toBe('lengkap');
});
test('analisis gagal atau pengisian kode gagal tetap ditahan; TXT/CSV tidak diwajibkan punya analisis PDF',()=>{
  expect(masalahAnalisisRecord({ai_review:null},{file_name:'kasus.pdf'}).status).toBe('gagal');
  expect(masalahAnalisisRecord({ai_review:null},{file_name:'klaim.txt'})).toBeNull();
  expect(nilaiKelengkapanAnalisis(lengkap(),{gangguanKode:true}).status).toBe('sebagian');
  expect(masalahAnalisisRecord({ai_review:{kelengkapan_analisis:{status:'sebagian',alasan:[]}}})).not.toBeNull();
});

function dbDenganRecord(awal, errors=[]) {
  const state={...awal}; const writes=[];
  return {state,writes,prepare:sql=>({
    get:async()=>/SUM\(/.test(sql)?{pending_count:1}:{...state},
    all:async()=>errors,
    run:async(...values)=>{
      writes.push({sql,values});
      if(/SET ai_review =/.test(sql))state.ai_review=values[0];
      if(/SET validation_status =/.test(sql)){state.validation_status=values[0];state.error_count=values[1];}
      return {changes:1};
    },
  })};
}
test('review gagal setelah ekstraksi disimpan mengubah status valid menjadi pending dan ringkasan ikut sinkron',async()=>{
  const db=dbDenganRecord({validation_status:'valid',error_count:7,ai_review:JSON.stringify(lengkap())});
  const r=await finalisasiAnalisisPdf(db,{recordId:'r',fileId:'f',review:null,evidencePool:[]});
  expect(r).toMatchObject({validation_status:'pending',analysis_status:'gagal',validation_errors:[]});
  expect(db.state.error_count).toBe(0);
  expect(JSON.parse(db.state.ai_review).analisis_tidak_tersedia).toBe(true);
  expect(db.writes.some(w=>/UPDATE claim_files SET valid_count/.test(w.sql))).toBe(true);
});
test('respons baca ulang memakai status dan error akhir, bukan hasil awal sebelum pengisian kode',async()=>{
  const db=dbDenganRecord({validation_status:'pending',ai_review:JSON.stringify(lengkap())});
  const r=await finalisasiAnalisisPdf(db,{recordId:'r',fileId:'f',review:lengkap(),evidencePool:[{page_number:1,ocr_text:'Resume'}]});
  expect(r).toMatchObject({validation_status:'pending',analysis_status:'lengkap',analysis_warning:null,validation_errors:[]});
});
test('analisis yang gagal tidak menurunkan status error data',async()=>{
  const db=dbDenganRecord({validation_status:'error'},[{rule_id:'RV-03'}]);
  const r=await finalisasiAnalisisPdf(db,{recordId:'r',fileId:'f',review:null,evidencePool:[]});
  expect(r.validation_status).toBe('error'); expect(db.state.error_count).toBe(1);
});
