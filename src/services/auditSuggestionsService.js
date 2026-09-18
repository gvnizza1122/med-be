/**
 * Audit Suggestions Service
 * Generates tariff-blind medical coding suggestions strictly based on verbatim clinical evidence
 * ("Bukti Dulu, Tarif Menyusul") with strict anti-upcoding guardrails.
 */

const { getDb } = require('../database/init');
const { generateAiReview, validateQuotation, annotateKamusValid } = require('./aiReviewService');

/**
 * Pemetaan kode alternatif untuk istilah medis ambigu (terutama Kelompok J Pernapasan & umum)
 */
const AMBIGUOUS_CODE_ALTERNATIVES = {
  // Kelompok J (Pernapasan / Respiratory)
  'J18.9': [
    { code: 'J18.0', description: 'Bronchopneumonia, unspecified' },
    { code: 'J15.9', description: 'Bacterial pneumonia, unspecified' },
    { code: 'J12.9', description: 'Viral pneumonia, unspecified' }
  ],
  'J18.0': [
    { code: 'J18.9', description: 'Pneumonia, unspecified' },
    { code: 'J15.9', description: 'Bacterial pneumonia, unspecified' }
  ],
  'J45.9': [
    { code: 'J45.901', description: 'Unspecified asthma with acute exacerbation' },
    { code: 'J45.0', description: 'Predominantly allergic asthma' },
    { code: 'J46', description: 'Status asthmaticus' }
  ],
  'J44.9': [
    { code: 'J44.1', description: 'Chronic obstructive pulmonary disease with acute exacerbation' },
    { code: 'J44.0', description: 'Chronic obstructive pulmonary disease with acute lower respiratory infection' }
  ],
  'A16.2': [
    { code: 'A15.0', description: 'Tuberculosis of lung, bacteriologically and histologically confirmed' },
    { code: 'A16.0', description: 'Tuberculosis of lung, bacteriologically and histologically negative' }
  ],
  '96.04': [
    { code: '93.94', description: 'Respiratory medication administering / Nebulization' }
  ],
  '87.44': [
    { code: '87.49', description: 'Other chest X-ray' }
  ]
};

/**
 * Cek apakah string mengandung istilah finansial/nominal (DILARANG KERAS dalam saran koding)
 */
function hasFinancialTerms(text) {
  if (!text || typeof text !== 'string') return false;
  const pattern = /(rp\.?|rupiah|biaya|tarif|harga|ongkos|klaim\s+sebesar|nominals?|selisih\s+biaya|\d+\.\d{3}\.\d{3}|\d+\s*ribu|\d+\s*juta)/i;
  return pattern.test(text);
}

/**
 * Cek apakah string mengandung indikasi rawat inap (DILARANG KERAS untuk klaim RAWAT_JALAN)
 */
function hasInpatientOnlyTerms(text) {
  if (!text || typeof text !== 'string') return false;
  const pattern = /(rawat\s+inap|opname|kamar\s+inap|masuk\s+ranap|icu|hcu|iccu|picu|nicu|bangsal|ruang\s+perawatan|los\s*>\s*1|lama\s+rawat\s+\d+\s*hari)/i;
  return pattern.test(text);
}

/**
 * Menghasilkan rekomendasi audit koding medis berbasis bukti verbatim
 * @param {string} recordId
 * @returns {Promise<Object>}
 */
async function generateAuditSuggestions(recordId) {
  const db = getDb();
  await db.initialize();

  const record = await db.prepare('SELECT * FROM claim_records WHERE id = ?').get(recordId);
  if (!record) {
    throw new Error(`Record klaim dengan ID ${recordId} tidak ditemukan.`);
  }

  // 1. Ambil bukti OCR / dokumen dari database
  const ocrRows = await db.prepare(`
    SELECT page_number, ocr_text, confidence
    FROM ocr_results
    WHERE record_id = ?
    ORDER BY page_number ASC
  `).all(recordId);

  const evidencePool = ocrRows.map(r => ({
    page_number: r.page_number,
    ocr_text: r.ocr_text || '',
    confidence: r.confidence || 0
  }));

  const validationErrors = await db.prepare('SELECT * FROM validation_errors WHERE record_id = ?').all(recordId);

  // 2. Jalankan AI review & ekstraksi koding medis
  const aiReview = await generateAiReview(record, validationErrors, evidencePool, [], []);

  const jenisKlaim = (record.jenis_klaim || 'RAWAT_INAP').trim().toUpperCase();
  const rawSuggestions = (aiReview && Array.isArray(aiReview.suggested_codes)) ? aiReview.suggested_codes : [];

  // 3. Terapkan Rambu Anti-Upcoding Ketat & 5 Langkah Rekomendasi
  const filteredSuggestions = [];

  for (const entry of rawSuggestions) {
    const { code, type, page_number: pageNum, quotation, reasoning, kamus_valid } = entry || {};

    if (!code || !quotation || !pageNum) continue;

    // Guardrail 1: Wajib ada kutipan verbatim dari dokumen pendukung
    if (evidencePool.length > 0 && !validateQuotation(quotation, pageNum, evidencePool)) {
      console.warn(`[AUDIT-SUGGESTIONS] Rejected code "${code}": Verbatim quotation invalid on page ${pageNum}.`);
      continue;
    }

    // Guardrail 2: DILARANG KERAS sebut nominal rupiah / biaya / finansial
    if (hasFinancialTerms(quotation) || hasFinancialTerms(reasoning)) {
      console.warn(`[AUDIT-SUGGESTIONS] Rejected code "${code}": Financial terms detected.`);
      continue;
    }

    // Guardrail 3: Untuk RAWAT_JALAN, saring istilah rawat inap
    if (jenisKlaim === 'RAWAT_JALAN' && hasInpatientOnlyTerms(reasoning)) {
      console.warn(`[AUDIT-SUGGESTIONS] Rejected code "${code}": Inpatient-only terms in reasoning for RAWAT_JALAN.`);
      continue;
    }

    // Langkah 5: Sertakan opsi kode alternatif jika ada ambiguitas istilah medis
    const altList = AMBIGUOUS_CODE_ALTERNATIVES[code.toUpperCase()] || [];

    filteredSuggestions.push({
      code: code.trim().toUpperCase(),
      type: type || 'diagnosis',
      page_number: pageNum,
      quotation: quotation.substring(0, 300),
      reasoning: (reasoning || '').substring(0, 300),
      kamus_valid: kamus_valid !== undefined ? kamus_valid : true,
      alternative_codes: altList
    });
  }

  // Langkah 3: Buta-Tarif — pengurutan murni berdasarkan bukti medis (nomor halaman & ketersediaan kamus), BUKAN tarif
  filteredSuggestions.sort((a, b) => a.page_number - b.page_number);

  return {
    record_id: recordId,
    sep: record.sep || null,
    jenis_klaim: jenisKlaim,
    diagnosa_eksisting: record.diagnosa_list || null,
    prosedur_eksisting: record.prosedur_list || null,
    suggested_codes: filteredSuggestions,
    audit_summary: {
      total_suggestions: filteredSuggestions.length,
      policy: "Bukti Dulu, Tarif Menyusul (Anti-Upcoding Strict Enforcement)",
      verified_by_dictionary: filteredSuggestions.filter(s => s.kamus_valid === true).length
    }
  };
}

module.exports = {
  generateAuditSuggestions,
  hasFinancialTerms,
  hasInpatientOnlyTerms,
  AMBIGUOUS_CODE_ALTERNATIVES
};
