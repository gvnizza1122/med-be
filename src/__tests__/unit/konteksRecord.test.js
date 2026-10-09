const {dataUntukPrompt}=require('../../services/konteksRecordService');
test('hasil AI lama dan arsip OCR duplikat tidak dikirim bersama halaman sumber',()=>{
 const record={DIAGLIST:'R57.1',ai_review:'jawaban lama'.repeat(50000),raw_data:JSON.stringify({ICU_LOS:4,_ocr_vital_signs_detected:{td:'80/50'},physical_exam_findings:{ocr:'duplikat'.repeat(50000)},structured_extraction:{ocr:'duplikat'.repeat(50000)},catatan:'catatan klinis lengkap'.repeat(1000)})};
 const before=JSON.stringify(record);const hasil=dataUntukPrompt(record,[{ocr_text:'Diagnosis utama: syok hipovolemik'}]);
 expect(hasil).not.toHaveProperty('ai_review');expect(hasil.raw_data).not.toHaveProperty('physical_exam_findings');
 expect(hasil.raw_data.ICU_LOS).toBe(4);expect(hasil.raw_data._ocr_vital_signs_detected.td).toBe('80/50');
 expect(hasil.raw_data.catatan).toBe(JSON.parse(record.raw_data).catatan);expect(JSON.stringify(record)).toBe(before);
});
test('tanpa halaman sumber, data klinis hasil ekstraksi tetap tersedia',()=>{
 const raw_data={physical_exam_findings:{kesadaran:'kompos mentis'},structured_extraction:{temuan:'narasi'}};
 expect(dataUntukPrompt({raw_data}).raw_data).toEqual(raw_data);
});
