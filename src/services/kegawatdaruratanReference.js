/**
 * Data referensi untuk restrukturisasi tampilan Kegawatdaruratan jadi 3 tabel
 * (Tabel 1: Parameter, Tabel 2: Ambang Batas, Tabel 3: Agregasi Kriteria) --
 * menggantikan TOTAL model lama (AI freeform judgment per kriteria a-e, lihat
 * KEGAWATDARURATAN_LABELS lama di aiReviewService.js). Keputusan 10-11 Sep 2026.
 *
 * Data-driven, BUKAN hardcoded di logic pemanggil -- Tabel 1 eksplisit
 * dilabeli "parameter wajib ditangani sistem, minimal" oleh sumbernya,
 * jadi array ini harus mudah ditambah tanpa refactor besar di tempat lain.
 *
 * Sumber ambang batas dewasa: draft tabel dari pengguna (BA Kesepakatan/
 * referensi internal RS). Sumber ambang batas anak/bayi: PALS-standard
 * (cross-checked 2 sumber independen, lihat catatan per parameter). Sumber
 * lansia: TIDAK ada tabel numerik baku di literatur (beda dari anak yang
 * punya PALS) -- HANYA ambang HR yang diturunkan sesuai keputusan eksplisit
 * pengguna (opsi A: <60 atau >100, turun dari dewasa <50/>120), parameter
 * lain pakai band dewasa karena tidak ada dasar literatur kuat untuk geser.
 */

// ===== TABEL 1: Parameter checklist (per-record, dari dokumen Triase IGD) =====
const PARAMETER_TABLE = [
  { key: 'ronkhi', label: 'Ronkhi (Rh)', sistem_tubuh: 'Respirasi', contoh_normal: '(-/-)', contoh_abnormal: '(+/+) -- cairan/sekret paru', kriteria_terkait: ['K2'] },
  { key: 'wheezing', label: 'Wheezing (Wh)', sistem_tubuh: 'Respirasi', contoh_normal: '(-/-)', contoh_abnormal: '(+/+) -- obstruksi jalan napas', kriteria_terkait: ['K2'] },
  { key: 'sdv', label: 'Suara napas dasar (SDV)', sistem_tubuh: 'Respirasi', contoh_normal: 'vesikuler (+/+)', contoh_abnormal: 'menurun/menghilang', kriteria_terkait: ['K2'] },
  { key: 'retraksi', label: 'Retraksi dinding dada', sistem_tubuh: 'Respirasi', contoh_normal: 'tidak ada', contoh_abnormal: 'ada (ringan/sedang/berat)', kriteria_terkait: ['K2'] },
  { key: 'sianosis', label: 'Sianosis', sistem_tubuh: 'Respirasi/Sirkulasi', contoh_normal: 'tidak ada', contoh_abnormal: 'ada (perioral/perifer/sentral)', kriteria_terkait: ['K2'] },
  { key: 'akral', label: 'Akral', sistem_tubuh: 'Sirkulasi', contoh_normal: 'hangat, kering', contoh_abnormal: 'dingin, basah, pucat', kriteria_terkait: ['K2', 'K4'] },
  { key: 'crt', label: 'CRT (capillary refill time)', sistem_tubuh: 'Sirkulasi', contoh_normal: '<2 detik', contoh_abnormal: '>=2 detik', kriteria_terkait: ['K2', 'K4'] },
  { key: 'edema', label: 'Edema ekstremitas', sistem_tubuh: 'Ekstremitas', contoh_normal: '(-/-/-/-)', contoh_abnormal: 'ada, derajat/pitting', kriteria_terkait: ['K4'] },
  { key: 'bunyi_jantung', label: 'Bunyi jantung tambahan', sistem_tubuh: 'Kardiovaskular', contoh_normal: 'reguler, tanpa murmur', contoh_abnormal: 'gallop/murmur', kriteria_terkait: ['K4'] },
  { key: 'kesadaran_kualitatif', label: 'Kesadaran kualitatif', sistem_tubuh: 'Neurologis', contoh_normal: 'compos mentis', contoh_abnormal: 'somnolen/sopor/koma', kriteria_terkait: ['K3'] },
  { key: 'deformitas_luka', label: 'Deformitas/luka', sistem_tubuh: 'Trauma', contoh_normal: 'tidak ada', contoh_abnormal: 'ada, deskripsi', kriteria_terkait: ['K1'] },
];

// ===== Kelompok usia =====
const AGE_GROUP_LABELS = {
  neonatus: 'Neonatus (0-28 hari)',
  bayi: 'Bayi (1-12 bulan)',
  toddler: 'Toddler (1-2 tahun)',
  prasekolah: 'Prasekolah (3-5 tahun)',
  usia_sekolah: 'Usia sekolah (6-11 tahun)',
  remaja: 'Remaja (12-15 tahun)',
  dewasa: 'Dewasa (16-64 tahun)',
  lansia: 'Lansia (>=65 tahun)',
};

/**
 * Tentukan kelompok usia dari UMUR_TAHUN/UMUR_HARI record. Return null kalau
 * umur tidak diketahui -- pemanggil WAJIB menangani null (jangan asumsikan
 * dewasa secara diam-diam, band jadi tidak bisa dihitung untuk kasus itu).
 */
function resolveAgeGroup(umurTahun, umurHari) {
  // PENTING: cek null/undefined SEBELUM Number() -- Number(null) coerce jadi 0
  // (bukan NaN), jadi umur yang genuinely tidak diketahui bisa salah kebaca
  // sebagai "0 hari" (neonatus) kalau tidak dijaga eksplisit di sini.
  const hasHari = umurHari !== null && umurHari !== undefined && umurHari !== '' && Number.isFinite(Number(umurHari)) && Number(umurHari) >= 0;
  const hasTahun = umurTahun !== null && umurTahun !== undefined && umurTahun !== '' && Number.isFinite(Number(umurTahun)) && Number(umurTahun) >= 0;
  const tahun = hasTahun ? Number(umurTahun) : NaN;
  const hari = hasHari ? Number(umurHari) : NaN;
  if (!hasHari && !hasTahun) return null;
  if (hasHari && hari <= 28 && (!hasTahun || tahun < 1)) return 'neonatus';
  if ((hasHari && hari <= 365 && (!hasTahun || tahun < 1)) || (hasTahun && tahun < 1)) return 'bayi';
  if (!hasTahun) return null;
  if (tahun <= 2) return 'toddler';
  if (tahun <= 5) return 'prasekolah';
  if (tahun <= 11) return 'usia_sekolah';
  if (tahun <= 15) return 'remaja';
  if (tahun >= 65) return 'lansia';
  return 'dewasa';
}

// ===== TABEL 2: Ambang batas referensi (master data, bukan per-record) =====
// Setiap parameter: { [ageGroup]: { normal:[min,max], borderline:[min,max]|[[min,max],[min,max]], gawatUnder, gawatOver } }
// gawatUnder/gawatOver dipakai untuk parameter dengan definisi gawat sebagai
// "di luar satu sisi" (mis. RR anak: gawat kalau di luar rentang normal, tidak
// ada borderline eksplisit di sumber PALS -- beda dari tabel dewasa yang punya
// borderline eksplisit).
const THRESHOLD_TABLE = {
  RR: {
    unit: 'x/mnt',
    dewasa: { normal: [12, 20], borderline: [[21, 29], [10, 11]], gawatUnder: 10, gawatOver: 29 },
    lansia: { normal: [12, 20], borderline: [[21, 29], [10, 11]], gawatUnder: 10, gawatOver: 29 }, // sama dewasa, tidak ada dasar literatur kuat u/ geser (lihat catatan file)
    remaja: { normal: [12, 20], gawatUnder: 12, gawatOver: 20 }, // konvergen dgn dewasa di usia remaja per PALS
    usia_sekolah: { normal: [18, 30], gawatUnder: 18, gawatOver: 30 }, // di luar cakupan PNPK (cuma s/d 5 th) -- tetap PALS
    // --- Ambang atas (gawatOver) untuk toddler/prasekolah/bayi/neonatus di
    // bawah diganti 12 Sep 2026 dari sumber PALS umum ke PNPK Tatalaksana
    // Pneumonia pada Anak (IDAI, ditinjau 5 SpA(K)), butir "Batasan napas
    // cepat" -- rujukan WHO 2014 Revised Classification & Kemenkes 2018
    // Tatalaksana Pneumonia Balita di FKTP:
    //   0 - <2 bulan: >=60 x/mnt   | 2 - <12 bulan: >=50 x/mnt   | 1-5 th: >=40 x/mnt
    // Ini SATU ambang alarm (bukan struktur normal/borderline/gawat 3-tingkat)
    // -- dipakai sbg gawatOver (>=X gawat) apa adanya, TIDAK menambah borderline
    // buatan sendiri (prinsip: jangan menebak ambang klinis yang tidak ada
    // dasarnya). gawatUnder (napas terlalu lambat) TIDAK dibahas PNPK ini --
    // dipertahankan dari angka PALS lama, tidak diubah.
    // Catatan encoding: "gawat jika >=X" ditulis gawatOver:(X-1) supaya "v >
    // gawatOver" (operator kode, strict >) berlaku sama dgn ">=X" PNPK.
    //
    // Sebaran umur PNPK vs kelompok umur sistem ini TIDAK 1:1:
    // - neonatus (0-28 hari) seluruhnya masuk "0-<2 bulan" PNPK -- >=60 dipakai langsung, tidak ambigu.
    // - bayi (1-12 bulan) sistem ini MELINTASI split PNPK di 2 bulan (mayoritas
    //   bucket, umur 2-12bln, ada di sisi ">=50"; cuma umur 1-<2bln yg masuk
    //   ">=60"). Dipilih pakai ambang LEBIH KETAT (>=50) utk SELURUH bucket
    //   bayi -- arah lebih sensitif/aman utk soft-flag verifikator (bisa
    //   sedikit over-flag bayi 1-<2bln, tapi tidak pernah under-flag bayi
    //   2-12bln yang jadi mayoritas bucket). TIDAK memecah bucket bayi jadi
    //   lebih halus (butuh restrukturisasi resolveAgeGroup/label/agregasi) --
    //   flagged ke user/peer sbg keputusan, bukan ditebak diam-diam.
    // - toddler (1-2th) & prasekolah (3-5th) SAMA-SAMA masuk "1-5 tahun" PNPK
    //   (PNPK tidak memecah lebih halus di rentang ini) -- keduanya pakai
    //   >=40 yang sama; batas bawah (gawatUnder) masing-masing TETAP beda
    //   (24 vs 22, warisan PALS lama) karena PNPK tidak membahas batas bawah.
    prasekolah: { normal: [22, 39], gawatUnder: 22, gawatOver: 39 }, // PNPK 1-5th: gawat >=40
    toddler: { normal: [24, 39], gawatUnder: 24, gawatOver: 39 }, // PNPK 1-5th: gawat >=40
    bayi: { normal: [30, 49], gawatUnder: 30, gawatOver: 49 }, // PNPK 2-<12bln (ambang lebih ketat dipakai u/ seluruh bucket): gawat >=50
    neonatus: { normal: [30, 59], gawatUnder: 30, gawatOver: 59 }, // PNPK 0-<2bln: gawat >=60
  },
  SpO2: {
    unit: '%',
    // "sama untuk semua usia" per sumber -- satu band dipakai untuk semua ageGroup.
    _all: { normal: [95, 100], borderline: [90, 94], gawatUnder: 90 },
  },
  HR: {
    unit: 'x/mnt',
    dewasa: { normal: [60, 100], borderline: [[101, 120], [50, 59]], gawatUnder: 50, gawatOver: 120 },
    lansia: { normal: [60, 100], borderline: null, gawatUnder: 60, gawatOver: 100, catatan: 'Ambang diturunkan dari dewasa (<50/>120) sesuai keputusan eksplisit -- respons fisiologis lansia terhadap penyakit akut cenderung tumpul, HR >90-100 saja bisa jadi tanda sepsis/gawat pada lansia walau "normal" secara angka dewasa. Bukan hasil lookup tabel baku, ini judgment klinis yang sudah dikonfirmasi.' },
    remaja: { normal: [60, 100], gawatUnder: 60, gawatOver: 100 },
    usia_sekolah: { normal: [75, 118], gawatUnder: 75, gawatOver: 118 },
    prasekolah: { normal: [80, 120], gawatUnder: 80, gawatOver: 120 },
    toddler: { normal: [98, 140], gawatUnder: 98, gawatOver: 140 },
    bayi: { normal: [100, 190], gawatUnder: 100, gawatOver: 190 },
    neonatus: { normal: [100, 205], gawatUnder: 100, gawatOver: 205 },
  },
  TD_sistolik: {
    unit: 'mmHg',
    dewasa: { normal: [90, 140], borderline: [[141, 179], [80, 89]], gawatUnder: 80, gawatOver: 180 },
    lansia: { normal: [90, 140], borderline: [[141, 179], [80, 89]], gawatUnder: 80, gawatOver: 180 }, // sama dewasa, tidak ada dasar literatur kuat u/ geser
    remaja: { normal: [112, 128], gawatUnder: 90 },
    // Ambang hipotensi pediatrik baku PALS sebenarnya rumus dinamis 70+(usia_tahun x2)
    // mmHg, BUKAN angka statis -- diaproksimasi jadi angka statis per kelompok usia
    // di bawah supaya implementasi sederhana (band ini SEKADAR sinyal advisory untuk
    // verifikator, bukan gerbang otomatis yang memblokir klaim), lihat catatan.
    usia_sekolah: { normal: [97, 115], gawatUnder: 82, catatan: 'Ambang gawat PALS sebenarnya rumus 70+(usia x2) mmHg, diaproksimasi statis di sini.' },
    prasekolah: { normal: [89, 112], gawatUnder: 78, catatan: 'Ambang gawat PALS sebenarnya rumus 70+(usia x2) mmHg, diaproksimasi statis di sini.' },
    toddler: { normal: [86, 106], gawatUnder: 74, catatan: 'Ambang gawat PALS sebenarnya rumus 70+(usia x2) mmHg, diaproksimasi statis di sini.' },
    bayi: { normal: [72, 104], gawatUnder: 70 },
    neonatus: { normal: [67, 84], gawatUnder: 60 },
  },
  // TD_diastolik: ditambah 14 Sep 2026 (sebelumnya TIDAK ditrack sama sekali
  // -- cuma sistolik). Band anak (neonatus s/d usia_sekolah) angka NORMAL
  // langsung dari PALS (WebSearch cross-check, sumber sama kelasnya dgn HR/
  // TD_sistolik di atas -- PassYourPALS/PedsCases/AAP, bukan infografis tanpa
  // sumber yang jadi pemicu penambahan parameter ini). gawatUnder dipakai =
  // batas bawah normal PALS ITU SENDIRI (tanpa borderline buatan) karena TIDAK
  // ditemukan rumus dinamis PALS khusus hipotensi diastolik anak (beda dari
  // TD_sistolik yang punya rumus 70+usia x2 eksplisit) -- prinsip yang sama
  // dipakai di RR: jangan menebak ambang klinis yang tidak ada dasarnya.
  // gawatOver (diastolik terlalu tinggi) SENGAJA tidak diisi untuk semua
  // kelompok anak, sama seperti TD_sistolik anak -- hipertensi diastolik anak
  // tidak dibahas literatur PALS yang dipakai, dan bukan fokus gawat-darurat
  // akut (beda dgn hipotensi/syok). remaja pakai band Adolescent (12-15th)
  // PALS langsung, bukan reuse angka dewasa (beda dari TD_sistolik remaja yg
  // gawatUnder-nya reuse angka dewasa 90 -- di sini dipakai batas normal PALS
  // sendiri, 64, supaya konsisten dgn kelompok anak lain, tidak ada dasar utk
  // ikut pola lama yg sedikit tidak konsisten itu).
  // dewasa/lansia: TIDAK ada tabel diastolik baku sekelas PALS/BA internal RS
  // yang dipakai utk sistolik -- band di bawah DIKONSTRUKSI (bukan dikutip
  // langsung dari satu tabel) dgn menerapkan proporsi/filosofi yang SAMA
  // dgn band TD_sistolik dewasa yang sudah ada (normal lebar mencakup
  // elevated+stage1, borderline = stage 2 s/d sebelum krisis, gawat = ambang
  // krisis persis) terhadap angka diastolik nyata yang independen (WebSearch,
  // ideal <80, hipotensi bagian dari kombinasi <90/60, krisis hipertensi
  // diastolik >120 -- Cleveland Clinic/AHA/StatPearls, cross-check 14 Sep
  // 2026): normal [60,89] (s/d sebelum stage 2), borderline [90,120] (stage 2
  // s/d sebelum krisis) & [50,59] (buffer sebelum hipotensi), gawatUnder:50,
  // gawatOver:120 (>120 strict -- PERSIS definisi krisis hipertensi, TIDAK
  // butuh penyesuaian -1 spt RR karena rumusnya sendiri sudah ">120" bukan
  // ">=X"). Ini APPROXIMASI advisory, bukan tabel klinis baku yang dikutip --
  // beda sumbernya dari TD_sistolik dewasa (yang berasal dari draft
  // BA/pengguna), flagged eksplisit di sini supaya tidak dikira setara.
  TD_diastolik: {
    unit: 'mmHg',
    dewasa: { normal: [60, 89], borderline: [[90, 120], [50, 59]], gawatUnder: 50, gawatOver: 120 },
    lansia: { normal: [60, 89], borderline: [[90, 120], [50, 59]], gawatUnder: 50, gawatOver: 120 },
    remaja: { normal: [64, 83], gawatUnder: 64 },
    usia_sekolah: { normal: [57, 76], gawatUnder: 57 },
    prasekolah: { normal: [46, 72], gawatUnder: 46 },
    toddler: { normal: [42, 63], gawatUnder: 42 },
    bayi: { normal: [37, 56], gawatUnder: 37 },
    neonatus: { normal: [35, 53], gawatUnder: 35 },
  },
  Suhu: {
    unit: '°C',
    _all: { normal: [36.1, 37.5], borderline: [[37.6, 38.4], [35, 36]], gawatUnder: 35, gawatOver: 39 },
  },
  GCS: {
    unit: 'poin',
    // Sama untuk semua usia -- yang beda untuk <2 tahun adalah CARA SKORING
    // komponen verbal (Pediatric GCS), bukan ambang angkanya. Dicatat di UI,
    // bukan tabel band terpisah.
    _all: { normal: [15, 15], borderline: [13, 14], gawatUnder: 13 },
  },
  Nyeri: {
    unit: 'skala 0-10',
    // Sama untuk semua usia dari segi ambang severity -- yang beda per usia
    // adalah INSTRUMEN pengukurannya (lihat resolvePainInstrument), bukan
    // pemetaan skor ke normal/borderline/gawat.
    _all: { normal: [0, 0], borderline: [1, 6], gawatOver: 6 },
  },
};

// Instrumen skala nyeri standar 4-tier (keputusan 11 Sep 2026, wiring
// PAIN_SCALE_INSTRUMENTS lama yang cuma reference data mati -- tidak pernah
// dipakai extraction prompt): NIPS neonatus, FLACC <3th/pra-verbal, Wong-Baker
// 3-7th, NRS/VAS >=8th. Tidak ditemukan standar khusus Indonesia/BPJS,
// dipakai standar internasional yang sama dipakai literatur PALS.
function resolvePainInstrument(umurTahun, umurHari, ageGroup) {
  if (!ageGroup) return null;
  if (ageGroup === 'neonatus') return 'NIPS (Neonatal Infant Pain Scale)';
  if (ageGroup === 'bayi' || ageGroup === 'toddler') return 'FLACC (Face, Legs, Activity, Cry, Consolability)';
  const hasTahun = umurTahun !== null && umurTahun !== undefined && umurTahun !== '' && Number.isFinite(Number(umurTahun));
  const tahun = hasTahun ? Number(umurTahun) : null;
  if (tahun !== null) {
    if (tahun < 3) return 'FLACC (Face, Legs, Activity, Cry, Consolability)';
    if (tahun <= 7) return 'Wong-Baker FACES Pain Rating Scale';
    return 'NRS (Numeric Rating Scale) / VAS (Visual Analogue Scale) 0-10';
  }
  // Fallback pakai ageGroup kasar kalau umur tahun eksak tidak ada (mis.
  // cuma UMUR_HARI yang tercatat) -- prasekolah (3-5th) jelas Wong-Baker,
  // sisanya (usia_sekolah/remaja/dewasa/lansia) default ke NRS/VAS.
  if (ageGroup === 'prasekolah') return 'Wong-Baker FACES Pain Rating Scale';
  return 'NRS (Numeric Rating Scale) / VAS (Visual Analogue Scale) 0-10';
}

/**
 * Cari band (normal/borderline/gawat) untuk satu nilai parameter numerik.
 * @returns {'normal'|'borderline'|'gawat'|null} null kalau ageGroup tidak
 *   dikenal untuk parameter ini atau nilai tidak diberikan.
 */
function lookupBand(parameterKey, value, ageGroup) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const table = THRESHOLD_TABLE[parameterKey];
  if (!table) return null;
  const band = table._all || table[ageGroup];
  if (!band) return null;
  const v = Number(value);

  const inRange = (range) => v >= range[0] && v <= range[1];
  if (band.normal && inRange(band.normal)) return 'normal';
  if (band.borderline) {
    const ranges = Array.isArray(band.borderline[0]) ? band.borderline : [band.borderline];
    if (ranges.some(inRange)) return 'borderline';
  }
  if (typeof band.gawatUnder === 'number' && v < band.gawatUnder) return 'gawat';
  if (typeof band.gawatOver === 'number' && v > band.gawatOver) return 'gawat';
  // Nilai di antara normal dan ambang gawat tapi tidak match borderline eksplisit
  // (kasus tabel anak yang cuma punya normal+gawat, tanpa borderline tersendiri).
  if (!band.borderline) return 'borderline';
  return 'borderline';
}

// ===== TABEL 3 input: whitelist kode tindakan untuk K5 =====
// Kode ICD-9-CM diverifikasi terhadap referensi resmi (bukan hasil tebakan),
// lihat diskusi 10-11 Sep 2026. "Injeksi obat emergency" SENGAJA TIDAK
// termasuk -- kode injeksi obat (mis. 99.29) generik untuk obat emergency
// MAUPUN obat rutin, tidak bisa dibedakan dari kode saja tanpa text-matching
// nama obat (opsi itu ditolak, K5 tetap deterministik murni dari PROCLIST).
const K5_WHITELIST_CODES = {
  '99.60': 'RJP (Cardiopulmonary resuscitation, NOS)',
  '99.63': 'RJP (Closed chest cardiac massage)',
  '99.62': 'DC shock (Other electric countershock of heart)',
  '96.04': 'Intubasi (Insertion of endotracheal tube)',
  '38.93': 'Pemasangan infus (Venous catheterization, NEC)',
  '93.96': 'Oksigenasi (Other oxygen enrichment)',
  '93.90': 'Oksigenasi/ventilasi non-invasif (CPAP/NIV)',
};

module.exports = {
  PARAMETER_TABLE,
  AGE_GROUP_LABELS,
  THRESHOLD_TABLE,
  K5_WHITELIST_CODES,
  resolveAgeGroup,
  lookupBand,
  resolvePainInstrument,
};
