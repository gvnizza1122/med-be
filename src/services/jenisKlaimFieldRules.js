/**
 * Referensi TERPUSAT: field vClaim mana yang perilakunya beda tergantung
 * kategori pelayanan (jenis_klaim), dan bagaimana harusnya ditangani.
 *
 * KENAPA FILE INI ADA — Sebelum ini, logika "field X beda untuk kategori Y"
 * tersebar ad-hoc di 3 tempat (pdfExtractionService.js, ruleEngine.js,
 * aiReviewService.js), ditambah satu per satu tiap kali ada bug ditemukan
 * (kasus nyata: ADMISSION_DATE/DISCHARGE_DATE kosong terus untuk RAWAT_JALAN
 * karena cuma KELAS_RAWAT yang dikasih rule khusus, tanggal terlewat).
 * Supaya tidak kejadian lagi field lain yang lolos tanpa disadari, semua
 * field yang PERLU perlakuan khusus per kategori didaftar di sini dulu —
 * baru diimplementasikan di service masing-masing. Kalau ada bug serupa
 * ditemukan lagi, tambahkan entrinya di sini SEBELUM menambal kodenya,
 * supaya daftar ini tetap jadi checklist yang bisa diaudit, bukan cuma
 * tambalan tersebar.
 *
 * jenis_klaim yang valid: 'RAWAT_JALAN' | 'RAWAT_INAP' | 'GAWAT_DARURAT'
 * (lihat JENIS_KLAIM_OPTIONS di frontend, results/[fileId]/page.tsx)
 *
 * VERIFIKASI DATA REAL (2026-08-20): 150 sampel PDF produksi asli RS Lestari
 * Raharja, periode Juni-Juli 2026 (folder data-claim-bulan-juni-dan-juli/).
 * Semua status di bawah yang tertulis "diverifikasi data real" dicek
 * langsung terhadap sampel ini, bukan asumsi/tebakan.
 */

const FIELD_BEHAVIOR_BY_JENIS_KLAIM = [
  {
    field: 'KELAS_RAWAT',
    note: 'RAWAT_JALAN & GAWAT_DARURAT-tanpa-rawat-inap: dokumen TIDAK punya "Kelas Rawat" (pasien tidak menginap) — ambil dari "Kelas Hak" (kelas kepesertaan BPJS) sebagai gantinya. RAWAT_INAP: ambil dari "Kelas Rawat" asli, JANGAN dari "Kelas Hak".',
    handledIn: ['pdfExtractionService.js (kelasRawatRule)'],
    status: 'implemented',
  },
  {
    field: 'ADMISSION_DATE / DISCHARGE_DATE',
    note: 'RAWAT_JALAN & GAWAT_DARURAT-tanpa-rawat-inap: dokumen TIDAK punya "Tanggal Masuk"/"Tanggal Keluar" terpisah (satu hari kunjungan) — pakai "Tanggal Pelayanan"/"Tanggal Kunjungan"/"Tgl Periksa" untuk KEDUANYA. RAWAT_INAP: pakai tanggal masuk & keluar asli, bisa beda hari.',
    handledIn: ['pdfExtractionService.js (tanggalRawatJalanRule, sekarang mencakup RAWAT_JALAN + GAWAT_DARURAT)'],
    status: 'implemented',
    verifiedAgainstRealData: '2026-08-20 — dicek 2 sampel PDF IGD asli (Resume Medis IGD), keduanya cuma punya field "Tgl Periksa" tunggal, sama persis pola RAWAT_JALAN. Rule diperluas mencakup GAWAT_DARURAT.',
  },
  {
    field: 'ICU_INDIKATOR / ICU_LOS / VENT_HOUR',
    note: 'Cuma relevan untuk RAWAT_INAP. Untuk RAWAT_JALAN/GAWAT_DARURAT-tanpa-inap, field ini wajib "0"/kosong, dan field_notes AI dilarang menyinggung ICU/ventilator sama sekali.',
    handledIn: ['aiReviewService.js (hasInpatientOnlyTerms filter, system prompt larangan eksplisit)'],
    status: 'implemented',
    caveat: 'Filter ini ada di sisi AI review (buang saran yang menyinggung rawat inap), TAPI belum ada rule serupa di pdfExtractionService.js untuk memastikan ekstraksi awal juga tidak salah isi nilai — kalau AI ekstraksi tetap ngarang ICU_LOS untuk RAWAT_JALAN, belum ada penjaga di titik ekstraksi. Belum jadi prioritas karena belum ada bukti nyata ini kejadian.',
  },
  {
    field: 'LOS (Length of Stay)',
    note: 'RAWAT_JALAN/GAWAT_DARURAT-tanpa-inap: dokumen TIDAK PERNAH mencantumkan label "LOS"/"Lama Rawat" sama sekali — field kosong di kasus ini SUDAH BENAR (sesuai aturan 6 "jangan menebak"), bukan bug. RAWAT_INAP: belum ada sampel PDF asli untuk diverifikasi.',
    handledIn: [],
    status: 'checked-no-issue-for-outpatient',
    verifiedAgainstRealData: '2026-08-20 — dicek 2 sampel PDF RJ/IGD asli, tidak ada satupun mention "LOS"/"Lama Rawat"/"Lama Dirawat". Tidak ada rule validasi format LOS di ruleEngine.js juga, jadi tidak berdampak ke error/pending saat ini.',
    caveat: 'RAWAT_INAP belum bisa diverifikasi — dataset yang dicek (data-claim-bulan-juni-dan-juli/) sepertinya didominasi RAWAT_JALAN/GAWAT_DARURAT (0/150 sampel mengandung penanda "resume medis rawat inap"). Perlu sampel PDF rawat inap asli kalau mau dicek.',
  },
  {
    field: 'Kriteria kegawatan (S/O di resume medis)',
    note: 'GAWAT_DARURAT: keluhan (S) yang cuma "nyeri"/keluhan ringan tanpa tanda objektif (O) pendukung, dikombinasikan dengan TTV normal semua, sering ditolak BPJS ("false emergency"/"unklaim"/"tidak memenuhi kriteria gawat darurat") — pola pending #3 terbesar (8.8% RJ, ~9-30% RI tergantung kategorisasi). Bukan validasi format field, tapi pola risiko semantik dari isi dokumen.',
    handledIn: ['aiReviewService.js (pola pending_risk_notes: kegawatan_lemah)'],
    status: 'implemented',
  },
  {
    field: 'POTENSI_PRB_SEP (BARU) / JENIS_KUNJUNGAN_SEP (BARU)',
    note: 'Field custom non-vClaim, digali dari halaman SEP: sistem BPJS sendiri mencetak flag "Potensi PRB" di dekat No. SEP untuk pasien yang berpotensi program rujuk balik, dan field "Jns Kunj" berisi teks seperti "Konsultasi dokter (pertama)"/"Tujuan Kontrol". Dipetakan ke kolom DB flag_rujuk_balik_prb (sudah ada di skema sejak awal, sebelumnya tidak pernah terisi) + disimpan di raw_data, ditampilkan sebagai badge di panel detail record.',
    handledIn: ['pdfExtractionService.js (aturan 10a/10b)', 'claimFiles.js (vclaimToDbFormat: POTENSI_PRB_SEP -> flag_rujuk_balik_prb)', 'results/[fileId]/page.tsx (badge "Potensi PRB (BPJS)" + info Jenis Kunjungan)'],
    status: 'implemented',
    verifiedAgainstRealData: '2026-08-20 — dicek 60 sampel SEP asli: field "Jns Kunj" konsisten berisi "Konsultasi dokter (pertama)" atau "Tujuan Kontrol"; flag "Potensi PRB" muncul di sekitar 50% sampel.',
    caveat: 'BELUM cukup untuk membuat RV-15 (PRB) benar-benar menyala otomatis — rule itu masih butuh histori_obat_kronis_bulan_berturut & status_pasien yang tidak tersedia dari 1 SEP saja. Fungsinya sekarang: SURFACE flag BPJS ke verifikator sebagai informasi tambahan (banding manual lebih cepat), bukan otomatisasi penuh RV-15.',
  },
  {
    field: 'DISCHARGE_STATUS',
    note: 'Sama untuk semua kategori — TAPI dokumen sering cuma tulis narasi ("Rencana rawat jalan") bukan kode 1-5 eksplisit. AI ekstraksi sengaja TIDAK menebak kode dari narasi (lihat aturan 6 "jangan menebak" di pdfExtractionService.js) — field kosong di kasus ini valid & disengaja, bukan bug.',
    handledIn: ['ruleEngine.js (RV-08, sekadar validasi format 1-5)'],
    status: 'by-design-not-a-bug',
  },
  {
    field: 'DIAGLIST tanpa kode ICD-10 (cuma teks diagnosis)',
    note: 'Semua kategori — dokumen kadang cuma punya teks bebas ("Diag Awal: Asthma") tanpa kode ICD-10 resmi. AI sengaja tidak mengarang kode (anti-upcoding); malah mengusulkan via suggested_codes dengan bukti kutipan, koder yang putuskan final.',
    handledIn: ['aiReviewService.js (suggested_codes, aturan 3)'],
    status: 'by-design-not-a-bug',
    verifiedAgainstRealData: '2026-08-20 — ternyata sebagian dokumen (Resume Medis) MEMANG mencantumkan kode ICD eksplisit di bagian Assessment (contoh: "G44 - Other headache syndromes", "39.95 - Hemodialysis"). Prompt ekstraksi diupdate supaya AI tahu harus cari & salin kode itu kalau ADA, bukan cuma langsung anggap tidak ada kode sama sekali.',
  },
  {
    field: 'Asumsi jenis dokumen sumber ("Berkas Klaim Individual")',
    note: 'Prompt ekstraksi sebelumnya bilang ke AI dokumennya "Berkas Klaim Individual" (ringkasan E-Klaim terkode rapi) — ternyata itu TIDAK PERNAH ada di dokumen real RS ini (0/150 sampel). Dokumen sungguhan: "Resume Medis RJ/IGD" (S/O/A/P bebas) + SEP + kadang Resep. Prompt yang salah asumsi ini kemungkinan berkontribusi ke gap ekstraksi lain (AI dikasih ekspektasi "data sudah rapi tinggal salin" padahal yang dibaca catatan dokter bebas).',
    handledIn: ['pdfExtractionService.js (paragraf pembuka prompt, diupdate untuk mendeskripsikan Resume Medis/SEP/Resep)'],
    status: 'implemented',
    verifiedAgainstRealData: '2026-08-20 — 150 sampel PDF, 0% mengandung "Berkas Klaim Individual", 90% mengandung "Resume Medis RJ".',
  },
  {
    field: 'is_primary_source / evidence pool exclusion (audit sirkular)',
    note: 'pdfPageClassifier.js punya logika exclude halaman "sumber asli ekstraksi kode" dari evidence pool AI audit (cegah "kode terbukti cuma karena tertulis di halaman asalnya sendiri"). PRIMARY_KEYWORD-nya ("Berkas Klaim Individual") tidak pernah cocok untuk data real -> exclude ini praktiknya TIDAK PERNAH aktif.',
    handledIn: [],
    status: 'known-issue-not-fixed',
    caveat: 'SENGAJA belum ditambal langsung. Sempat dicoba tambah "Resume Medis RJ/IGD" ke keyword exclude, tapi untuk klaim RJ biasa itu SATU-SATUNYA halaman berisi konten klinis — exclude penuh bikin evidence pool kosong total (lebih buruk dari sirkularitas awal). Perbaikan yang benar butuh exclude PER-KUTIPAN (bukan per-halaman): cegah AI "membuktikan" kode pakai kutipan yang persis sama dengan lokasi tempat kode itu sendiri pertama diketik, tapi tetap izinkan kutipan lain dari halaman yang sama. Ini perubahan lebih besar, belum dikerjakan.',
  },
  {
    field: 'RV-13 (episode konsul internal) — SEKARANG BISA MENYALA',
    note: 'Butuh tahu apakah 1 pasien punya BEBERAPA klaim/kunjungan terpisah pada hari yang sama (lintas poli) yang seharusnya digabung jadi 1 episode. TIDAK BISA diketahui dari 1 dokumen saja, TAPI bisa disimpulkan dengan cross-check ke record lain yang SUDAH ADA di database RS yang sama (NOKARTU + tanggal sama = kandidat episode gabungan; klinik_poli beda antar record = konsul internal lintas-poli, bukan cuma duplikat).',
    handledIn: [
      'jenisKlaimFieldRules.js/init.js (kolom baru klinik_poli)',
      'pdfExtractionService.js (aturan 10c, field KLINIK_SEP)',
      'claimFiles.js (detectAndFlagInternalEpisodes() — dipanggil tiap upload PDF berhasil, mengisi jenis_konsultasi/jumlah_episode_klaim/is_same_day di SEMUA record terkait termasuk yang sudah lama tersimpan, lalu validasi ulang)',
      'results/[fileId]/page.tsx (hasEpisodeTrackingData sekarang juga cek kolom DB langsung, bukan cuma raw_data)',
    ],
    status: 'implemented',
    caveat: 'BELUM DIUJI ke database sungguhan (Postgres via Docker tidak jalan di mesin dev saat ini) — cuma lolos node --check (sintaks) dan tinjauan logika manual. Cakupan: cuma mendeteksi pasangan record NOKARTU+tanggal sama yang SUDAH SAMA-SAMA ter-upload ke sistem ini (lintas file/batch, karena query ke DB bukan cuma ke batch yang sama) — kalau salah satu kunjungannya belum pernah diupload sama sekali, tidak akan terdeteksi.',
  },
  {
    field: 'RV-14 (episode rujukan internal) — DICOBA, TIDAK BISA (bukan cuma belum sempat)',
    note: 'Beda dari RV-13: butuh tahu apakah kunjungan kedua itu RUJUKAN dari kunjungan pertama (bukan cuma konsul biasa) — relasi "A merujuk ke B" tidak bisa disimpulkan dari klinik_poli/tanggal saja, perlu field yang eksplisit menyebut arah rujukan INTERNAL (antar poli, RS yang sama).',
    handledIn: ['ruleEngine.js (RV-14, tetap di-skip aman — jenis_konsultasi tidak pernah diisi RUJUKAN_INTERNAL)'],
    status: 'known-gap-verified-no-data-source',
    verifiedAgainstRealData: '2026-08-20 — dicek field "Poli Perujuk" di 99 sampel SEP asli (setelah perbaiki bug regex sendiri yang sempat salah baca baris): 0/99 terisi, SELALU KOSONG. Field "Faskes Perujuk" (99/99 terisi) BUKAN pengganti yang valid — itu kode FASKES LUAR (mis. "11170801-Muntilan I" = Puskesmas perujuk dari luar RS), bukan poli internal RS ini, jadi tidak bisa dipakai untuk mendeteksi rujukan ANTAR-POLI INTERNAL.',
    caveat: 'TIDAK diimplementasikan dengan sengaja — memaksa pakai sinyal yang tidak ada (mis. menebak arah dari urutan waktu kunjungan) melanggar prinsip "jangan menebak" yang dipakai di seluruh aplikasi ini, dan berisiko salah-flag klaim yang sebenarnya benar. Kalau mau RV-14 benar-benar jalan, butuh data eksternal (SIMRS mencatat rujukan internal secara eksplisit) — bukan sesuatu yang bisa digali dari dokumen PDF/SEP yang ada sekarang.',
  },
  {
    field: 'RV-15 (PRB) / RV-16 (iterasi obat kronis) — bagian yang masih kurang',
    note: 'POTENSI_PRB_SEP (di atas) kasih SEBAGIAN sinyal (flag BPJS), tapi rule RV-15 penuh & RV-16 masih butuh histori_obat_kronis_bulan_berturut (berapa bulan berturut-turut pasien ini kontrol untuk diagnosis kronis yang sama) dan urutan_iterasi (kunjungan iterasi ke berapa) — keduanya butuh riwayat MULTI-KUNJUNGAN lintas waktu, bukan cuma 1 dokumen.',
    handledIn: ['ruleEngine.js (RV-15/16, di-skip aman kalau field kosong)'],
    status: 'known-gap-needs-new-data-source',
    caveat: 'Ini penyebab pending TERBESAR (~46% dari data pending RJ Juni 2026 gabungan RV-13/15/16). Solusi jangka panjang: SIMRS punya database kunjungan pasien per hari — bisa di-query riwayatnya. Jalur ingest dari SIMRS (bukan PDF) sudah ada (SimrsIngestionModal.tsx, api.ingestSimrsJson), tapi belum mengisi field episode ini. Di luar cakupan sesi ini (butuh lihat skema data SIMRS asli dulu).',
  },
];

module.exports = { FIELD_BEHAVIOR_BY_JENIS_KLAIM };
