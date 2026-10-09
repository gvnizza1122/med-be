// Checklist pengguna adalah kerangka telaah dokumentasi, bukan regulasi BPJS.
const { halamanKlinis, cariBukti } = require('./referensiKlaimService');
const { cari } = require('./baKesepakatan2018Service');
const { isLembarGrouper } = require('./lembarGrouperService');
const bukti = (pages,pola) => cari({pola},pages);
function evaluasiAlignment(record={},pages=[],ai={}) {
  const klinis=halamanKlinis(pages);
  const ranap=(record.jenis_klaim || record.JENIS_KLAIM)==='RAWAT_INAP';
  const diagnosis=cariBukti(klinis,'resume_dpjp').bukti;
  const dokumen=(pages || []).filter(p=>!isLembarGrouper(p.ocr_text ?? p.text));
  const komponen=[];
  const tambah=(id,nama,b,sudah=null,alasan='')=>komponen.push({id,nama,status:sudah===true?'lulus':sudah===false?'perlu_klarifikasi':b.length?'dukungan_ditemukan':'tidak_cukup_data',bukti:b,alasan});
  const konflik=(ai.konsistensi_data || []).filter(k=>['tinggi','sedang'].includes(k.keparahan));
  tambah('CA-01','Identitas episode',bukti(dokumen,/\b(?:tanggal masuk|tanggal keluar|DPJP|cara pulang|SEP)\b[ \t]*(?:[:=][ \t]*)?[^\s:=]+/i),
    konflik.some(k=>/identitas|tanggal|episode|SEP/i.test(k.pesan||k.nama))?false:null,'Cocokkan tanggal, DPJP, unit dan cara pulang antardokumen.');
  tambah('CA-02','Justifikasi admisi',ranap?bukti(klinis,/\b(?:indikasi rawat inap|alasan (?:rawat|admisi)|memerlukan (?:rawat inap|monitoring|intervensi)|gagal (?:terapi|rawat jalan))\b[ \t]*(?:[:=][ \t]*)?[^\s:=]+/i):[],
    ranap?null:true,ranap?'Alasan admisi perlu didukung kondisi klinis dan intervensi, bukan nama diagnosis saja.':'Tidak berlaku untuk rawat jalan.');
  const dx=ai.penalaran_diagnosis?.diagnosis || [];
  const utama=dx.find(d=>d.peran==='utama') || dx[0];
  tambah('CA-03','Diagnosis utama',diagnosis,utama?utama.status==='terkonfirmasi':null,'Diagnosis akhir DPJP dan penyebab admisi harus dapat ditelusuri; pilihan tarif bukan dasar diagnosis.');
  const sekunder=dx.filter(d=>d !== utama);
  const kodeSekunder = require('./pemeriksaKritisService').kodeFinal(record,ai).dx.slice(1);
  tambah('CA-04','Diagnosis sekunder',sekunder.flatMap(d=>(d.mendukung||[]).map(b=>({page_number:b.halaman,kutipan:b.kutipan}))),
    sekunder.length?sekunder.every(d=>d.status==='terkonfirmasi'):kodeSekunder.length?null:true,kodeSekunder.length?'Pastikan asesmen dan pengaruh pada evaluasi, terapi, monitoring, konsultasi atau lama rawat; hasil lab tunggal bukan diagnosis.':'Tidak ada diagnosis sekunder yang diajukan.');
  tambah('CA-05','Kesesuaian tindakan',bukti(klinis,/\b(?:tindakan|prosedur|laporan operasi)\b[ \t]*[:=-][ \t]*[^\s:=]+/i),
    konflik.some(k=>/tindakan|prosedur|lokasi|sisi/i.test(k.pesan||k.nama))?false:null,'Cocokkan nama, waktu, lokasi, sisi dan pendekatan; obat atau alat saja bukan bukti prosedur.');
  tambah('CA-06','Hasil penunjang',bukti(klinis,/\b(?:Hb|hemoglobin|kalium|natrium|leukosit|kreatinin|SpO2|kesan radiologi)\b[ \t]*(?:[:=][ \t]*)?[^\s:=]+/i),null,'Telaah hasil relevan dan respons intervensi; penunjang dipilih sesuai indikasi.');
  tambah('CA-07','Kondisi pulang',bukti(klinis,/\b(?:kondisi (?:saat )?pulang|keadaan pulang|obat pulang|kontrol|edukasi|tanda bahaya)\b[ \t]*(?:[:=][ \t]*)?[^\s:=]+/i),null,'Periksa kondisi objektif, obat, kontrol dan edukasi sesuai kondisi pasien.');
  tambah('CA-08','Kandidat kode',diagnosis,ai.kode_luar_kamus?.length?false:null,'Kode harus mengikuti diagnosis DPJP dan bukti tindakan; koder memverifikasi indeks dan tabular.');
  return {versi:'ALIGNMENT-2026-10-09.1',status:komponen.some(k=>k.status==='perlu_klarifikasi')?'perlu_klarifikasi':komponen.some(k=>k.status==='tidak_cukup_data')?'tidak_cukup_data':'perlu_evaluasi_casemix',
    komponen,catatan:'Dukungan ditemukan belum berarti seluruh komponen lulus. Evaluasi casemix RS diperlukan untuk menyimpulkan keselarasan klinis. Checklist ini bukan ketentuan nasional BPJS.'};
}
module.exports={evaluasiAlignment};
