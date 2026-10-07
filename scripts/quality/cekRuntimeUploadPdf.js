/** Diagnostik deploy tanpa OCR ulang, AI, identitas, atau isi klinis dalam keluaran. */
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {classifyPdfPages,shutdownClassifyPool}=require('../../src/services/pdfPageClassifier');
async function cek(pdfPath) {
 const pipeline=fs.readFileSync(path.join(__dirname,'../../src/services/pdfExtractionPipeline.js'),'utf8');
 const engine=(process.env.OCR_ENGINE||'tesseract').toLowerCase();
 const laporan={node:process.version,
  pipeline_sha256:crypto.createHash('sha256').update(pipeline).digest('hex'),
  fallback_seluruh_halaman:pipeline.includes('function pakaiSemuaHalaman'),
  kategori_otomatis:pipeline.includes('deteksiJenisDariHalaman(pagesJenis)'),
  mesin_ocr:engine};
 if(engine==='paddle'){
  try {
   const r=await fetch(`${process.env.PADDLE_OCR_URL||'http://ocr_rapid:8866'}/health`,{signal:AbortSignal.timeout(5000)});
   laporan.layanan_ocr={terjangkau:true,status_http:r.status,sehat:r.ok};
  } catch(_){laporan.layanan_ocr={terjangkau:false,sehat:false};}
 }
 if(pdfPath){
  const c=await classifyPdfPages(pdfPath);
  const {punyaLapisanTeksNyata}=require('../../src/services/keputusanSumberHalamanService');
  laporan.pdf={terbuka:c.success,halaman:c.totalPages,
   halaman_data_terdeteksi:c.claimDataPages?.length||0,
   perlu_ocr:(c.pages||[]).filter(p=>!punyaLapisanTeksNyata(p.text_full)).map(p=>p.page_num)};
 }
 return laporan;
}
if(require.main===module)cek(process.argv[2]).then(r=>console.log(JSON.stringify(r,null,2)))
 .catch(()=>{console.error('Diagnostik belum berhasil; periksa akses PDF dan runtime.');process.exitCode=1})
 .finally(shutdownClassifyPool);
module.exports={cek};
