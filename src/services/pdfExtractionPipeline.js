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
 * @param {{skipAI?: boolean}} options
 * @returns {Promise<{success, record, classification, pesan, tokens, attempts, metadata, errors}>}
 *          `pesan` = teks siap tampil ke pengguna (kosong bila sukses).
 *          `errors` = detail teknis untuk log, JANGAN ditampilkan ke pengguna.
 */
async function extractFromPDF(filePath, options = {}) {
  const { skipAI = false } = options;
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
      result.pesan = PESAN.bukanBerkasKlaim;
      return result;
    }

    if (skipAI) {
      result.success = true;
      return result;
    }

    if (!classification.claimDataText || classification.claimDataText.trim().length < 50) {
      result.pesan = PESAN.dataKurang;
      return result;
    }

    const extraction = await extractClaimData(classification.claimDataText);
    result.tokens = extraction.tokens;
    result.attempts = extraction.attempts;

    if (!extraction.success) {
      result.errors.push(...extraction.errors);
      // Bedakan "belum disetel" (butuh tindakan IT) dari "gagal baca" (bisa dicoba lagi).
      const belumDisetel = extraction.errors.some(e => /AI_PROVIDER_API_KEY|401|403/i.test(e));
      result.pesan = belumDisetel ? PESAN.belumDisetel : PESAN.ekstraksiGagal;
      return result;
    }

    result.record = extraction.record;
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
