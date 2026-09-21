/**
 * Modul khusus diagnosis Pneumonia (J12-J18, termasuk kombo COVID U07.1+J12.89
 * -- J12.89 sendiri sudah tercakup pola J1[2-8], jadi tidak perlu penanganan
 * terpisah utk U07.1) -- MURNI kode deterministik, TIDAK ada panggilan AI di
 * sini, sama seperti kegawatdaruratanAggregation.js. Sumber klinis: PNPK
 * Tatalaksana Pneumonia pada Anak (IDAI, ditinjau 5 SpA(K)), rujukan WHO 2014
 * Revised Classification & Kemenkes 2018 Tatalaksana Pneumonia Balita di FKTP.
 *
 * SCOPE (keputusan 12-13 Sep 2026, lihat diskusi dgn user/peer):
 * - HANYA utk pasien pediatrik 0-5 tahun (age_group neonatus/bayi/toddler/
 *   prasekolah) -- PNPK ini sendiri cuma cakup rentang itu, TIDAK dipaksakan
 *   ke usia_sekolah/remaja/dewasa/lansia (banyak klaim pneumonia riil RS ini
 *   justru dewasa/lansia -- di luar cakupan modul ini, sengaja tidak ditebak).
 * - HANYA jalan kalau kegawatdaruratan_assessment SUDAH ADA (record lewat
 *   Triase IGD) -- piggyback pada data Tabel 1/2 yang SUDAH diekstrak &
 *   divalidasi (anti-halusinasi sudah dilakukan di assessKegawatdaruratan),
 *   TIDAK menduplikasi ekstraksi/validasi kutipan sendiri.
 * - TIDAK mencoba tingkat "sangat berat" (butuh tanda bahaya yang TIDAK
 *   diekstrak di manapun di pipeline ini: tidak mau minum/menetek, kejang,
 *   muntah terus-menerus, stridor, gizi buruk) -- flagged sbg gap yang
 *   disengaja, BUKAN ditebak/di-skip diam-diam.
 * - TIDAK mencoba Kriteria PICU maupun "syarat pulang" (discharge-readiness)
 *   -- tidak ada data terekstrak utk itu & yang kedua bertentangan dgn prinsip
 *   desain "Tabel 1/2 = kondisi SAAT TRIASE saja" yang sudah dipertahankan
 *   sepanjang malam ini -- lihat diskusi dgn user/peer, keputusan: tidak
 *   dibangun.
 */

const { THRESHOLD_TABLE } = require('./kegawatdaruratanReference');

const PNEUMONIA_CODE_RE = /^J1[2-8]/i;

function extractPneumoniaCodes(diagnosaList) {
  if (!diagnosaList || typeof diagnosaList !== 'string') return [];
  return diagnosaList.split(';').map(c => c.trim()).filter(c => PNEUMONIA_CODE_RE.test(c));
}

// PNPK punya 2 tier usia (bayi <2 bulan / anak 2bln-5th), TIDAK selaras 1:1
// dengan bucket age_group sistem ini (neonatus/bayi/toddler/prasekolah) --
// bucket "bayi" (1-12 bulan) melintasi split PNPK di 2 bulan. Sama seperti
// keputusan RR (kegawatdaruratanReference.js), neonatus (0-28 hari) SELURUHNYA
// masuk "<2 bulan" (tidak ambigu); bucket "bayi" dipetakan ke tier "anak"
// (2bln-5th) krn MAYORITAS bucket itu (2-12bln) ada di sisi itu -- konsisten
// dgn keputusan RR yg sama, bukan pilihan baru.
// PENTING: "band==='gawat'" pada RR mencakup DUA arah -- napas terlalu CEPAT
// (tachypnea, ambang PNPK) MAUPUN terlalu LAMBAT (bradypnea, ambang lama/
// PALS di sisi bawah, tidak diubah). Kriteria WHO pneumonia HANYA soal napas
// CEPAT -- kalau dipakai band mentah, RR yang gawat krn LAMBAT (mis. hasil
// ekstraksi RR=0, kemungkinan artefak) akan salah dihitung sbg "napas cepat".
// Cek LANGSUNG terhadap ambang atas (gawatOver) dari THRESHOLD_TABLE, bukan
// via band gabungan, supaya cuma arah tachypnea yang terhitung.
function isTachypnea(rrFinding, ageGroup) {
  if (!rrFinding || typeof rrFinding.nilai !== 'number') return false;
  const band = THRESHOLD_TABLE.RR?.[ageGroup];
  if (!band || typeof band.gawatOver !== 'number') return false;
  return rrFinding.nilai > band.gawatOver;
}

function resolvePneumoniaAgeTier(ageGroup) {
  if (ageGroup === 'neonatus') return 'muda'; // PNPK "Bayi <2 bulan"
  if (ageGroup === 'bayi' || ageGroup === 'toddler' || ageGroup === 'prasekolah') return 'anak'; // PNPK "Anak 2bln-5th"
  return null; // usia_sekolah/remaja/dewasa/lansia/tidak diketahui -- di luar cakupan PNPK ini
}

/**
 * @returns {'berat'|'ringan'|'tidak_pasti'|'tidak_ada_kriteria'}
 *   'tidak_pasti' -- retraksi ada tapi kombinasi/grade tidak cukup jelas utk
 *   diklasifikasi pasti sbg berat/ringan per definisi WHO baku -- JANGAN
 *   dipaksakan salah satu, dipakai sbg alasan TIDAK melapor (lebih baik diam).
 */
function computeSeverityTier(ageTier, { napasCepat, retraksiPresent, retraksiGrade }) {
  if (ageTier === 'muda') {
    // Pneumonia berat (WHO, bayi <2bln): napas cepat (>=60) ATAU retraksi YANG BERAT.
    // "retraksi yang berat" per PNPK = interkostal -- retraksi present tanpa grade
    // eksplisit (subkostal atau grade null) TIDAK otomatis dihitung "berat" di sini.
    if (napasCepat || retraksiGrade === 'interkostal') return 'berat';
    if (retraksiPresent) return 'tidak_pasti';
    return 'ringan';
  }
  if (ageTier === 'anak') {
    // WHO (anak 2bln-5th): napas cepat TANPA retraksi = pneumonia (ringan).
    // napas cepat DAN retraksi = pneumonia berat.
    if (napasCepat && retraksiPresent) return 'berat';
    if (napasCepat && !retraksiPresent) return 'ringan';
    if (!napasCepat && retraksiPresent) return 'tidak_pasti'; // retraksi tanpa napas cepat -- di luar pola WHO baku
    return 'tidak_ada_kriteria'; // keduanya tidak ditemukan di Tabel 1/2
  }
  return 'tidak_pasti';
}

/**
 * Bandingkan tingkat keparahan pneumonia (dihitung dari Tabel 1/2 Triase IGD
 * yang SUDAH ada) terhadap jenis klaim yang ditagihkan (RAWAT_INAP/GAWAT_
 * DARURAT) -- soft-flag kalau TIDAK ADA bukti WHO Pneumonia Berat maupun
 * tanda bahaya (SpO2<=92%/sianosis, bagian Kriteria Rawat Inap PNPK) yang
 * mendukung level itu. MURNI kode, tidak ada panggilan AI -- return null
 * kalau tidak relevan/tidak bisa dinilai (JANGAN memaksa kalau datanya tidak
 * cukup).
 * @param {string} diagnosaList
 * @param {Object|Array|null} kegawatdaruratanAssessment - hasil assessKegawatdaruratan (bentuk baru)
 * @param {string} jenisKlaim
 * @param {boolean} [isKunjunganIgd] - berkas ini kunjungan IGD (dari isi dokumen, lihat hasIgdVisitSignal)
 * @returns {{pattern:string,page_number:number|null,basis:string,note:string}|null}
 */
function assessPneumoniaSeverityMismatch(diagnosaList, kegawatdaruratanAssessment, jenisKlaim, isKunjunganIgd) {
  const pneumoniaCodes = extractPneumoniaCodes(diagnosaList);
  if (pneumoniaCodes.length === 0) return null;

  // Hanya relevan utk klaim yg menagih level rawat-inap/gawat-darurat -- tidak
  // ada dasar utk menilai RAWAT_JALAN terhadap Kriteria Rawat Inap.
  // Kunjungan IGD dikenali dari ISI dokumen, bukan dari kategori klaim:
  // kategori GAWAT_DARURAT dihapus 21 Sep 2026 dan berkas IGD kini
  // berkategori RAWAT_JALAN, jadi cek kategori saja akan mematikan
  // penilaian ini untuk semua berkas IGD.
  if (jenisKlaim !== 'RAWAT_INAP' && !isKunjunganIgd) return null;

  // Data lama (array, pra-restrukturisasi) atau memang tidak ada (bukan lewat
  // Triase IGD) -- tidak bisa dinilai, JANGAN memaksa/menebak.
  if (!kegawatdaruratanAssessment || Array.isArray(kegawatdaruratanAssessment)
    || !Array.isArray(kegawatdaruratanAssessment.parameter_findings)) return null;

  const ageTier = resolvePneumoniaAgeTier(kegawatdaruratanAssessment.age_group);
  if (!ageTier) return null; // di luar cakupan PNPK (bukan pediatrik 0-5th) atau usia tidak diketahui

  const paramByKey = new Map(kegawatdaruratanAssessment.parameter_findings.map(p => [p.key, p]));
  const retraksiParam = paramByKey.get('retraksi');
  const sianosisParam = paramByKey.get('sianosis');
  const rrFinding = kegawatdaruratanAssessment.vital_findings?.RR;
  const spo2Finding = kegawatdaruratanAssessment.vital_findings?.SpO2;

  const retraksiPresent = retraksiParam?.ditemukan === true && retraksiParam.status === 'abnormal';
  const retraksiGrade = retraksiParam?.retraksi_grade || null;
  const napasCepat = isTachypnea(rrFinding, kegawatdaruratanAssessment.age_group);
  const sianosisPresent = sianosisParam?.ditemukan === true && sianosisParam.status === 'abnormal';
  // Kriteria Rawat Inap PNPK poin 1: SpO2<=92% -- BEDA dari ambang gawat umum
  // K2 (<90) yang sudah ada di THRESHOLD_TABLE.SpO2 -- sengaja tidak menimpa
  // band umum itu, dicek terpisah di sini pakai angka mentah.
  const spo2Low = typeof spo2Finding?.nilai === 'number' && spo2Finding.nilai <= 92;

  const severity = computeSeverityTier(ageTier, { napasCepat, retraksiPresent, retraksiGrade });
  const hasDangerVital = sianosisPresent || spo2Low;

  if (severity === 'berat') return null; // ada bukti WHO Pneumonia Berat, tidak perlu flag
  if (severity === 'tidak_pasti') return null; // ambigu -- lebih baik diam daripada menuduh
  if (hasDangerVital) return null; // ada tanda bahaya lain yg cukup jadi dasar rawat inap/gawat darurat

  // severity 'ringan' atau 'tidak_ada_kriteria', DAN tidak ada tanda bahaya --
  // pakai kutipan yang SUDAH tervalidasi (anti-halusinasi) dari Tabel 1/2,
  // TIDAK perlu validasi ulang.
  const evidence = (rrFinding?.kutipan && rrFinding.page_number) ? { kutipan: rrFinding.kutipan, page_number: rrFinding.page_number }
    : (retraksiParam?.kutipan && retraksiParam.page_number) ? { kutipan: retraksiParam.kutipan, page_number: retraksiParam.page_number }
      : null;
  if (!evidence) return null; // tidak ada kutipan tervalidasi apapun -- jangan melapor tanpa basis

  const ageTierLabel = ageTier === 'muda' ? 'bayi di bawah 2 bulan' : 'anak 2 bulan-5 tahun';
  const jenisLabel = isKunjunganIgd ? 'gawat darurat' : 'rawat inap';
  const note = `Diagnosis pneumonia (kode ${pneumoniaCodes.join(', ')}) ditagihkan sebagai klaim ${jenisLabel} untuk pasien kelompok usia ${ageTierLabel}, tetapi Tabel 1/2 (data dari formulir Triase IGD) tidak menunjukkan kriteria WHO Pneumonia Berat (napas cepat dan/atau retraksi dinding dada, per PNPK Tatalaksana Pneumonia pada Anak IDAI) maupun tanda bahaya lain pada Kriteria Rawat Inap PNPK (saturasi oksigen rendah/sianosis). Ini bahan cek klinis, SARAN untuk verifikator/koder memastikan bukti keparahan tercatat di tempat lain (mis. hasil radiologis, catatan naratif dokter) yang tidak tertangkap Tabel 1/2 Triase -- BUKAN tuduhan bahwa keputusan rawat inap/gawat daruratnya pasti tidak tepat.`;

  return {
    pattern: 'pneumonia_severity_vs_rawat_inap',
    page_number: evidence.page_number,
    basis: evidence.kutipan,
    note,
  };
}

module.exports = { assessPneumoniaSeverityMismatch, extractPneumoniaCodes, resolvePneumoniaAgeTier, computeSeverityTier };
