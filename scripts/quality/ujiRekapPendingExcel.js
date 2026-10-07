/** Uji pembacaan lokal tanpa impor DB, panggilan AI, atau keluaran identitas pasien. */
'use strict';
const fs=require('fs');
const crypto=require('crypto');
const XLSX=require('xlsx');
const {parsePendingWorkbook}=require('../../src/services/pendingExcelParserService');
const {petakanDenganAturan}=require('../../src/services/petaAlasanPendingService');
const {normalisasiSep}=require('../../src/services/sepCocokService');

function uji(path) {
  const buffer=fs.readFileSync(path),wb=XLSX.read(buffer,{type:'buffer',cellDates:false});
  const {rows,sheets}=parsePendingWorkbook(wb);
  const counts={};
  for(const r of rows){const k=petakanDenganAturan(r.alasan_pending).kategori;counts[k]=(counts[k]||0)+1;}
  return {sha256:crypto.createHash('sha256').update(buffer).digest('hex'),sheets,
    ringkasan:{total:rows.length,alasan_terbaca:rows.filter(r=>r.alasan_pending).length,jawaban_rs_terbaca:rows.filter(r=>r.jawaban_rs).length,
      tanggal_masuk_sep_terbaca:rows.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.tgl_sep||'')).length,
      tanggal_pulang_terbaca:rows.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.tgl_pulang||'')).length,
      sep_bentuk_lazim:rows.filter(r=>normalisasiSep(r.sep).bentukLazim).length},kategori:counts,
    batasan:'Pembacaan dan pemetaan alasan tanpa AI. Jawaban RS bukan bukti penerimaan BPJS atau bukti klinis. Tidak ada data yang diimpor ke basis data.'};
}
if(require.main===module){
  global.fetch=()=>{throw Error('Jaringan dinonaktifkan selama pengujian lokal');};
  if(!process.argv[2]) throw Error('Berikan lokasi rekap Excel');
  const report=uji(process.argv[2]);
  if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
module.exports={uji};
