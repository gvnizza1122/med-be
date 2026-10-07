/**
 * Pipeline ekstraksi PDF klaim → 1 record vClaim (60 kolom).
 *
 * Alur: klasifikasi halaman (pdf-parse) → ambil teks halaman claim-data →
 *       [ENHANCEMENT] multi-pass OCR (vital signs, clinical findings) →
 *       ekstraksi AI → record vClaim sesuai skema resmi.
 *
 * Env: AI_PROVIDER_API_KEY (wajib), AI_PROVIDER_BASE_URL, AI_MODEL, AI_MAX_ATTEMPTS, AI_TIMEOUT_MS.
 * Env: OCR_ENHANCEMENT_ENABLED (default true) — enable multi-pass OCR enhancement
 * Env: OCR_ENHANCEMENT_TIMEOUT (default 180000/3 menit) — batas keras budget
 *   OCR enhancement (Phase 1, 19 Sep 2026, client approved, turun dari
 *   sebelumnya). Lihat applyOcrEnhancements() di ocrIntegration.js untuk
 *   Promise.race pembungkusnya.
 *
 * STRATEGI PRIORITAS HALAMAN CRITICAL (OCR Phase 1): dalam budget 3 menit,
 * dokumen scan tebal (SPRI+SEP+Rincian Biaya+Resume Medis+Triage dst) bisa
 * kehabisan waktu sebelum sampai ke halaman yang paling berharga secara
 * klinis. Halaman TRIAGE IGD & RESUME MEDIS ditandai "CRITICAL" (lihat
 * isCriticalPage() di pdfPageClassifier.js) karena keduanya SATU-SATUNYA
 * sumber vital signs/diagnosis/prosedur (lihat extractClinicalFields() di
 * ocrEnhancement.js) — tanpa keduanya field klinis inti klaim gawat darurat
 * kosong total. ocrService.js#ocrPdfPages() mengurutkan antrean OCR supaya
 * halaman CRITICAL diproses LEBIH DULU, lalu men-skip halaman non-critical
 * begitu sisa waktu sudah mepet (lihat CRITICAL_PAGE_TIMEOUT_MARGIN_MS &
 * prioritizePagesForOcr()) — jadi kalaupun timeout keras tercapai, hasil
 * OCR halaman critical yang SUDAH selesai tetap terpakai (bukan dibuang
 * semua oleh Promise.race di ocrIntegration.js). Halaman yang ke-skip
 * dicatat di result.skipped_pages — daftar ini disiapkan sebagai input buat
 * Phase 2 (Luna fallback untuk field yang hilang), BELUM diimplementasi di
 * sini.
 */

const { isLembarGrouper, cariLembarGrouper } = require('./lembarGrouperService');
const { classifyPdfPages, detectJenisKlaim, hasBpjsPageSignal, hasLaporanOperasiSignal, hasHasilPaSignal, hasLaporanOperasiVitalSigns, hasLabResultsData, hasRadiologyData } = require('./pdfPageClassifier');
const { extractClaimData } = require('./pdfExtractionService');
const { parsePhysicalExam, translateClinicalText } = require('./notasiMedisParser');
const { applyOcrEnhancements, mergeEnhancementsIntoRecord } = require('./ocrIntegration');

/** OCR juga diperlukan pada halaman bertipe NATIVE dengan lapisan teks tidak lengkap. */
function teksFallbackDokumen(classification) {
  const pages = classification.pages || [];
  const nomorGrouper = new Set([
    ...pages.filter(p => p.is_lembar_grouper).map(p => Number(p.page_num)),
    ...(classification.grouperPages || []).map(p => Number(p.page_num || p.page_number)),
  ]);
  const native = pages.filter(p => !nomorGrouper.has(Number(p.page_num)) && !isLembarGrouper(p.text_full || ''))
    .map(p => p.text_full || '');
  const ocr = (classification.ocr_enhancement?.pass1_general_ocr?.pages || [])
    .filter(p => !nomorGrouper.has(Number(p.page_number)) && p.text && !isLembarGrouper(p.text))
    .map(p => p.text);
  return [...native, ...ocr].join('\n\n');
}

/**
 * Jaring pengaman deterministik (regex, BUKAN AI) untuk SEP/NOKARTU/KELAS_RAWAT
 * — dijalankan SETELAH ekstraksi AI, cuma mengisi field yang AI kembalikan
 * kosong (tidak pernah menimpa nilai yang sudah terisi AI). Berjalan di
 * SELURUH teks halaman (bukan cuma yang lolos klasifikasi claim-data), jadi
 * tetap bekerja walau kata kunci klasifikasi halaman meleset atau AI lalai
 * mengikuti instruksi prompt — dua kegagalan yang pernah terjadi sebelumnya.
 */
function applyDeterministicFallback(record, allPagesText, jenisKlaim, originalName) {
  if (!record.SEP) {
    // Nama file di dataset RS ini SECARA HARFIAH adalah nomor SEP-nya sendiri
    // (contoh: "0170R0110626V000012.pdf") — bukan tebakan, itu identifier asli
    // yang dipakai SIMRS untuk menamai hasil export. Dicoba duluan karena lebih
    // pasti (tidak tergantung kualitas OCR/scan) daripada regex ke teks dokumen.
    const SEP_PATTERN = /(0\d{3}[A-Z]\d{3}\d{4}[A-Z]\d{6})/i;
    const fromFilename = originalName ? SEP_PATTERN.exec(originalName) : null;
    if (fromFilename) {
      record.SEP = fromFilename[1].toUpperCase();
      record._sep_source = 'filename';
      console.log('[Pipeline] Fallback mengisi SEP dari nama file (AI mengembalikan kosong).');
    } else {
      const m = /no\.?\s*sep\s*:?\s*([0-9A-Za-z]{10,30})\b/i.exec(allPagesText);
      if (m) {
        record.SEP = m[1].toUpperCase();
        record._sep_source = 'pdf_scan';
        console.log('[Pipeline] Fallback regex mengisi SEP dari teks dokumen (AI mengembalikan kosong).');
      }
    }
  }
  if (!record.NOKARTU) {
    const m = /no\.?\s*kartu\s*:?\s*\(?\s*(\d{13})\b/i.exec(allPagesText);
    if (m) {
      record.NOKARTU = m[1];
      console.log('[Pipeline] Fallback regex mengisi NOKARTU (AI mengembalikan kosong).');
    }
  }
  const isOutpatientLike = jenisKlaim === 'RAWAT_JALAN';
  const kelasSep = require('./kelasPerawatanService').bacaKelasSep(allPagesText);
  if (kelasSep.kelas_hak) record.KELAS_HAK = kelasSep.kelas_hak;
  if (kelasSep.kelas_ditempati) record.KELAS_DITEMPATI = kelasSep.kelas_ditempati;
  // Syaratnya BUKAN 'masih kosong' melainkan 'belum berisi 1/2/3'. Aturan 8 di
  // pdfExtractionService.js sendiri memberitahu AI bahwa field 'Kelas Rawat'
  // pada berkas rawat jalan/IGD wajar berisi "-", dan AI memang kadang
  // menyalin "-" itu apa adanya alih-alih mengambil dari 'Kls Hak'. Karena
  // "-" itu truthy, syarat lama (!record.KELAS_RAWAT) membuat jaring pengaman
  // ini justru DILEWATI persis pada kasus yang paling membutuhkannya: nilai
  // sampah lolos ke hilir, Number("-") jadi NaN di getTarifResmi(), dan tarif
  // resmi hilang tanpa sebab yang jelas walau kodenya ketemu di PMK 3/2023.
  const kelasRawatSudahValid = /^[123]$/.test(String(record.KELAS_RAWAT || '').trim());
  if (!kelasRawatSudahValid && isOutpatientLike) {
    // Label field bervariasi "Kelas Hak"/"Kls Hak", nilainya bisa "Kelas 2" atau
    // langsung "2" — regex ini tangani kombinasi label singkat/panjang x nilai
    // dengan/tanpa kata "Kelas" di depan angka.
    const m = /(?:kelas|kls\.?)\s*hak\s*:?\s*(?:kelas\s*)?(\d)\b/i.exec(allPagesText);
    if (m) {
      record.KELAS_RAWAT = m[1];
      console.log('[Pipeline] Fallback regex mengisi KELAS_RAWAT dari Kelas Hak (rawat jalan/IGD).');
    } else if (record.KELAS_RAWAT) {
      console.log('[Pipeline] KELAS_RAWAT ' + JSON.stringify(record.KELAS_RAWAT) + ' bukan 1/2/3 dan Kls Hak tidak terbaca -- dikosongkan supaya tidak menutupi nilai tervalidasi di hilir.');
      record.KELAS_RAWAT = '';
    }
  }
  if (!kelasRawatSudahValid && !isOutpatientLike) {
    // KELAS_RAWAT menyimpan kelas kamar. KELAS_HAK dipakai terpisah untuk tarif.
    const m = /(?:kelas|kls\.?)\s*rawat\s*:?\s*(?:kelas\s*)?([123])\b/i.exec(allPagesText)
      || /(?:kelas|kls\.?)\s*hak\s*:?\s*(?:kelas\s*)?([123])\b/i.exec(allPagesText);
    if (m) {
      record.KELAS_RAWAT = m[1];
      console.log('[Pipeline] Fallback regex mengisi KELAS_RAWAT rawat inap dari SEP.');
    } else if (record.KELAS_RAWAT) {
      record.KELAS_RAWAT = '';
    }
  }
  if (isOutpatientLike && (!record.ADMISSION_DATE || !record.DISCHARGE_DATE)) {
    // Rawat jalan/IGD-tanpa-inap cuma 1 hari kunjungan — dokumen (SEP/resume medis poliklinik)
    // hampir tidak pernah punya field "Tanggal Masuk"/"Tanggal Keluar" eksplisit,
    // yang ada cuma "Tgl Periksa" atau "Tgl. SEP". AI ekstraksi sengaja menolak
    // menyalin dari field lain (aturan umum di pdfExtractionService.js), jadi
    // dua field ini butuh fallback deterministik sendiri, sama pola dengan
    // KELAS_RAWAT di atas: tanggal masuk = tanggal keluar = tanggal pelayanan.
    const m = /tgl\.?\s*periksa\s*:?\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i.exec(allPagesText)
      || /tgl\.?\s*sep\s*:?\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i.exec(allPagesText);
    if (m) {
      const tglPelayanan = `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
      if (!record.ADMISSION_DATE) {
        record.ADMISSION_DATE = tglPelayanan;
        console.log('[Pipeline] Fallback regex mengisi ADMISSION_DATE dari tanggal pelayanan (rawat jalan, AI mengembalikan kosong).');
      }
      if (!record.DISCHARGE_DATE) {
        record.DISCHARGE_DATE = tglPelayanan;
        console.log('[Pipeline] Fallback regex mengisi DISCHARGE_DATE dari tanggal pelayanan (rawat jalan, AI mengembalikan kosong).');
      }
    }
  }

  if (!isOutpatientLike) {
    // Rawat inap -- tanggal dari dokumen RS sendiri (lembar grouper "Berkas
    // Klaim Individual" hanya pembanding, tidak dibaca):
    //   MASUK : SPRI "Tanggal MRS : 31 Dec 2025"; cadangan awal rentang
    //           "Tgl Rawat" rincian biaya, lalu Tgl.SEP.
    //   KELUAR: akhir rentang "Tgl Rawat" rincian biaya; cadangan tanggal
    //           tanda tangan DPJP di resume ("Magelang, 3 Januari 2026 /
    //           Dokter Penanggung Jawab Pelayanan").
    // Contoh acuan dari RS: SUPRIYATI 0170R0111225V003428 (31/12/2025 -
    // 03/01/2026). Tanggal dari dokumen ini mengalahkan isian AI karena
    // kutipannya pasti; tanggal keluar tidak pernah ditebak dari sumber lain.
    const ambil = (re) => tanggalDariCocokan(re.exec(allPagesText), 1);
    const rentang = new RegExp(`tgl\\.?\\s*rawat\\s*:?\\s*${POLA_TANGGAL}\\s*(?:-|s\\.?\\s*d\\.?|sampai)\\s*${POLA_TANGGAL}`, 'i').exec(allPagesText);
    const masuk = ambil(new RegExp(`tanggal\\s*mrs\\s*:?\\s*${POLA_TANGGAL}`, 'i'))
      || (rentang ? tanggalDariCocokan(rentang, 1) : null)
      || ambil(new RegExp(`tgl\\.?\\s*sep\\s*:?\\s*${POLA_TANGGAL}`, 'i'));
    // "<Kota>, 3 Januari 2026" tepat sebelum "Dokter Penanggung Jawab (Pelayanan)".
    const ttdResume = new RegExp(`[A-Za-z]+\\s*,\\s*${POLA_TANGGAL}[\\s\\S]{0,40}?dokter\\s+penanggung\\s+jawab`, 'gi');
    // Akhir "Tgl Rawat" rincian biaya lebih dulu: resume bisa ditandatangani
    // sehari SESUDAH pulang (SLAMET FAHRODIN 0170R0111225V003444: resume
    // "5 Januari 2026", casemix & rincian biaya 04/01/2026). Tanda tangan DPJP
    // hanya cadangan bila rincian biaya tidak ada.
    let keluar = rentang ? tanggalDariCocokan(rentang, 5) : null;
    if (!keluar) for (const m of allPagesText.matchAll(ttdResume)) keluar = tanggalDariCocokan(m, 1) || keluar; // tanda tangan terakhir
    const pasang = (field, nilai, sumber) => {
      if (!nilai || record[field] === nilai) return;
      console.log(`[Pipeline] ${field} rawat inap = ${nilai} dari ${sumber}${record[field] ? ` (menggantikan ${record[field]})` : ''}.`);
      record[field] = nilai;
    };
    pasang('ADMISSION_DATE', masuk, 'SPRI/rincian biaya/SEP');
    const a = parseDDMMYYYY(record.ADMISSION_DATE), b = parseDDMMYYYY(keluar);
    if (keluar && (!a || !b || b >= a)) pasang('DISCHARGE_DATE', keluar, 'tanda tangan DPJP resume/rincian biaya');
  }

  // DPJP tidak terbaca AI (SLAMET FAHRODIN, MUHAMMAD ARSYA): dari SPRI
  // "DPJP : dr. ...", nama di bawah tanda tangan "Dokter Penanggung Jawab
  // Pelayanan" pada resume, atau kolom "Dokter :" di SEP.
  if (!record.DPJP || !String(record.DPJP).trim()) {
    const bersih = (v) => String(v || '').replace(/\s{2,}.*$/, '').replace(/\s+(?:kls|kelas|poli|faskes)\b.*$/i, '').replace(/[,;]\s*$/, '').trim();
    const m = /^[ \t]*(?:nama[ \t]+)?DPJP[ \t]*:[ \t]*([^\n]{3,80})/im.exec(allPagesText)
      || /dokter\s+penanggung\s+jawab(?:\s+pelayanan)?\s*,?\s*\n+\s*((?:dr|drg)\.?\s[^\n]{2,80})/i.exec(allPagesText)
      || /^[ \t]*(?:nama[ \t]+)?dokter[ \t]*:[ \t]*([^\n]{3,80})/im.exec(allPagesText);
    const nama = m ? bersih(m[1]) : '';
    if (nama && !/^[-.:\s]*$/.test(nama)) {
      record.DPJP = nama;
      console.log(`[Pipeline] Fallback mengisi DPJP = ${nama}.`);
    }
  }

  // LOS adalah field turunan (fieldTypeRegistry) tetapi tidak pernah dihitung,
  // sehingga selalu 0. Rumus E-Klaim inklusif: keluar - masuk + 1 (lembar
  // grouper SUPRIYATI 31/12/2025-03/01/2026 = 4 hari; ISTIYAH 02-04/01 = 3;
  // TRIMOKO 02-03/01 = 2). Field turunan: bila kedua tanggal ada, LOS selalu
  // dihitung ulang -- AI pernah mengisi selisih eksklusif (SUPRIYATI: 3, bukan
  // 4). Nilai AI hanya dipakai bila tanggal tidak lengkap.
  if (record.ADMISSION_DATE && record.DISCHARGE_DATE) {
    const a = parseDDMMYYYY(record.ADMISSION_DATE), b = parseDDMMYYYY(record.DISCHARGE_DATE);
    if (a && b && b >= a) {
      const los = String(Math.round((b - a) / 86400000) + 1);
      if (String(record.LOS || '').trim() !== los) {
        console.log(`[Pipeline] Menghitung LOS = ${los} hari dari tanggal masuk/keluar${record.LOS ? ` (menggantikan ${record.LOS})` : ''}.`);
      }
      record.LOS = los;
    }
  }

  // DISCHARGE_STATUS wajib kode 1-5 (RV-08), tapi dokumen aslinya cuma menulis kata baku
  // ("Kelanjutan: Pulang") bukan kode. AI diinstruksikan memetakan ini sendiri (aturan 8c
  // di pdfExtractionService.js) — fallback ini jaring pengaman kalau AI tetap menyalin kata
  // mentah. Cuma memetakan kata BAKU yang jelas artinya (bukan menebak dari narasi panjang);
  // kalau tidak cocok satupun, dibiarkan apa adanya supaya RV-08 tetap menandainya untuk
  // dicek manual verifikator (bukan ditebak jadi kode acak).
  if (record.DISCHARGE_STATUS && !/^[1-5]$/.test(String(record.DISCHARGE_STATUS).trim())) {
    const raw = String(record.DISCHARGE_STATUS).trim().toLowerCase();
    // Kode resmi vClaim (RV-08, cuma 1-5): 1=pulang atas persetujuan dokter,
    // 2=dirujuk, 3=APS, 4=meninggal, 5=lainnya. "Lari"/kabur dari RS TIDAK
    // punya kode sendiri di vClaim — masuk kategori 5 (lainnya), BUKAN kode 6
    // yang tidak dikenal RV-08.
    const DISCHARGE_STATUS_MAP = [
      { code: '4', re: /meninggal|mati/ },
      { code: '3', re: /\baps\b|pulang paksa|menolak/ },
      { code: '5', re: /\blari\b|kabur/ },
      { code: '2', re: /rujuk|pindah/ },
      { code: '1', re: /pulang|rawat jalan|kontrol|sembuh|membaik|selesai/ },
    ];
    const match = DISCHARGE_STATUS_MAP.find(({ re }) => re.test(raw));
    if (match) {
      console.log(`[Pipeline] Fallback memetakan DISCHARGE_STATUS "${record.DISCHARGE_STATUS}" -> "${match.code}" (AI menyalin kata mentah, bukan kode).`);
      record.DISCHARGE_STATUS = match.code;
    }
  }

  // UMUR_TAHUN: kalau AI mengembalikan kosong/0 tapi BIRTH_DATE ada, hitung dari BIRTH_DATE
  // vs ADMISSION_DATE (rumus SAMA PERSIS dengan cross-check RV-04 di ruleEngine.js — bukan
  // tebakan, murni aritmatika tanggal). Tidak pernah menimpa nilai AI yang sudah masuk akal.
  if ((!record.UMUR_TAHUN || record.UMUR_TAHUN === '0') && record.BIRTH_DATE) {
    const refDateStr = record.ADMISSION_DATE || record.DISCHARGE_DATE;
    const birth = parseDDMMYYYY(record.BIRTH_DATE);
    const ref = parseDDMMYYYY(refDateStr);
    if (birth && ref) {
      let years = ref.getFullYear() - birth.getFullYear();
      const monthDiff = ref.getMonth() - birth.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && ref.getDate() < birth.getDate())) years--;
      if (years > 0) {
        console.log(`[Pipeline] Fallback menghitung UMUR_TAHUN = ${years} dari BIRTH_DATE (AI mengembalikan kosong/0).`);
        record.UMUR_TAHUN = String(years);
      }
    }
  }

  return record;
}

// Tanggal tercetak: "31 Dec 2025", "3 Januari 2026", "31/12/2025", "2025-12-31".
// Grup: (1 hari)(2 bulan-nama)(3 tahun) | (1 hari)(2 bulan-angka)(3 tahun) diseragamkan
// lewat tanggalDariCocokan; pola dirangkai sehingga tiap tanggal memakai 4 grup.
const BULAN = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
const POLA_TANGGAL = '(?:(\\d{1,2})[\\s\\-\\/]+([A-Za-z]{3,9}|\\d{1,2})[\\s\\-\\/]+(\\d{4})|(\\d{4})-\\d{2}-\\d{2})';
function tanggalDariCocokan(m, i) {
  if (!m) return null;
  if (m[i + 3] && !m[i]) {
    const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(m[0].slice(m[0].indexOf(m[i + 3])));
    return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : null;
  }
  const hari = Number(m[i]);
  const bulan = /^\d+$/.test(m[i + 1]) ? Number(m[i + 1]) : BULAN[String(m[i + 1]).slice(0, 3).toLowerCase()];
  const tahun = Number(m[i + 2]);
  if (!bulan || hari < 1 || hari > 31 || bulan > 12) return null;
  return `${String(hari).padStart(2, '0')}/${String(bulan).padStart(2, '0')}/${tahun}`;
}

/**
 * Cadangan terakhir sebelum menolak berkas: gabungkan teks semua halaman
 * (lapisan teks + hasil OCR) kecuali lembar grouper menjadi claimDataText.
 * @returns {boolean} true bila teks cukup (>= 200 karakter) dan terpasang.
 */
function pakaiSemuaHalaman(classification, result) {
  const ocr = ((classification.ocr_enhancement && classification.ocr_enhancement.pass1_general_ocr
    && classification.ocr_enhancement.pass1_general_ocr.pages) || [])
    .filter(p => p.text && p.text.trim().length > 30 && !isLembarGrouper(p.text));
  const nomorOcr = new Set(ocr.map(p => p.page_number));
  const halaman = [
    ...(classification.pages || [])
      .filter(p => !p.is_lembar_grouper && !nomorOcr.has(p.page_num) && String(p.text_full || '').trim().length > 30)
      .map(p => ({ page_num: p.page_num, text: p.text_full })),
    ...ocr.map(p => ({ page_num: p.page_number, text: p.text })),
  ].sort((a, b) => a.page_num - b.page_num);
  const teks = halaman.map(p => p.text).join('\n\n---\n\n');
  if (teks.trim().length < 200) return false;
  classification.claimDataPages = halaman;
  classification.claimDataText = teks.slice(0, 60000);
  result.metadata.claimDataPagesFound = halaman.length;
  result.metadata.sumberDataSemuaHalaman = true;
  console.log(`[Pipeline] Halaman data klaim tidak dikenali kata kuncinya; ${halaman.length} halaman berteks dipakai sebagai sumber data.`);
  return true;
}

/** Parse tanggal format DD/MM/YYYY (format wajib field tanggal vClaim) ke Date, atau null. */
function parseDDMMYYYY(str) {
  if (!str) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str).trim());
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return isNaN(d) ? null : d;
}

// Pesan untuk pengguna akhir (perawat/verifikator) — tanpa istilah teknis.
const PESAN = {
  tidakTerbaca: 'Dokumen tidak dapat dibaca. Pastikan berkas PDF tidak rusak, lalu unggah ulang.',
  bukanBerkasKlaim: 'Isi dokumen belum berhasil dibaca. Periksa layanan pembacaan PDF/OCR dan kelengkapan berkas.',
  dataKurang: 'Data pada dokumen terlalu sedikit untuk diproses. Periksa kembali kelengkapan berkas.',
  ekstraksiGagal: 'Data belum berhasil dibaca otomatis. Silakan coba lagi beberapa saat, atau isi manual bila tetap gagal.',
  belumDisetel: 'Layanan pembacaan otomatis belum aktif. Hubungi petugas IT rumah sakit.',
};

/**
 * @param {string|Buffer} filePath - path PDF atau Buffer
 * @param {{skipAI?: boolean, jenisKlaim?: string, allowedJenisKlaim?: string[], originalName?: string}} options
 *   - jenisKlaim/allowedJenisKlaim: parameter klien lama diterima untuk kompatibilitas;
 *     kategori akhir selalu ditentukan dari dokumen native/OCR, tanpa kunci manual.
 *   - originalName: nama file asli sebelum multer rename — dipakai fallback
 *     SEP (lihat applyDeterministicFallback) karena di dataset RS ini nama
 *     file adalah SEP-nya sendiri.
 * @returns {Promise<{success, record, classification, pesan, tokens, attempts, metadata, errors, jenisKlaimDetection}>}
 *          `pesan` = teks siap tampil ke pengguna (kosong bila sukses).
 *          `errors` = detail teknis untuk log, JANGAN ditampilkan ke pengguna.
 *          `jenisKlaimDetection` = { value, source, confident } — cuma diisi
 *          kalau `allowedJenisKlaim` dipakai (lihat detectAndResolveJenisKlaim).
 */
async function extractFromPDF(filePath, options = {}) {
  const { skipAI = false, jenisKlaim: fixedJenisKlaim, allowedJenisKlaim, originalName } = options;
  const mulai = Date.now();

  const result = {
    success: false,
    record: null,
    classification: null,
    pesan: '',
    tokens: { prompt: 0, completion: 0, total: 0 },
    attempts: 0,
    metadata: { processingTimeMs: 0, pagesProcessed: 0, claimDataPagesFound: 0 },
    errors: [],
    jenisKlaimDetection: null,
    // Isi lembar grouper E-Klaim (hasil casemix), dibaca tanpa AI. Pembanding,
    // BUKAN sumber data klaim -- lihat lembarGrouperService.js.
    lembarGrouper: null,
    ocrPages: null,
  };

  try {
    let classification = await classifyPdfPages(filePath);
    result.classification = classification;
    result.metadata.pagesProcessed = classification.totalPages;
    result.metadata.claimDataPagesFound = classification.claimDataPages.length;
    if (typeof options.onPages === 'function' && classification.totalPages > 0) {
      try { await options.onPages(classification.totalPages); } catch (_) { /* status pelengkap */ }
    }

    if (!classification.success) {
      result.errors.push(...classification.errors.map(e => e.message));
      result.pesan = PESAN.tidakTerbaca;
      return result;
    }

    if (classification.claimDataPages.length === 0) {
      // Fallback OCR: kalau pdf-parse tidak menemukan teks (PDF scan/gambar),
      // coba OCR semua halaman lalu re-classify
      let ocrFallbackWorked = false;
      try {
        const { ocrPdfPages } = require('./ocrService');
        const totalText = classification.pages.reduce((sum, p) => sum + p.text_length, 0);
        // PDF campuran: halaman berteks (SPRI, resume, rincian biaya, lembar
        // grouper) cukup banyak, tetapi SEP-nya hasil scan -- data klaim hanya
        // ada di halaman scan. Dulu OCR hanya jalan bila total teks < 200
        // karakter, sehingga TRIMOKO (0170R0110126V000204, SEP hal. 2 scan)
        // ditolak "Berkas Klaim Individual tidak ditemukan".
        const adaHalamanScan = classification.pages.some(p => p.text_length < 50);
        if ((totalText < 200 || adaHalamanScan) && classification.totalPages > 0) {
          console.log(`[Pipeline] Teks pdf-parse terlalu sedikit (${totalText} chars), mencoba OCR...`);

          // ENHANCEMENT: Apply multi-pass OCR untuk extract vital signs dan clinical findings
          const ocrEnhancementEnabled = process.env.OCR_ENHANCEMENT_ENABLED !== 'false';
          if (ocrEnhancementEnabled) {
            console.log('[Pipeline] Applying enhanced OCR (multi-pass dengan vital signs extraction)...');
            classification = await applyOcrEnhancements(classification, filePath, {
              performEnhancedOcr: true,
              pageNumbers: null
            });
          } else {
            const ocrResult = await ocrPdfPages(filePath, 'all');
            classification.ocr_enhancement = {pass1_general_ocr:ocrResult};
            if (ocrResult.success && ocrResult.pages.length > 0) {
              const halamanGrouperOcr = ocrResult.pages.filter(p => isLembarGrouper(p.text));
              if (halamanGrouperOcr.length > 0) {
                classification.grouperPages = halamanGrouperOcr.map(p => ({ page_num: p.page_number, text: p.text }));
              }
              const ocrTexts = ocrResult.pages
                .filter(p => p.text && p.text.trim().length > 30 && !isLembarGrouper(p.text))
                .map(p => p.text);
              if (ocrTexts.length > 0) {
                const { isClaimDataPage } = require('./pdfPageClassifier');
                const combinedText = ocrTexts.join('\n\n---\n\n');
                if (isClaimDataPage(combinedText)) {
                  classification.claimDataText = combinedText;
                  classification.claimDataPages = ocrResult.pages.map((p, i) => ({
                    page_num: p.page_number, text: p.text
                  }));
                  result.metadata.claimDataPagesFound = classification.claimDataPages.length;
                  result.metadata.ocrFallback = true;
                }
              }
            }
          }

          // Check hasil OCR (enhanced atau standard)
          if (classification.claimDataText && classification.claimDataText.trim().length > 50) {
            const { isClaimDataPage } = require('./pdfPageClassifier');
            if (isClaimDataPage(classification.claimDataText)) {
              result.metadata.ocrFallback = true;
              result.metadata.ocrEnhancementApplied = classification.enhancement_applied || false;
              result.metadata.claimDataPagesFound = (classification.claimDataPages || []).length;
              ocrFallbackWorked = true;
              console.log(`[Pipeline] OCR fallback berhasil, enhancement: ${classification.enhancement_applied ? 'yes' : 'no'}`);
            }
          }
        }
      } catch (ocrErr) {
        console.warn('[Pipeline] OCR fallback gagal:', ocrErr.message || ocrErr);
      }

      if (!ocrFallbackWorked) {
        // Jangan gagal hanya karena kata kunci halaman data klaim tidak cocok
        // (format/vendor baru, judul SEP terpotong scan): seluruh halaman
        // berteks selain lembar grouper dipakai sebagai sumber data. Gagal
        // hanya bila dokumen memang kosong/tak terbaca.
        if (!pakaiSemuaHalaman(classification, result)) {
          result.pesan = PESAN.bukanBerkasKlaim;
          return result;
        }
      }
    } else {
      // ENHANCEMENT: Kalau pdf-parse SUDAH dapat teks, apply enhancement untuk extract vital signs
      const ocrEnhancementEnabled = process.env.OCR_ENHANCEMENT_ENABLED !== 'false';
      if (ocrEnhancementEnabled && filePath) {
        try {
          console.log('[Pipeline] Applying OCR enhancement (already have text, enriching with vital signs)...');
          const enhanced = await applyOcrEnhancements(classification, filePath, {
            performEnhancedOcr: true,
            pageNumbers: null
          });
          if (enhanced.enhancement_applied || enhanced.ocr_enhancement?.pass1_general_ocr?.pages?.length) {
            classification = enhanced;
            result.metadata.ocrEnhancementApplied = true;
          }
        } catch (enhanceErr) {
          console.warn('[Pipeline] Enhancement non-blocking gagal:', enhanceErr.message);
          // Lanjut tanpa enhancement — bukan blocking operation
        }
      }
    }

    // SEP/resume/SPRI dari native dan OCR menentukan kategori. Halaman IGD tidak
    // mengganti bukti rawat inap; pilihan tunggal klien lama tidak mengunci hasil.
    const { deteksiJenisDariHalaman } = require('./jenisLayananKlaimService');
    const grouperNums=new Set([...(classification.grouperPages||[]).map(p=>p.page_num),...(classification.pages||[]).filter(p=>p.is_lembar_grouper).map(p=>p.page_num)]);
    const ocr=((classification.ocr_enhancement?.pass1_general_ocr?.pages)||[])
      .filter(p=>!grouperNums.has(p.page_number)&&!isLembarGrouper(p.text||''));
    const ocrNums=new Set(ocr.filter(p=>String(p.text||'').trim().length>30).map(p=>p.page_number));
    const pagesJenis=[...(classification.pages||[]).filter(p=>!p.is_lembar_grouper&&!ocrNums.has(p.page_num)),...ocr];
    result.classification=classification;
    result.jenisKlaimDetection=deteksiJenisDariHalaman(pagesJenis);
    const jenisKlaim=result.jenisKlaimDetection.value;
    if(!jenisKlaim&&!skipAI){
      result.error_code='jenis_layanan_perlu_ditinjau';
      result.errors.push(result.jenisKlaimDetection.source);
      result.pesan=result.jenisKlaimDetection.konflik
        ? 'Jenis pelayanan berbeda antar dokumen. Periksa SEP dan dokumen perawatan; berkas tersimpan tanpa menebak kategori.'
        : 'Jenis pelayanan belum terbaca. Periksa halaman SEP atau surat perintah rawat inap; berkas tersimpan tanpa menebak kategori.';
      return result;
    }

    if (skipAI) {
      result.success = true;
      return result;
    }

    if ((!classification.claimDataText || classification.claimDataText.trim().length < 50) && !pakaiSemuaHalaman(classification, result)) {
      result.pesan = PESAN.dataKurang;
      return result;
    }

    const extraction = await extractClaimData(classification.claimDataText, jenisKlaim);
    result.tokens = extraction.tokens;
    result.attempts = extraction.attempts;

    if (!extraction.success) {
      result.error_code=extraction.error_code;
      result.errors.push(...extraction.errors);
      // Bedakan "belum disetel" (butuh tindakan IT) dari "gagal baca" (bisa dicoba lagi).
      const belumDisetel = extraction.errors.some(e => /AI_PROVIDER_API_KEY|401|403/i.test(e));
      result.pesan = belumDisetel ? PESAN.belumDisetel : PESAN.ekstraksiGagal;
      return result;
    }

    // Tanpa lembar grouper: kata "Electrocardiogram"/"chest x-ray" di lembar itu
    // tidak boleh terbaca sebagai bukti ada hasil penunjang, dan isiannya tidak
    // boleh mengisi kolom klaim lewat fallback deterministik.
    // Halaman scan ikut lewat teks OCR (pass 1 enhancement, sudah tanpa lembar
    // grouper) -- tanpa ini SEP hasil scan tidak pernah terbaca sebagai sinyal.
    const allPagesText = teksFallbackDokumen(classification);
    result.record = applyDeterministicFallback(extraction.record, allPagesText, jenisKlaim, originalName);
    // Dipakai RV-01/RV-02 (ruleEngine.js) buat bedakan "AI gagal ekstrak
    // NOKARTU dari dokumen BPJS asli" vs "dokumen ini memang bukan klaim BPJS".
    // Lembar grouper E-Klaim JKN tetap sah sebagai TANDA klaim BPJS (sinyal
    // administrasi, bukan bukti klinis): tanpa ini berkas yang SEP-nya hasil
    // scan tercatat has_bpjs_page=false dan halaman detail frontend crash
    // (YETY NOVIATI, 0170R0111225V003427).
    result.record.has_bpjs_page = hasBpjsPageSignal(allPagesText)
      || (Array.isArray(classification.grouperPages) && classification.grouperPages.length > 0);
    // Dipakai RV-12 (BA 1247/2024, diagnosis tumor + eksisi) -- SEBELUM ini
    // RV-12 selalu fire begitu kode cocok, tanpa cek dokumen ini sendiri sudah
    // menyertakan lampiran wajibnya atau belum (lihat 18 Sep 2026).
    result.record.has_laporan_operasi = hasLaporanOperasiSignal(allPagesText);
    result.record.has_hasil_pa = hasHasilPaSignal(allPagesText);
    // Fallback document signals (19 Sep 2026) — dipakai buat fallback K1-K5
    // assessment ketika Triase IGD tidak ada (lihat aiReviewService.js).
    result.record.has_laporan_operasi_vital_signs = hasLaporanOperasiVitalSigns(allPagesText);
    result.record.has_lab_results = hasLabResultsData(allPagesText);
    result.record.has_radiology_data = hasRadiologyData(allPagesText);

    // ENHANCEMENT: Merge OCR enhancements (vital signs, clinical findings) ke record
    if (classification.ocr_enhancement && classification.enhancement_applied) {
      result.record = mergeEnhancementsIntoRecord(result.record, classification);
      console.log('[Pipeline] Enhancement merged ke record');
    }

    // Parse notasi medis dan singkatan klinis dari teks klain
    try {
      // Ekstrak teks objektif (pemeriksaan fisik) dari classification.claimDataText
      // atau allPagesText untuk parsing notasi dan singkatan
      const clinicalText = classification.claimDataText || allPagesText;

      // Parse temuan pemeriksaan fisik dengan notasi bilaterality
      const physicalExamFindings = parsePhysicalExam(clinicalText);
      if (Object.keys(physicalExamFindings).length > 0) {
        result.record.physical_exam_findings = physicalExamFindings;
        console.log('[Pipeline] Notasi medis terparse:', Object.keys(physicalExamFindings).length, 'temuan');
      }

      // Terjemahkan singkatan klinis dalam resume/objective
      if (result.record.OBJECTIVE_FINDINGS) {
        result.record.OBJECTIVE_FINDINGS_TRANSLATED = translateClinicalText(result.record.OBJECTIVE_FINDINGS);
      }
    } catch (parseErr) {
      console.warn('[Pipeline] Parsing notasi medis gagal:', parseErr.message || parseErr);
      // Lanjutkan tanpa error — parsing notasi bukan blocking operation
    }

    // Ringkasan terstruktur 3-halaman (Resume Medis IGD, Triage IGD,
    // Assessment/Lembar Lain) siap pakai untuk UI/audit — gabungan hasil OCR
    // enhancement (extractClinicalFields di ocrEnhancement.js + tableParsingService.js,
    // dimerge lewat mergeEnhancementsIntoRecord jadi field _ocr_* di atas) dan
    // parser notasi medis (physical_exam_findings dari claimDataText, jalan
    // untuk SEMUA dokumen, bukan cuma yang di-OCR). Field _ocr_* individual
    // TETAP dipertahankan untuk audit trail granular — ini cuma rangkuman.
    result.record.structured_extraction = {
      diagnosis: result.record._ocr_diagnosis_list || [],
      prosedur: result.record._ocr_prosedur_list || [],
      vital_signs: result.record._ocr_vital_signs_detected || {},
      pengkajian_keperawatan: result.record._ocr_pengkajian_keperawatan || {},
      findings: {
        ...(result.record.physical_exam_findings || {}),
        ...(result.record._ocr_clinical_findings_notation || {})
      }
    };

    result.lembarGrouper = cariLembarGrouper(classification.grouperPages);
    // Hasil OCR pass 1 (sudah tanpa lembar grouper) disimpan pemanggil ke
    // ocr_results, supaya kumpulan bukti AI review tidak meng-OCR ulang PDF
    // yang sama (dulu setiap upload di-OCR dua kali).
    const pass1 = classification.ocr_enhancement && classification.ocr_enhancement.pass1_general_ocr;
    result.ocrPages = pass1 && Array.isArray(pass1.pages) && pass1.pages.length > 0 ? pass1.pages : null;
    if (result.lembarGrouper) {
      console.log(`[Pipeline] Lembar grouper E-Klaim (hal. ${result.lembarGrouper.halaman}) disimpan sebagai pembanding casemix, tidak dibaca AI.`);
    }

    result.success = true;
  } catch (error) {
    result.errors.push(error.message);
    result.pesan = PESAN.tidakTerbaca;
  } finally {
    result.metadata.processingTimeMs = Date.now() - mulai;
  }

  return result;
}

/** Klasifikasi halaman saja, tanpa memanggil AI (cepat & gratis). */
async function classifyOnly(filePath) {
  return extractFromPDF(filePath, { skipAI: true });
}

module.exports = { extractFromPDF, classifyOnly, PESAN, applyDeterministicFallback, teksFallbackDokumen };
