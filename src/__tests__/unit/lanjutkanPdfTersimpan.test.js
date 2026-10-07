// Pemulihan tidak boleh menghapus bukti, menambah klaim, atau mengulang OCR.
const mockReview=jest.fn();
const mockExtract=jest.fn();
jest.mock('../../services/aiReviewService',()=>({...jest.requireActual('../../services/aiReviewService'),generateAiReview:mockReview}));
jest.mock('../../services/pdfExtractionPipeline',()=>({extractFromPDF:mockExtract}));
jest.mock('../../services/errorKnowledgeService',()=>({getRelevantKnowledge:async()=>[],getRelevantBpjsExamples:async()=>[]}));
const {lanjutkanAnalisisTersimpan}=require('../../routes/claimFiles');
const lengkap=()=>({dasar_diagnosis:{},temuan_tindakan:[],syarat_penunjang:[],putusan_pending:{status:'tidak_ditemukan_alasan'},analisis_kritis:{ai_gagal:false}});
function database(ai) {
  const rec={id:'record-asli',file_id:'file-asli',validation_status:'pending',jenis_klaim:'RAWAT_INAP',raw_data:'{}',ai_review:JSON.stringify(ai)};
  const pages=[{page_number:1,ocr_text:'Resume medis: diagnosis akhir dokter dan pemeriksaan.',confidence:100}];
  const writes=[];
  return {rec,pages,writes,all:async()=>[],prepare:sql=>({
    get:async()=> /SUM\(/.test(sql)?{pending_count:1,measured:0}:{...rec},
    all:async()=> sql.includes('FROM ocr_results')?pages:[],
    run:async(...p)=>{writes.push({sql,p});if(sql.includes('SET ai_review ='))rec.ai_review=p[0];return {changes:1};},
  })};
}
beforeEach(()=>{mockReview.mockReset();mockExtract.mockReset();});
test('review lengkap dilanjutkan memakai ID dan bukti asli tanpa AI maupun membaca PDF lagi',async()=>{
  const db=database(lengkap());
  const hasil=await lanjutkanAnalisisTersimpan(db,db.rec,{fileId:db.rec.file_id,recordId:db.rec.id});
  expect(hasil).toMatchObject({success:true,dilanjutkan:true,file_id:'file-asli',record_id:'record-asli',analysis_status:'lengkap'});
  expect(mockReview).not.toHaveBeenCalled();expect(mockExtract).not.toHaveBeenCalled();
  expect(db.writes.some(w=>/DELETE FROM (claim_files|claim_records|ocr_results)|INSERT INTO claim_records|INSERT INTO ocr_results/.test(w.sql))).toBe(false);
});
test('review sebagian diselesaikan dari bukti tersimpan tanpa mengulang ekstraksi atau menggandakan record',async()=>{
  const db=database({analisis_tidak_tersedia:true});mockReview.mockResolvedValue(lengkap());
  const hasil=await lanjutkanAnalisisTersimpan(db,db.rec,{fileId:db.rec.file_id,recordId:db.rec.id});
  expect(hasil.analysis_status).toBe('lengkap');expect(mockReview).toHaveBeenCalledTimes(1);
  expect(mockReview.mock.calls[0][2]).toEqual(db.pages);expect(mockExtract).not.toHaveBeenCalled();
  expect(db.writes.some(w=>/DELETE FROM (claim_files|claim_records|ocr_results)|INSERT INTO claim_records|INSERT INTO ocr_results/.test(w.sql))).toBe(false);
});
test('halaman yang belum terbaca tetap ditandai setelah pemulihan, tidak berubah menjadi lengkap',async()=>{
  const db=database({...lengkap(),pembacaan_pdf:{halaman_wajib:[1,2]}});mockReview.mockResolvedValue(lengkap());
  const hasil=await lanjutkanAnalisisTersimpan(db,db.rec,{fileId:db.rec.file_id,recordId:db.rec.id});
  expect(hasil.analysis_status).toBe('sebagian');
  expect(hasil.ai_review.kelengkapan_analisis.alasan.map(a=>a.kode)).toContain('halaman_belum_terbaca');
  expect(mockExtract).not.toHaveBeenCalled();
});
