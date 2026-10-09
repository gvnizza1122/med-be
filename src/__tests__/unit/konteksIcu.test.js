const {teksUntukAnalisis}=require('../../services/konteksIcuService');
test('ICU menyimpan negasi dan bukti tindakan; tidak merekonstruksi grid angka',()=>{
 const teks='Lembar observasi ICU\n01 02 03 04\n120 121 123 125\nMelakukan pemberian cairan Asering loading 500cc\nBelum diberikan norepinefrin\nEvaluasi respons: tekanan darah membaik\n80 80 80 80\n07 08 09 10\n11 12 13 14';
 const hasil=teksUntukAnalisis({ocr_text:teks});
 expect(hasil).toContain('Melakukan pemberian cairan Asering loading 500cc');
 expect(hasil).toContain('Belum diberikan norepinefrin');
 expect(hasil).toContain('tekanan darah membaik');
 expect(hasil).not.toContain('11 12 13 14');
 expect(teks).toContain('11 12 13 14');
});
test.each(['Resume medis\nDiagnosis utama: syok hipovolemik\nDirawat ICU','CPPT ICU\nAssessment: membaik','Catatan perkembangan ICU\nMonitoring tekanan darah'])('resume dan CPPT tetap utuh',ocr_text=>{
 expect(teksUntukAnalisis({ocr_text})).toBe(ocr_text);
});
test('angka grid tanpa narasi tidak dibuang atau ditafsirkan',()=>{
 const ocr_text='Monitoring ICU\n120 110 100'; expect(teksUntukAnalisis({ocr_text})).toBe(ocr_text);
});
