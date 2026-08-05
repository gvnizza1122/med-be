/**
 * Pipeline ekstraksi PDF klaim → 1 record vClaim (60 kolom).
 *
 * Alur: klasifikasi halaman (pdf-parse) → ambil teks halaman claim-data →
 *       ekstraksi AI → record vClaim sesuai skema resmi.
 *
 * Env: AI_PROVIDER_API_KEY (wajib), AI_PROVIDER_BASE_URL, AI_MODEL, AI_MAX_ATTEMPTS, AI_TIMEOUT_MS.
 */

const { classifyPdfPages } = require('./pdfPageClassifier');
const { extractClaimData } = require('./pdfExtractionService');

/**
 * Jaring pengaman deterministik (regex, BUKAN AI) untuk SEP/NOKARTU/KELAS_RAWAT
 * — dijalankan SETELAH ekstraksi AI, cuma mengisi field yang AI kembalikan
 * kosong (tidak pernah menimpa nilai yang sudah terisi AI). Berjalan di
 * SELURUH teks halaman (bukan cuma yang lolos klasifikasi claim-data), jadi
 * tetap bekerja walau kata kunci klasifikasi halaman meleset atau AI lalai
 * mengikuti instruksi prompt — dua kegagalan yang pernah terjadi sebelumnya.
 */
function applyDeterministicFallback(record, allPagesText, jenisKlaim) {
  if (!record.SEP) {
    const m = /no\.?\s*sep\s*:?\s*([0-9A-Za-z]{10,30})\b/i.exec(allPagesText);
    if (m) {
      record.SEP = m[1].toUpperCase();
      console.log('[Pipeline] Fallback regex mengisi SEP (AI mengembalikan kosong).');
    }
  }
  if (!record.NOKARTU) {
    const m = /no\.?\s*kartu\s*:?\s*\(?\s*(\d{13})\b/i.exec(allPagesText);
    if (m) {
      record.NOKARTU = m[1];
      console.log('[Pipeline] Fallback regex mengisi NOKARTU (AI mengembalikan kosong).');
    }
  }
  if (!record.KELAS_RAWAT && jenisKlaim === 'RAWAT_JALAN') {
    // Label field bervariasi "Kelas Hak"/"Kls Hak", nilainya bisa "Kelas 2" atau
    // langsung "2" — regex ini tangani kombinasi label singkat/panjang x nilai
    // dengan/tanpa kata "Kelas" di depan angka.
    const m = /(?:kelas|kls\.?)\s*hak\s*:?\s*(?:kelas\s*)?(\d)\b/i.exec(allPagesText);
    if (m) {
      record.KELAS_RAWAT = m[1];
      console.log('[Pipeline] Fallback regex mengisi KELAS_RAWAT dari Kelas Hak (rawat jalan, AI mengembalikan kosong).');
    }
  }
  return record;
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
 * @param {{skipAI?: boolean, jenisKlaim?: string}} options - jenisKlaim dipakai
 *   untuk instruksi khusus KELAS_RAWAT (rawat jalan -> fallback ke Kelas Hak).
 * @returns {Promise<{success, record, classification, pesan, tokens, attempts, metadata, errors}>}
 *          `pesan` = teks siap tampil ke pengguna (kosong bila sukses).
 *          `errors` = detail teknis untuk log, JANGAN ditampilkan ke pengguna.
 */
async function extractFromPDF(filePath, options = {}) {
  const { skipAI = false, jenisKlaim } = options;
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
    result.record = applyDeterministicFallback(extraction.record, allPagesText, jenisKlaim);
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
