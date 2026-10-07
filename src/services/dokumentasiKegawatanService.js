/** Kesimpulan kelengkapan bukti yang sudah diekstrak; tidak menetapkan diagnosis atau ACC klaim. */
function nilaiDokumentasiKegawatan(assessment) {
  const a=assessment||{};
  const criteria=Array.isArray(a.kriteria)?a.kriteria:[];
  const terpenuhi=criteria.filter(k=>k?.status==='ya'&&Array.isArray(k.evidence)&&k.evidence.some(e=>
    Number.isInteger(e?.page_number)&&e.page_number>0&&typeof e.kutipan==='string'&&e.kutipan.trim()));
  const dinilai=a.has_data===true;
  const status=!dinilai?'belum_dinilai':terpenuhi.length?'mendukung':'belum_cukup';
  return {status,kriteria_terpenuhi:terpenuhi.map(k=>k.kriteria),
    halaman_bukti:[...new Set(terpenuhi.flatMap(k=>k.evidence.filter(e=>e.page_number>0&&e.kutipan).map(e=>e.page_number)))],
    ringkasan:status==='mendukung'
      ? `Dokumentasi mendukung kegawatdaruratan melalui ${terpenuhi.map(k=>k.kriteria).join(', ')}. Tidak perlu semua K1–K5 terpenuhi atau kalimat khusus dokter yang menyebut “gawat darurat”.`
      : status==='belum_dinilai'?'Kelengkapan bukti kegawatdaruratan belum dapat dinilai karena pembacaan belum selesai.'
      : 'Bukti yang terbaca belum cukup mendukung kriteria kegawatdaruratan; periksa kelengkapan dokumen klinis.',
    catatan:'Penilaian aplikasi memeriksa bukti klinis dan kelengkapan dokumen. Penetapan klinis tetap mengikuti DPJP; hasil ini bukan jaminan ACC BPJS.'};
}
module.exports={nilaiDokumentasiKegawatan};
