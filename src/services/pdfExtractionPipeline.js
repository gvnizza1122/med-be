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

const { classifyPdfPages, detectJenisKlaim, hasBpjsPageSignal, hasLaporanOperasiSignal, hasHasilPaSignal, hasLaporanOperasiVitalSigns, hasLabResultsData, hasRadiologyData } = require('./pdfPageClassifier');
const { extractClaimData } = require('./pdfExtractionService');
const { parsePhysicalExam, translateClinicalText } = require('./notasiMedisParser');
const { applyOcrEnhancements, mergeEnhancementsIntoRecord } = require('./ocrIntegration');

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
    let classification = await classifyPdfPages(filePath);
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
              ocrFallbackWorked = true;
              console.log(`[Pipeline] OCR fallback berhasil, enhancement: ${classification.enhancement_applied ? 'yes' : 'no'}`);
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
          if (enhanced.enhancement_applied) {
            classification = enhanced;
            result.metadata.ocrEnhancementApplied = true;
          }
        } catch (enhanceErr) {
          console.warn('[Pipeline] Enhancement non-blocking gagal:', enhanceErr.message);
          // Lanjut tanpa enhancement — bukan blocking operation
        }
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

module.exports = { extractFromPDF, classifyOnly, PESAN, applyDeterministicFallback };
