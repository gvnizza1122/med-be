const {deteksiJenisDariHalaman:deteksi}=require('../../services/jenisLayananKlaimService');
const {detectJenisKlaim,isCriticalPage}=require('../../services/pdfPageClassifier');
const p=(page_num,text_full,extra={})=>({page_num,text_full,...extra});
test.each([
 ['TRIAGE IGD\nSURAT PERINTAH RAWAT INAP','RAWAT_INAP'],
 ['TRIAGE IGD\nJns Rawat : Rawat Inap','RAWAT_INAP'],
 ['RESUME MEDIS RAWAT INAP\nRESUME MEDIS IGD','RAWAT_INAP'],
 ['SURAT ELIGIBILITAS PESERTA\nJns Rawat :\nRawat Inap','RAWAT_INAP'],
 ['Jenis Perawatan : 1 - Rawat Inap','RAWAT_INAP'],
 ['Jns Rawat : Rawat Jalan\nTRIAGE IGD','RAWAT_JALAN'],
 ['TRIAGE IGD','RAWAT_JALAN'],
 ['Laporan Operasi',null],
 ['data tanpa kategori',null],
])('kategori berdasarkan dokumen: %s',(text,expected)=>expect(detectJenisKlaim(text)).toBe(expected));
test('SPRI scan ikut menentukan kategori walaupun native hanya menyebut IGD',()=>{
 expect(deteksi([p(1,'TRIAGE IGD'),{page_number:2,text:'SURAT PERINTAH RAWAT INAP'}])).toMatchObject({value:'RAWAT_INAP',confident:true,source:'surat_perintah_rawat_inap'});
});
test('kategori SEP yang bertentangan tidak ditebak',()=>{
 expect(deteksi([p(1,'Jns Rawat : Rawat Jalan'),p(2,'Jns Rawat : Rawat Inap')])).toMatchObject({value:null,konflik:true,confident:false});
});
test('SPRI dan SEP jalan yang berbeda meminta peninjauan',()=>{
 expect(deteksi([p(1,'Jns Rawat : Rawat Jalan'),p(2,'SURAT PERINTAH RAWAT INAP')]).konflik).toBe(true);
});
test('hasil grouper dikecualikan',()=>{
 expect(deteksi([p(1,'Jns Rawat : Rawat Jalan'),p(2,'Jenis Perawatan : 1 - Rawat Inap',{is_lembar_grouper:true})]).value).toBe('RAWAT_JALAN');
});
test.each(['SURAT PERINTAH RAWAT INAP','SURAT ELIGIBILITAS PESERTA'])('dokumen kategori diprioritaskan OCR: %s',text=>expect(isCriticalPage(text)).toBe(true));

const {nilaiDokumentasiKegawatan:nilai}=require('../../services/dokumentasiKegawatanService');
test('satu kriteria dengan bukti klinis cukup, tanpa frasa gawat dokter',()=>{
 const a={has_data:true,kriteria:[{kriteria:'K1',status:'tidak',evidence:[]},{kriteria:'K4',status:'ya',evidence:[{page_number:10,kutipan:'101 x/mnt'}]}]};
 expect(nilai(a)).toMatchObject({status:'mendukung',kriteria_terpenuhi:['K4'],halaman_bukti:[10]});
});
test('ESI atau nama diagnosis saja tidak menetapkan kelengkapan',()=>{
 expect(nilai({has_data:true,esi:{skor:2},kriteria:[]})).toMatchObject({status:'belum_cukup'});
});
test('ya tanpa bukti dan pembacaan gagal tidak dijadikan terpenuhi',()=>{
 expect(nilai({has_data:true,kriteria:[{kriteria:'K1',status:'ya',evidence:[]}]}).status).toBe('belum_cukup');
 expect(nilai({has_data:false,kriteria:[]}).status).toBe('belum_dinilai');
});
