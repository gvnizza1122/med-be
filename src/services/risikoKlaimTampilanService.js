/** Penilaian untuk tampilan: tidak menulis kode, status, tarif, atau data pasien. */
const { evaluasiKombinasiKode } = require('./ketentuanKlaimService');
const { susunPutusan, segarkanAlasanValidasi } = require('./putusanPendingService');
const { masalahAnalisisRecord } = require('./kelengkapanAnalisisService');

function objek(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function perbaruiRisikoTampilan(record = {}, errors = [], options = {}) {
  const ai = { ...objek(record.ai_review) };
  // Hasil lama ikut aturan grouper terkini tanpa OCR/AI ulang. Ini hanya
  // perkiraan untuk tampilan; tidak menulis hasil resmi maupun kode pasien.
  if (ai.inacbg_result && ['RAWAT_INAP', 'RAWAT_JALAN'].includes(record.jenis_klaim || record.JENIS_KLAIM)) {
    const final = require('./pemeriksaKritisService').kodeFinal(record, ai);
    if (final.dx.length) {
      const h = require('./aiReviewService').hitungInacbgDanTarif(final.dx, final.px,
        record.jenis_klaim || record.JENIS_KLAIM, require('./kelasPerawatanService').kelasTarif(record), null);
      ai.inacbg_result = h.inacbgResult;
      ai.tariff_result = h.tarifResult;
      ai.suggested_inacbg = h.inacbgCodeForLookup || '';
      ai.suggested_tarif = h.tarifResult?.amount ?? null;
    }
  }
  if (Array.isArray(options.pages)) {
    ai.dasar_diagnosis=require('./dasarDiagnosisService').susunDasarDiagnosis(options.pages);
    const final = require('./pemeriksaKritisService').kodeFinal(record, ai);
    const recordReferensi = { ...record, diagnosa_list: final.dx.join(';'), DIAGLIST: final.dx.join(';'),
      prosedur_list: final.px.join(';'), PROCLIST: final.px.join(';'),
      kunjungan_igd: record.kunjungan_igd ?? ai.kegawatdaruratan_assessment?.kunjungan_igd };
    ai.syarat_penunjang = require('./syaratPenunjangService').evaluasiSyaratPenunjang(
      recordReferensi.diagnosa_list,recordReferensi.prosedur_list,options.pages,
      { pakaiBacaLab:true, profil:options.profil, tanggalPelayanan:require('./referensiKlaimService').tanggalRecord(record) });
    ai.referensi_klaim = require('./referensiKlaimService').evaluasiReferensiKlaim(recordReferensi,options.pages,{profil:options.profil});
  }
  // RV-17 lama berasal dari larangan rawat inap menyeluruh yang sudah diperbaiki.
  errors = errors.filter(e => e.rule_id !== 'RV-17');
  const analisis = masalahAnalisisRecord({...record,ai_review:ai});
  const raw = objek(record.raw_data);
  const sep = String(record.sep || record.SEP || raw.SEP || '').trim();
  const penjaminan = sep && !/^(0|-|null|undefined|n\/a)$/i.test(sep)
    ? { jenis: 'BPJS', dasar: 'SEP', catatan: 'Penjamin BPJS mengikuti SEP. Label UMUM pada resume tidak menjadi alasan pending.' }
    : null;
  const kombinasi = evaluasiKombinasiKode(record.diagnosa_list ?? record.DIAGLIST ?? raw.DIAGLIST ?? '');
  const konsistensi = (ai.konsistensi_data || []).filter(k => k && k.id !== 'KD-02');
  let putusan = ai.putusan_pending;
  if (!putusan || !Array.isArray(putusan.alasan)) {
    putusan = Object.keys(ai).length || kombinasi.length || errors.length
      ? susunPutusan({ ...ai, konsistensi_data: konsistensi, kombinasi_kode: kombinasi }, errors) : null;
  } else {
    putusan = segarkanAlasanValidasi(putusan, errors) || putusan;
    // Evaluasi kombinasi dari kode tersimpan saat ini, bukan dari saran AI.
    // Alasan klinis lain yang dipilih sebelumnya tetap dibawa.
    const sisa = putusan.alasan.filter(a => a && a.kode !== 'KD-02' && a.kode !== 'RV-17'
      && a.sumber_pemeriksaan !== 'Ketentuan kombinasi kode'
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Referensi klaim BPJS')
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Syarat penunjang diagnosis'));
    const alasan = [...sisa, ...susunPutusan({ kombinasi_kode: kombinasi,
      ...(Array.isArray(options.pages) ? {syarat_penunjang:ai.syarat_penunjang,referensi_klaim:ai.referensi_klaim} : {}) }).alasan];
    const berubah = JSON.stringify(alasan) !== JSON.stringify(putusan.alasan);
    if (berubah) {
      const berat = alasan.filter(a => a.wajib_pending || ['tinggi', 'critical'].includes(a.keparahan));
      const status = berat.length ? 'berisiko_pending' : alasan.length ? 'perlu_dicek' : 'tidak_ditemukan_alasan';
      putusan = {
        ...putusan, status, alasan,
        ringkasan: berat.length ? `Ada ${berat.length} hal yang berisiko membuat klaim ini dipending.`
          : alasan.length ? `Ada ${alasan.length} hal yang perlu diperiksa sebelum upload.` : 'Belum ada temuan risiko tambahan.',
        jumlah: { ...putusan.jumlah, total: alasan.length, berat: berat.length, dari_rekap_pending: alasan.filter(a => a.dari_rekap_pending).length },
        sumber_pembaruan: 'aturan_saat_ini',
      };
    }
  }
  return {
    ...ai,
    ...(analisis ? { kelengkapan_analisis: analisis } : {}),
    konsistensi_data: konsistensi,
    kombinasi_kode: kombinasi,
    putusan_pending: putusan,
    penjaminan,
    kesiapan_koding: {
      status: kombinasi.length ? 'berisiko_pending' : 'tidak_ada_temuan_kombinasi',
      judul: kombinasi.length ? 'Berisiko pending · belum siap upload' : 'Tidak ada temuan kombinasi kode',
      alasan: kombinasi.map(k => ({ kode: k.kode, nama: k.nama, pesan: k.pesan, kode_asal: [...k.kode_utama, ...k.kode_terdampak], kode_saran: k.kode_gabungan })),
    },
  };
}
module.exports = { perbaruiRisikoTampilan };
