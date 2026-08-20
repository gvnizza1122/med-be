/**
 * Pipeline ekstraksi PDF klaim → 1 record vClaim (60 kolom).
 *
 * Alur: klasifikasi halaman (pdf-parse) → ambil teks halaman claim-data →
 *       ekstraksi AI → record vClaim sesuai skema resmi.
 *
 * Env: AI_PROVIDER_API_KEY (wajib), AI_PROVIDER_BASE_URL, AI_MODEL, AI_MAX_ATTEMPTS, AI_TIMEOUT_MS.
 */

const { classifyPdfPages, detectJenisKlaim, hasBpjsPageSignal } = require('./pdfPageClassifier');
const { extractClaimData } = require('./pdfExtractionService');

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
  const isOutpatientLike = jenisKlaim === 'RAWAT_JALAN' || jenisKlaim === 'GAWAT_DARURAT';
  if (!record.KELAS_RAWAT && isOutpatientLike) {
    // Label field bervariasi "Kelas Hak"/"Kls Hak", nilainya bisa "Kelas 2" atau
    // langsung "2" — regex ini tangani kombinasi label singkat/panjang x nilai
    // dengan/tanpa kata "Kelas" di depan angka.
    const m = /(?:kelas|kls\.?)\s*hak\s*:?\s*(?:kelas\s*)?(\d)\b/i.exec(allPagesText);
    if (m) {
      record.KELAS_RAWAT = m[1];
      console.log('[Pipeline] Fallback regex mengisi KELAS_RAWAT dari Kelas Hak (rawat jalan, AI mengembalikan kosong).');
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
  bukanBerkasKlaim: 'Halaman "Berkas Klaim Individual" tidak ditemukan di dokumen ini. Periksa apakah berkas yang diunggah sudah benar.',
  dataKurang: 'Data pada dokumen terlalu sedikit untuk diproses. Periksa kembali kelengkapan berkas.',
  ekstraksiGagal: 'Data belum berhasil dibaca otomatis. Silakan coba lagi beberapa saat, atau isi manual bila tetap gagal.',
  belumDisetel: 'Layanan pembacaan otomatis belum aktif. Hubungi petugas IT rumah sakit.',
};

/**
 * @param {string|Buffer} filePath - path PDF atau Buffer
 * @param {{skipAI?: boolean, jenisKlaim?: string, allowedJenisKlaim?: string[], originalName?: string}} options
 *   - jenisKlaim: kategori SUDAH PASTI (dipilih manual, mis. upload 1 file) —
 *     dipakai apa adanya, TIDAK ada deteksi otomatis.
 *   - allowedJenisKlaim: dipakai kalau kategori BELUM PASTI dan perlu
 *     dideteksi dari isi dokumen (upload batch kategori-campur) — daftar
 *     kategori yang verifikator toggle di awal sebagai "kemungkinan ada di
 *     batch ini". Hasil deteksi divalidasi terhadap daftar ini (lihat
 *     result.jenisKlaimDetection di bawah); kalau jenisKlaim juga diisi,
 *     jenisKlaim menang (allowedJenisKlaim diabaikan).
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
  };

  try {
    const classification = await classifyPdfPages(filePath);
    result.classification = classification;
    result.metadata.pagesProcessed = classification.totalPages;
    result.metadata.claimDataPagesFound = classification.claimDataPages.length;

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
        if (totalText < 200 && classification.totalPages > 0) {
          console.log(`[Pipeline] Teks pdf-parse terlalu sedikit (${totalText} chars), mencoba OCR...`);
          const ocrResult = await ocrPdfPages(filePath, 'all');
          if (ocrResult.success && ocrResult.pages.length > 0) {
            const ocrTexts = ocrResult.pages
              .filter(p => p.text && p.text.trim().length > 30)
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
                ocrFallbackWorked = true;
                console.log(`[Pipeline] OCR fallback berhasil, ${ocrTexts.length} halaman terbaca.`);
              }
            }
          }
        }
      } catch (ocrErr) {
        console.warn('[Pipeline] OCR fallback gagal:', ocrErr.message || ocrErr);
      }

      if (!ocrFallbackWorked) {
        result.pesan = PESAN.bukanBerkasKlaim;
        return result;
      }
    }

    // Resolusi kategori pelayanan — jenisKlaim TETAP (dipilih manual) menang
    // kalau diisi; kalau tidak, deteksi otomatis dari isi dokumen (upload
    // batch kategori-campur) dibatasi ke allowedJenisKlaim yang verifikator
    // toggle di awal. Dilakukan di sini (setelah klasifikasi, sebelum
    // ekstraksi AI) karena butuh teks dokumen tapi ekstraksi AI sendiri
    // butuh tau jenisKlaim dulu (aturan KELAS_RAWAT/tanggal beda per
    // kategori) — jadi urutannya wajib klasifikasi -> deteksi -> ekstraksi.
    let jenisKlaim = fixedJenisKlaim;
    if (!jenisKlaim && Array.isArray(allowedJenisKlaim) && allowedJenisKlaim.length > 0) {
      const allPagesTextForDetection = classification.pages.map(p => p.text_full).join('\n\n');
      const detected = detectJenisKlaim(allPagesTextForDetection);
      if (detected && allowedJenisKlaim.includes(detected)) {
        jenisKlaim = detected;
        result.jenisKlaimDetection = { value: detected, source: 'auto', confident: true };
      } else if (allowedJenisKlaim.length === 1) {
        // Cuma 1 kategori ditoggle -> tidak ambigu sama sekali biarpun
        // deteksi konten gagal/kosong, langsung pakai itu tanpa tanda ragu.
        jenisKlaim = allowedJenisKlaim[0];
        result.jenisKlaimDetection = { value: jenisKlaim, source: 'single-allowed', confident: true };
      } else {
        // Terdeteksi tapi di luar daftar yang ditoggle, ATAU gagal terdeteksi
        // sama sekali, DAN ada >1 kandidat — jangan menebak, pakai kandidat
        // pertama tapi tandai TIDAK yakin supaya verifikator diberi tahu
        // untuk cek manual (bukan disembunyikan sebagai hasil pasti).
        jenisKlaim = allowedJenisKlaim[0];
        result.jenisKlaimDetection = { value: jenisKlaim, source: detected ? 'detected-not-in-allowed-list' : 'undetected', confident: false };
      }
    }

    if (skipAI) {
      result.success = true;
      return result;
    }

    if (!classification.claimDataText || classification.claimDataText.trim().length < 50) {
      result.pesan = PESAN.dataKurang;
      return result;
    }

    const extraction = await extractClaimData(classification.claimDataText, jenisKlaim);
    result.tokens = extraction.tokens;
    result.attempts = extraction.attempts;

    if (!extraction.success) {
      result.errors.push(...extraction.errors);
      // Bedakan "belum disetel" (butuh tindakan IT) dari "gagal baca" (bisa dicoba lagi).
      const belumDisetel = extraction.errors.some(e => /AI_PROVIDER_API_KEY|401|403/i.test(e));
      result.pesan = belumDisetel ? PESAN.belumDisetel : PESAN.ekstraksiGagal;
      return result;
    }

    const allPagesText = classification.pages.map(p => p.text_full).join('\n\n');
    result.record = applyDeterministicFallback(extraction.record, allPagesText, jenisKlaim, originalName);
    // Dipakai RV-01/RV-02 (ruleEngine.js) buat bedakan "AI gagal ekstrak
    // NOKARTU dari dokumen BPJS asli" vs "dokumen ini memang bukan klaim BPJS".
    result.record.has_bpjs_page = hasBpjsPageSignal(allPagesText);
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

module.exports = { extractFromPDF, classifyOnly, PESAN };
