/**
 * OCR Integration Module — Integrate enhanced OCR results ke dalam extraction pipeline
 *
 * Menggabungkan hasil standard OCR + enhanced multi-pass OCR ke dalam
 * claimDataText untuk AI processing yang lebih komprehensif
 */

const { enhancedOcrExtraction } = require('./ocrEnhancement');

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
    enhancement_applied: false
  };

  if (!performEnhancedOcr) {
    return enhanced;
  }

  try {
    console.log('[OcrIntegration] Applying OCR enhancements...');
    const enhancementResult = await enhancedOcrExtraction(filePath, pageNumbers);

    enhanced.ocr_enhancement = enhancementResult;

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

      enhanced.enhancement_applied = true;
      console.log('[OcrIntegration] Enhancement applied:', {
        vital_signs_found: Object.keys(enhanced.vital_signs_from_ocr).length,
        clinical_findings_found: enhanced.clinical_findings_from_ocr.length
      });
    }
  } catch (error) {
    console.warn('[OcrIntegration] Enhancement gagal, lanjut tanpa enhancement:', error.message);
    // Jangan block pipeline — enhancement adalah optional enhancement
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
  record._ocr_enhancement_applied = enhancementResult.enhancement_applied;

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
