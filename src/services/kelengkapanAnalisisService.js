// Kelengkapan proses terpisah dari hasil klinis dan dari persentase unggahan.
// "Lengkap" berarti tahapan yang diperiksa tersedia, bukan diagnosis pasti benar.
function objek(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nilaiKelengkapanAnalisis(review, { evidencePool, classification, gangguanKode = false, wajibTahap = false } = {}) {
  const ai = objek(review);
  const alasan = [];
  const tambah = (kode, pesan) => { if (!alasan.some(a => a.kode === kode)) alasan.push({ kode, pesan }); };
  if (!ai || !Object.keys(ai).length || ai.analisis_tidak_tersedia === true) {
    tambah('review_ai', 'Review AI belum tersedia. Periksa tahap analisis yang belum selesai.');
  } else {
    const hashLama=ai.pembelajaran_berkas?.hash_bukti_analisis;
    const hashLokal=ai.pembelajaran_dokumen?.hash_bukti_dipelajari;
    if(hashLokal&&hashLokal!==hashLama)tambah('telaah_lokal_tanpa_ai','Bukti operasi telah ditelaah lokal; analisis AI sebelumnya belum diperbarui dari telaah dokumen ini.');
    const berubah=ai.laporan_operasi?.cakupan?.analisis_berkas_berubah===true
      || ((hashLama||hashLokal)&&Array.isArray(evidencePool)&&(hashLama||hashLokal)!==require('./laporanOperasiService').hashBukti(evidencePool));
    if(berubah)tambah('berkas_berubah','Bukti berkas berubah setelah analisis. Analisis harus diperbarui memakai seluruh halaman terbaru.');
    for (const a of ai.gangguan_tahap || []) tambah(a.kode, a.pesan);
    const lama = ai.kelengkapan_analisis;
    if (lama && lama.status !== 'lengkap') {
      const pulih = new Set();
      if (ai.tinjauan_diagnosis && ai.tinjauan_diagnosis.status !== 'belum_dinilai' && !ai.tinjauan_diagnosis.alasan_ditolak) pulih.add('tinjauan_diagnosis');
      if (ai.penalaran_diagnosis?.status === 'selesai') pulih.add('penalaran_diagnosis');
      if (ai.analisis_kritis && ai.analisis_kritis.ai_gagal === false) pulih.add('pemeriksa_kritis');
      if (['selesai','perlu_klarifikasi','tidak_diperlukan'].includes(ai.pemeriksaan_lanjutan?.status)) pulih.add('pemeriksaan_lanjutan');
      if (ai.putusan_pending && ai.putusan_pending.sumber_keputusan !== 'ai_tidak_tersedia') pulih.add('putusan');
      if (['tinjauan_diagnosis','penalaran_diagnosis','pemeriksa_kritis','pemeriksaan_lanjutan','putusan'].every(k => pulih.has(k))) pulih.add('analisis_belum_lengkap');
      for (const a of lama.alasan || []) if (!pulih.has(a.kode)) tambah(a.kode, a.pesan);
      // Ringkasan lama tidak boleh mengunci hasil tahap yang sudah pulih.
      if (!alasan.length && !ai.penalaran_diagnosis && !ai.analisis_kritis)
        tambah('analisis_belum_lengkap', 'Tahapan analisis belum dinyatakan lengkap.');
    }
    if (ai.tinjauan_diagnosis?.alasan_ditolak || ai.tinjauan_diagnosis?.status === 'belum_dinilai')
      tambah('tinjauan_diagnosis', 'Tinjauan diagnosis belum berhasil atau bukti belum cukup untuk menilai pilihan kode.');
    if (['gagal', 'dimatikan'].includes(ai.penalaran_diagnosis?.status))
      tambah('penalaran_diagnosis', 'Penalaran diagnosis belum selesai.');
    if (ai.analisis_kritis?.ai_gagal === true) tambah('pemeriksa_kritis', 'Pemeriksaan kritis AI belum selesai.');
    if (ai.kegawatdaruratan_assessment?.analisis_gagal === true) tambah('kegawatdaruratan', 'Pemeriksaan kegawatdaruratan belum selesai.');
    if (ai.putusan_pending?.sumber_keputusan === 'ai_tidak_tersedia') tambah('putusan', 'Penilaian risiko klaim oleh AI belum tersedia.');
    if (['gagal', 'perlu_lengkapi_berkas'].includes(ai.pemeriksaan_lanjutan?.status))
      tambah('pemeriksaan_lanjutan', 'Pemeriksaan lanjutan yang diperlukan belum selesai.');
    if (wajibTahap) {
      if (!ai.dasar_diagnosis) tambah('dasar_diagnosis', 'Pemeriksaan dasar diagnosis belum tersedia.');
      if (!Array.isArray(ai.temuan_tindakan)) tambah('tindakan', 'Pemeriksaan tindakan belum tersedia.');
      if (!Array.isArray(ai.syarat_penunjang)) tambah('penunjang', 'Pemeriksaan syarat penunjang belum tersedia.');
      if (!ai.putusan_pending) tambah('putusan', 'Penilaian risiko klaim belum selesai.');
      if (!ai.analisis_kritis) tambah('pemeriksa_kritis', 'Pemeriksaan kritis belum tersedia.');
    }
  }
  if (Array.isArray(evidencePool)) {
    const terbaca = new Set(evidencePool.filter(p => String(p.ocr_text || p.text || '').trim().length > 0).map(p => Number(p.page_number)));
    if (!terbaca.size) tambah('bukti_berkas', 'Teks bukti klinis belum terbaca; analisis belum lengkap.');
    const expected = classification?.pages ? classification.pages.filter(p => !p.is_lembar_grouper && !p.is_primary_source).map(p => Number(p.page_num))
      : Array.isArray(ai?.pembacaan_pdf?.halaman_wajib) ? ai.pembacaan_pdf.halaman_wajib : [];
    const kurang = [...new Set(expected.filter(n => Number.isInteger(n) && n > 0 && !terbaca.has(n)))];
    if (kurang.length) tambah('halaman_belum_terbaca', `Halaman ${kurang.join(', ')} belum mempunyai teks bukti. Periksa halaman tersebut pada berkas asli.`);
  }
  if (gangguanKode) tambah('pengisian_kode', 'Penyelarasan kode dan validasi belum selesai.');
  return { versi: 1, status: alasan.length ? (alasan.some(a => a.kode === 'review_ai') ? 'gagal' : 'sebagian') : 'lengkap',
    alasan, catatan: 'Status proses tidak menjamin ketepatan diagnosis atau kesiapan klaim.' };
}

function masalahAnalisisRecord(record = {}, file = {}) {
  const ai = objek(record.ai_review);
  const pdf = /\.pdf$/i.test(String(file.file_path || file.file_name || record.source_file_path || record.source_file_name || ''));
  if (!pdf && !ai) return null; // TXT/CSV tidak wajib melalui analisis PDF.
  const status = nilaiKelengkapanAnalisis(ai, { wajibTahap: pdf });
  return status.status === 'lengkap' ? null : status;
}

module.exports = { nilaiKelengkapanAnalisis, masalahAnalisisRecord };
