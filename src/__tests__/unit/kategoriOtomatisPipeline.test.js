const mockClassify=jest.fn();
const mockEnhance=jest.fn();
jest.mock('../../services/pdfPageClassifier',()=>({...jest.requireActual('../../services/pdfPageClassifier'),classifyPdfPages:(...a)=>mockClassify(...a)}));
jest.mock('../../services/ocrIntegration',()=>({applyOcrEnhancements:(...a)=>mockEnhance(...a),mergeEnhancementsIntoRecord:jest.fn()}));
const mockOcr=jest.fn();
jest.mock('../../services/ocrService',()=>({ocrPdfPages:(...a)=>mockOcr(...a)}));
const mockExtract=jest.fn();
jest.mock('../../services/pdfExtractionService',()=>({extractClaimData:(...a)=>mockExtract(...a)}));
const {extractFromPDF}=require('../../services/pdfExtractionPipeline');
let prior;
beforeEach(()=>{
 prior=process.env.OCR_ENHANCEMENT_ENABLED;delete process.env.OCR_ENHANCEMENT_ENABLED;
 mockExtract.mockClear();
 mockClassify.mockResolvedValue({success:true,totalPages:2,pages:[{page_num:1,text_full:'RESUME MEDIS IGD',text_length:16},{page_num:2,text_full:'',text_length:0}],claimDataPages:[],claimDataText:'',errors:[]});
 mockEnhance.mockImplementation(async c=>({...c,claimDataText:'SURAT PERINTAH RAWAT INAP\nDiagnosis utama : pneumonia\nNama dokter pemeriksa',claimDataPages:[{page_num:2,text:'SURAT PERINTAH RAWAT INAP'}],
  ocr_enhancement:{pass1_general_ocr:{pages:[{page_number:2,text:'SURAT PERINTAH RAWAT INAP\nTanggal MRS : 1 Jan 2026\nDiagnosis : pneumonia\nDokter pemeriksa'.repeat(5)}]}}}));
});
afterEach(()=>{if(prior===undefined)delete process.env.OCR_ENHANCEMENT_ENABLED;else process.env.OCR_ENHANCEMENT_ENABLED=prior});
test('pilihan tunggal rawat jalan tidak mengunci SPRI hasil OCR',async()=>{
 const r=await extractFromPDF('uji.pdf',{skipAI:true,jenisKlaim:'RAWAT_JALAN',allowedJenisKlaim:['RAWAT_JALAN']});
 expect(r.success).toBe(true);expect(r.jenisKlaimDetection).toMatchObject({value:'RAWAT_INAP',source:'surat_perintah_rawat_inap',confident:true});expect(mockExtract).not.toHaveBeenCalled();
});
test('OCR standar ikut mendeteksi kategori bila enhancement dinonaktifkan',async()=>{
 process.env.OCR_ENHANCEMENT_ENABLED='false';
 mockOcr.mockResolvedValue({success:true,pages:[{page_number:2,text:'SURAT PERINTAH RAWAT INAP\nDiagnosis : pneumonia\nJenis pelayanan Rawat Inap'.repeat(5)}]});
 const r=await extractFromPDF('uji.pdf',{skipAI:true});
 expect(r.success).toBe(true);expect(r.jenisKlaimDetection.value).toBe('RAWAT_INAP');
});
test('kategori tidak terbaca berhenti sebelum permintaan AI berbiaya',async()=>{
 mockClassify.mockResolvedValue({success:true,totalPages:1,pages:[{page_num:1,text_full:'Dokumen administratif tanpa jenis pelayanan. '.repeat(20),text_length:860}],claimDataPages:[],claimDataText:'',errors:[]});
 const r=await extractFromPDF('uji.pdf',{jenisKlaim:'RAWAT_INAP'});
 expect(r.success).toBe(false);expect(r.error_code).toBe('jenis_layanan_perlu_ditinjau');expect(mockExtract).not.toHaveBeenCalled();
});
