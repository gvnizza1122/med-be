/**
 * OCR Integration Module — Integrate enhanced OCR results ke dalam extraction pipeline
 *
 * Menggabungkan hasil standard OCR + enhanced multi-pass OCR ke dalam
 * claimDataText untuk AI processing yang lebih komprehensif
 */

const { enhancedOcrExtraction } = require('./ocrEnhancement');

// OCR Phase 1 (19 Sep 2026, client approved): batas keras total budget OCR
// enhancement turun jadi 3 menit/180000ms (sebelumnya hardcode 120000ms) —
// dibuat configurable lewat OCR_ENHANCEMENT_TIMEOUT, dan SENGAJA nilai yang
// SAMA persis dipakai sebagai budget internal ocrPdfPages() (lihat
// ENHANCEMENT_TIMEOUT_MS di ocrService.js) supaya loop halaman di dalamnya
// sempat berhenti sendiri (skip halaman non-critical) SEBELUM Promise.race
// di bawah ini memutus paksa dan membuang seluruh hasil yang sudah selesai.
const OCR_ENHANCEMENT_TIMEOUT_MS = parseInt(process.env.OCR_ENHANCEMENT_TIMEOUT || '180000', 10);

/**
 * Apply OCR enhancements ke hasil standard extraction
 *
 * @param {Object} standardResult - Standard classifyPdfPages result
 * @param {string} filePath - Path ke PDF file
 * @param {Object} options - { performEnhancedOcr, pageNumbers }
 * @returns {Promise<Object>} Enhanced result dengan vital signs dan clinical findings
 */
async function applyOcrEnhancements(standardResult, filePath, options = {}) {
  const {
    performEnhancedOcr = true,
    pageNumbers = null
  } = options;

  const enhanced = {
    ...standardResult,
    ocr_enhancement: null,
    vital_signs_from_ocr: {},
    clinical_findings_from_ocr: [],
    structured_text_from_ocr: {},
    // Halaman Resume Medis IGD: diagnosis/prosedur sebagai list (bukan 1
    // blok kalimat), plus detail bilateral (+/+, −/−, +/−, −/+) per temuan.
    diagnosis_list_from_ocr: [],
    prosedur_list_from_ocr: [],
    clinical_findings_notation_from_ocr: {},
    // Halaman Triage IGD: Primary Survey (ABCDE) & Pengkajian Keperawatan
    // (keluhan, riwayat penyakit, skala nyeri, skor ESI).
    primary_survey_from_ocr: {},
    pengkajian_keperawatan_from_ocr: {},
    // Halaman Assessment/Lembar Lain: Psikososial/Spiritual, Diagnosis
    // Keperawatan, Pengkajian Fungsional.
    assessment_from_ocr: {},
    enhancement_applied: false
  };

  if (!performEnhancedOcr) {
    return enhanced;
  }

  try {
    console.log('[OcrIntegration] Applying OCR enhancements...');

    // Timeout untuk OCR enhancement (Tesseract + clinical extraction), lihat
    // OCR_ENHANCEMENT_TIMEOUT_MS di atas. Kalau timeout, skip enhancement dan
    // lanjut dengan basic extraction saja.
    let timerBatas;
    const enhancementResult = await Promise.race([
      enhancedOcrExtraction(filePath, pageNumbers),
      new Promise((_, reject) => {
        timerBatas = setTimeout(() => reject(new Error(`OCR enhancement timeout (${OCR_ENHANCEMENT_TIMEOUT_MS / 1000}s)`)), OCR_ENHANCEMENT_TIMEOUT_MS);
      })
    ]).finally(() => clearTimeout(timerBatas));

    enhanced.ocr_enhancement = enhancementResult;

    // PDF tanpa teks asli (hasil scan): teks OCR per halaman menjadi
    // claimDataText, sama seperti jalur OCR non-enhanced di
    // pdfExtractionPipeline.js. Tanpa ini claimDataText hanya berisi ringkasan
    // vital/temuan di bawah, isClaimDataPage() selalu gagal, dan SETIAP PDF
    // scan ditolak "Berkas Klaim Individual tidak ditemukan" -- ditemukan saat
    // menguji salinan scan berkas 0170R0110826V000083 (1 Okt 2026).
    const halamanOcr = (enhancementResult.pass1_general_ocr?.pages || [])
      .filter(p => p.text && p.text.trim().length > 30);
    if ((!enhanced.claimDataText || enhanced.claimDataText.trim().length < 50) && halamanOcr.length > 0) {
      enhanced.claimDataText = halamanOcr.map(p => p.text).join('\n\n---\n\n');
      enhanced.claimDataPages = halamanOcr.map(p => ({ page_num: p.page_number, text: p.text }));
    }

    if (enhancementResult.success && enhancementResult.pass2_clinical_extraction) {
      // Extract vital signs yang terdeteksi
      const vitalSigns = enhancementResult.pass2_clinical_extraction.vital_signs;
      for (const [fieldName, data] of Object.entries(vitalSigns)) {
        enhanced.vital_signs_from_ocr[fieldName] = {
          value: data.value,
          raw_match: data.raw_match,
          page: data.page,
          confidence: 'high'
        };
      }

      // Extract clinical findings
      enhanced.clinical_findings_from_ocr = Object.entries(
        enhancementResult.pass2_clinical_extraction.clinical_findings
      )
        .filter(([_, found]) => found)
        .map(([finding, _]) => finding);

      // Extract structured text (Diagnosis/Procedure)
      if (enhancementResult.pass2_clinical_extraction.structured_text) {
        enhanced.structured_text_from_ocr = enhancementResult.pass2_clinical_extraction.structured_text;
      }

      // Diagnosis/Prosedur sebagai list, temuan fisik bilateral, Primary
      // Survey, Pengkajian Keperawatan, dan Assessment — lihat
      // extractClinicalFields() di ocrEnhancement.js.
      const clinicalExtraction = enhancementResult.pass2_clinical_extraction;
      enhanced.diagnosis_list_from_ocr = clinicalExtraction.diagnosis_list || [];
      enhanced.prosedur_list_from_ocr = clinicalExtraction.prosedur_list || [];
      enhanced.clinical_findings_notation_from_ocr = clinicalExtraction.clinical_findings_notation || {};
      enhanced.primary_survey_from_ocr = clinicalExtraction.primary_survey || {};
      enhanced.pengkajian_keperawatan_from_ocr = clinicalExtraction.pengkajian_keperawatan || {};
      enhanced.assessment_from_ocr = clinicalExtraction.assessment || {};

      // Append vital signs ke claimDataText untuk AI review
      if (enhancementResult.vital_signs_validated.validated_values &&
          Object.keys(enhancementResult.vital_signs_validated.validated_values).length > 0) {
        const vitalSignsText = formatVitalSignsForAi(
          enhancementResult.vital_signs_validated.validated_values
        );
        enhanced.claimDataText = `${enhanced.claimDataText}\n\n[OCR ENHANCED - VITAL SIGNS]\n${vitalSignsText}`;
      }

      // Append clinical findings ke claimDataText
      if (enhanced.clinical_findings_from_ocr.length > 0) {
        const clinicalText = `[OCR ENHANCED - CLINICAL FINDINGS]\nDitemukan pada pemeriksaan fisik:\n- ${enhanced.clinical_findings_from_ocr.join('\n- ')}`;
        enhanced.claimDataText = `${enhanced.claimDataText}\n\n${clinicalText}`;
      }

      // Append structured text ke claimDataText
      if (Object.keys(enhanced.structured_text_from_ocr).length > 0) {
        const struct = enhanced.structured_text_from_ocr;
        let structText = '[OCR ENHANCED - DIAGNOSIS & PROSEDUR]\n';
        if (struct.DiagnosisUtama) structText += `Diagnosis Utama: ${struct.DiagnosisUtama}\n`;
        if (struct.DiagnosisSekunder) structText += `Diagnosis Sekunder: ${struct.DiagnosisSekunder}\n`;
        if (struct.TindakanProsedur) structText += `Tindakan/Prosedur: ${struct.TindakanProsedur}\n`;
        enhanced.claimDataText = `${enhanced.claimDataText}\n\n${structText}`;
      }

      // Append Primary Survey (Triage IGD) ke claimDataText
      if (Object.keys(enhanced.primary_survey_from_ocr).length > 0) {
        const ps = enhanced.primary_survey_from_ocr;
        let psText = '[OCR ENHANCED - PRIMARY SURVEY]\n';
        for (const field of ['Airway', 'Breathing', 'Circulation', 'Disability', 'Exposure']) {
          if (ps[field]) psText += `${field}: ${ps[field]}\n`;
        }
        enhanced.claimDataText = `${enhanced.claimDataText}\n\n${psText}`;
      }

      // Append Pengkajian Keperawatan (Triage IGD) ke claimDataText
      if (Object.keys(enhanced.pengkajian_keperawatan_from_ocr).length > 0) {
        const pk = enhanced.pengkajian_keperawatan_from_ocr;
        let pkText = '[OCR ENHANCED - PENGKAJIAN KEPERAWATAN]\n';
        if (pk.keluhan) pkText += `Keluhan: ${pk.keluhan}\n`;
        if (pk.riwayat_penyakit) pkText += `Riwayat Penyakit: ${pk.riwayat_penyakit}\n`;
        if (pk.skala_nyeri) pkText += `Skala Nyeri: ${pk.skala_nyeri}\n`;
        if (pk.skor_esi) pkText += `Skor ESI: ${pk.skor_esi}\n`;
        enhanced.claimDataText = `${enhanced.claimDataText}\n\n${pkText}`;
      }

      // Append Assessment/Lembar Lain (Psikososial/Spiritual, Diagnosis
      // Keperawatan, Pengkajian Fungsional) ke claimDataText
      if (Object.keys(enhanced.assessment_from_ocr).length > 0) {
        const asmt = enhanced.assessment_from_ocr;
        let asmtText = '[OCR ENHANCED - ASSESSMENT KEPERAWATAN]\n';
        if (asmt.psikososial_spiritual) asmtText += `Psikososial/Spiritual: ${asmt.psikososial_spiritual}\n`;
        if (asmt.diagnosis_keperawatan) asmtText += `Diagnosis Keperawatan: ${asmt.diagnosis_keperawatan}\n`;
        if (asmt.pengkajian_fungsional) asmtText += `Pengkajian Fungsional: ${asmt.pengkajian_fungsional}\n`;
        enhanced.claimDataText = `${enhanced.claimDataText}\n\n${asmtText}`;
      }

      enhanced.enhancement_applied = true;
      console.log('[OcrIntegration] Enhancement applied:', {
        vital_signs_found: Object.keys(enhanced.vital_signs_from_ocr).length,
        clinical_findings_found: enhanced.clinical_findings_from_ocr.length,
        structured_text_found: Object.keys(enhanced.structured_text_from_ocr).length,
        diagnosis_list_found: enhanced.diagnosis_list_from_ocr.length,
        prosedur_list_found: enhanced.prosedur_list_from_ocr.length,
        pengkajian_keperawatan_found: Object.keys(enhanced.pengkajian_keperawatan_from_ocr).length
      });
    }
  } catch (enhancementError) {
    if (enhancementError.message.includes('timeout')) {
      console.warn('[OcrIntegration] OCR enhancement timeout, skipping enhanced features:', enhancementError.message);
      // Continue dengan basic extraction saja, jangan fail
    } else {
      console.error('[OcrIntegration] OCR enhancement error:', enhancementError);
      throw enhancementError;
    }
  }

  return enhanced;
}

/**
 * Format vital signs untuk AI processing
 */
function formatVitalSignsForAi(validatedValues) {
  const lines = [];

  if (validatedValues.HeartRate !== undefined) {
    lines.push(`Detak Jantung (HR): ${validatedValues.HeartRate} bpm`);
  }
  if (validatedValues.RespiratoryRate !== undefined) {
    lines.push(`Frekuensi Napas (RR): ${validatedValues.RespiratoryRate} x/menit`);
  }
  if (validatedValues.SpO2 !== undefined) {
    lines.push(`Saturasi Oksigen (SpO2): ${validatedValues.SpO2}%`);
  }
  if (validatedValues.Temperature !== undefined) {
    lines.push(`Suhu Badan (Temp): ${validatedValues.Temperature}°C`);
  }
  if (validatedValues.BloodPressure !== undefined) {
    lines.push(`Tekanan Darah (BP): ${validatedValues.BloodPressure} mmHg`);
  }
  if (validatedValues.Weight !== undefined) {
    lines.push(`Berat Badan (BB): ${validatedValues.Weight} kg`);
  }
  if (validatedValues.Height !== undefined) {
    lines.push(`Tinggi Badan (TB): ${validatedValues.Height} cm`);
  }

  return lines.join('\n');
}

/**
 * Merge OCR enhancements ke dalam record untuk audit trail
 */
function mergeEnhancementsIntoRecord(record, enhancementResult) {
  if (!record || !enhancementResult || !enhancementResult.ocr_enhancement) {
    return record;
  }

  // Tambah field untuk OCR enhancements (bukan overwrite field standard)
  record._ocr_vital_signs_detected = enhancementResult.vital_signs_from_ocr;
  record._ocr_clinical_findings = enhancementResult.clinical_findings_from_ocr;
  record._ocr_structured_text = enhancementResult.structured_text_from_ocr;
  record._ocr_enhancement_applied = enhancementResult.enhancement_applied;
  // Resume Medis IGD: diagnosis/prosedur sebagai list + detail bilateral temuan fisik.
  record._ocr_diagnosis_list = enhancementResult.diagnosis_list_from_ocr || [];
  record._ocr_prosedur_list = enhancementResult.prosedur_list_from_ocr || [];
  record._ocr_clinical_findings_notation = enhancementResult.clinical_findings_notation_from_ocr || {};
  // Triage IGD: Primary Survey (ABCDE) & Pengkajian Keperawatan.
  record._ocr_primary_survey = enhancementResult.primary_survey_from_ocr || {};
  record._ocr_pengkajian_keperawatan = enhancementResult.pengkajian_keperawatan_from_ocr || {};
  // Assessment/Lembar Lain: Psikososial/Spiritual, Diagnosis Keperawatan, Pengkajian Fungsional.
  record._ocr_assessment = enhancementResult.assessment_from_ocr || {};

  // Jika BERAT_BADAN terdeteksi dari OCR tapi field di record kosong, isi dari OCR
  if (!record.BERAT_BADAN && enhancementResult.vital_signs_from_ocr.Weight) {
    record.BERAT_BADAN = String(enhancementResult.vital_signs_from_ocr.Weight.value);
    record._berat_badan_source = 'ocr_vital_signs';
    console.log('[OcrIntegration] Mengisi BERAT_BADAN dari OCR vital signs');
  }

  return record;
}

module.exports = {
  applyOcrEnhancements,
  formatVitalSignsForAi,
  mergeEnhancementsIntoRecord
};
