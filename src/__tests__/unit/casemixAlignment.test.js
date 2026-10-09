const {evaluasiAlignment}=require('../../services/casemixAlignmentService');
test('checklist bukan kelulusan otomatis, delapan komponen terbaca dan tidak mensyaratkan diagnosis sekunder',()=>{
  const r=evaluasiAlignment({jenis_klaim:'RAWAT_JALAN',diagnosa_list:'R52.9'},[{page_number:3,ocr_text:'RESUME MEDIS\nDPJP: dr A\nDiagnosis Utama: nyeri\nTindakan: pemeriksaan\nHb 12 g/dL\nKondisi pulang: stabil\nKontrol: 1 minggu'}]);
  expect(r.komponen).toHaveLength(8);
  expect(r.komponen.find(k=>k.id==='CA-02').status).toBe('lulus');
  expect(r.komponen.find(k=>k.id==='CA-04').status).toBe('lulus');
  expect(r.status).not.toBe('lulus');
  expect(r.catatan).toMatch(/bukan ketentuan nasional/);
});
test('grouper dan label kosong tidak membuktikan temuan klinis',()=>{
  const r=evaluasiAlignment({jenis_klaim:'RAWAT_INAP',diagnosa_list:'N39.0'},[{page_number:1,ocr_text:'BERKAS KLAIM INDIVIDUAL\nINA-CBG\nDPJP: dr A\nHb 12\nKondisi pulang: stabil'},{page_number:3,ocr_text:'RESUME MEDIS\nAlasan admisi:\nKondisi pulang:'}]);
  expect(r.komponen.find(k=>k.id==='CA-02').status).toBe('tidak_cukup_data');
  expect(r.komponen.find(k=>k.id==='CA-07').status).toBe('tidak_cukup_data');
});
