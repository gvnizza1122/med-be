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
  // Ambang band vital yang diperbaiki (mis. hipotensi dewasa <90 mmHg) ikut
  // berlaku untuk hasil lama: K2-K4 dihitung ulang dari nilai tersimpan.
  if (Array.isArray(options.pages) && ai.kegawatdaruratan_assessment && !Array.isArray(ai.kegawatdaruratan_assessment)) {
    const segar = require('./kegawatdaruratanAggregation').segarkanKriteriaVital(ai.kegawatdaruratan_assessment, options.pages);
    ai.kegawatdaruratan_assessment = segar.kriteria_disegarkan
      ? { ...segar, ringkasan: require('./aiReviewService').buildRingkasan(segar.kriteria, segar.age_group, 'nilai tanda vital tersimpan (ambang terkini)') }
      : segar;
  }
  if(ai.kegawatdaruratan_assessment&&!Array.isArray(ai.kegawatdaruratan_assessment)) {
    ai.kegawatdaruratan_assessment={...ai.kegawatdaruratan_assessment,
      dokumentasi:require('./dokumentasiKegawatanService').nilaiDokumentasiKegawatan(ai.kegawatdaruratan_assessment)};
  }
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
    ai.pending_risk_notes=(ai.pending_risk_notes || []).filter(n=>n.pattern!=='pneumonia_severity_vs_rawat_inap');
    ai.laporan_operasi=require('./laporanOperasiService').susunLaporanOperasi(options.pages,ai);
    ai.dasar_diagnosis=require('./dasarDiagnosisService').susunDasarDiagnosis(options.pages);
    const final = require('./pemeriksaKritisService').kodeFinal(record, ai);
    const recordReferensi = { ...record, diagnosa_list: final.dx.join(';'), DIAGLIST: final.dx.join(';'),
      prosedur_list: final.px.join(';'), PROCLIST: final.px.join(';'),
      kunjungan_igd: record.kunjungan_igd ?? ai.kegawatdaruratan_assessment?.kunjungan_igd };
    ai.syarat_penunjang = require('./syaratPenunjangService').evaluasiSyaratPenunjang(
      recordReferensi.diagnosa_list,recordReferensi.prosedur_list,options.pages,
      { pakaiBacaLab:true, profil:options.profil, tanggalPelayanan:require('./referensiKlaimService').tanggalRecord(record),
        usia:require('./referensiKlaimService').usiaRecord(record) });
    ai.referensi_klaim = require('./referensiKlaimService').evaluasiReferensiKlaim(recordReferensi,options.pages,{profil:options.profil,kegawatdaruratan:ai.kegawatdaruratan_assessment});
    ai.analisis_kritis = require('./baTkmkbService').perbaruiKritik(ai.analisis_kritis,recordReferensi,options.pages,ai.referensi_klaim.temuan,{profil:options.profil});
    ai.kesesuaian_stt = require('./kesesuaianSttService').nilaiKesesuaianStt({ jenisKlaim: record.jenis_klaim || record.JENIS_KLAIM,
      dx: final.dx, px: final.px, pages: options.pages, tanggal: require('./referensiKlaimService').tanggalRecord(record) });
    ai.pneumonia_anak = require('./pneumoniaAnakService').nilaiPneumoniaAnak({ record, dx: final.dx, pages: options.pages,
      jenisKlaim: record.jenis_klaim || record.JENIS_KLAIM });
    // Konsistensi antar data dihitung ulang dari halaman tersimpan agar aturan
    // yang sudah diperbaiki (mis. KD-01 kini menerima terapi resume/tagihan
    // nebulisasi) tidak meninggalkan alasan pending lama.
    try {
      ai.konsistensi_data = [
        ...require('./konsistensiAntarDataService').evaluasiKonsistensi(recordReferensi, options.pages, ai.temuan_tindakan || []),
        ...require('./konsistensiWaktuService').periksaWaktuTriase(options.pages),
      ];
    } catch (_) { /* tetap memakai hasil tersimpan */ }
  }
  // RV-17 lama berasal dari larangan rawat inap menyeluruh yang sudah diperbaiki.
  errors = errors.filter(e => e.rule_id !== 'RV-17');
  const analisis = masalahAnalisisRecord({...record,ai_review:ai});
  const raw = objek(record.raw_data);
  const sep = String(record.sep || record.SEP || raw.SEP || '').trim();
  const penjaminan = sep && !/^(0|-|null|undefined|n\/a)$/i.test(sep)
    ? { jenis: 'BPJS', dasar: 'SEP', catatan: 'Penjamin BPJS mengikuti SEP. Label UMUM pada resume tidak menjadi alasan pending.' }
    : null;
  const kombinasi = evaluasiKombinasiKode(record.diagnosa_list ?? record.DIAGLIST ?? raw.DIAGLIST ?? '',
    { px: record.prosedur_list ?? record.PROCLIST ?? raw.PROCLIST ?? null });
  // Aturan 'telaah' butuh konteks klinis; hanya aturan koding pasti yang membuat belum siap upload.
  const kombinasiPasti = kombinasi.filter(k => k.aksi !== 'telaah');
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
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Cakupan usia')
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Telaah catatan casemix')
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Telaah rekomendasi TKMKB')
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Versi berkas')
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Kesesuaian STT (BA 2024)')
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'PNPK IDAI pneumonia anak')
      // Kalimat alasan kegawatdaruratan disusun ulang dari penilaian tersimpan (bukan AI ulang).
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Kriteria kegawatdaruratan')
      && !(Array.isArray(options.pages) && ['BA kesepakatan 2018', 'BA kesepakatan Kemenkes-BPJS', 'PNPK Kemenkes'].includes(a.sumber_pemeriksaan))
      // Alasan konsistensi yang tidak lagi terpicu dibuang; yang baru tidak ditambah di sini.
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Konsistensi antar data' && !konsistensi.some(k => k.id === a.kode))
      && !(Array.isArray(options.pages) && a.sumber_pemeriksaan === 'Syarat penunjang diagnosis'));
    const alasan = [...sisa, ...susunPutusan({ kombinasi_kode: kombinasi,
      ...(Array.isArray(options.pages) ? {kegawatdaruratan_assessment:ai.kegawatdaruratan_assessment,syarat_penunjang:ai.syarat_penunjang,referensi_klaim:ai.referensi_klaim,laporan_operasi:ai.laporan_operasi,kesesuaian_stt:ai.kesesuaian_stt,pneumonia_anak:ai.pneumonia_anak} : {}) }).alasan];
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
      status: kombinasiPasti.length ? 'berisiko_pending' : kombinasi.length ? 'perlu_telaah_koding' : 'tidak_ada_temuan_kombinasi',
      judul: kombinasiPasti.length ? 'Berisiko pending · belum siap upload' : kombinasi.length ? 'Koding perlu ditelaah sebelum upload' : 'Tidak ada temuan kombinasi kode',
      alasan: kombinasi.map(k => ({ kode: k.kode, nama: k.nama, pesan: k.pesan, kode_asal: [...k.kode_utama, ...k.kode_terdampak], kode_saran: k.kode_gabungan || k.kode_saran || null })),
    },
  };
}
module.exports = { perbaruiRisikoTampilan };
