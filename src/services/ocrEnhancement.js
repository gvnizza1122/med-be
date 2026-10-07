/**
 * OCR Enhancement Pipeline — Multi-pass OCR dengan structured field extraction
 *
 * ENHANCEMENTS:
 * 1. Multi-pass OCR: text extraction + structured field extraction
 * 2. Regex patterns untuk vital signs (SpO2, HR, RR, BP, Temp)
 * 3. Regex patterns untuk clinical findings (ronchi, whezing, murmur, dll)
 * 4. Page classification enhancement untuk specialized pages
 * 5. Validation dengan sanity checks
 *
 * Dipakai oleh pdfExtractionPipeline.js sebagai enhancement pass setelah standard OCR
 */

const fs = require('fs');
const path = require('path');
const { ocrPdfPages } = require('./ocrService');
const { isLembarGrouper } = require('./lembarGrouperService');
// Bilateral notation (+/+, −/−, +/−, −/+) SUDAH punya parser dedicated —
// dipakai lagi di sini (bukan reimplementasi) supaya clinical findings dari
// OCR dapat detail sisi kanan/kiri, bukan cuma boolean "ditemukan/tidak".
const { parsePhysicalExam } = require('./notasiMedisParser');
const {
  parseVitalSignsTable,
  parsePengkajianKeperawatanBox,
  parseAssessmentSection,
  parseLaporanOperasiVitalSigns,
  parseLabResults,
  parseRadiologyFindings,
} = require('./tableParsingService');

/**
 * Pattern ekstraksi untuk vital signs dan clinical findings
 * Dioptimalkan untuk dokumen medis scan dengan font bervariasi
 */
const CLINICAL_PATTERNS = {
  // VITAL SIGNS
  SpO2: [
    /\bSpO2\s*[:=]\s*(\d{1,3})[\s%]?/i,
    /\boxygenation\s*[:=]\s*(\d{1,3})[\s%]?/i,
    /\bsat\s+o2?\s*[:=]\s*(\d{1,3})[\s%]?/i,
    /oxygen\s+saturation\s*[:=]\s*(\d{1,3})[\s%]?/i,
  ],
  HeartRate: [
    /\bHR\s*[:=]\s*(\d{2,3})[\s/]*(?:bpm|x')/i,
    /\bheart\s+rate\s*[:=]\s*(\d{2,3})[\s/]*(?:bpm|x')/i,
    /\bnadi\s*[:=]\s*(\d{2,3})/i,
    /\bpuls\s*[:=]\s*(\d{2,3})/i,
  ],
  RespiratoryRate: [
    /\bRR\s*[:=]\s*(\d{1,2})[\s/]*(?:x'|rpm)/i,
    /\brespiratory\s+rate\s*[:=]\s*(\d{1,2})/i,
    /\bfrekuensi\s+napas\s*[:=]\s*(\d{1,2})/i,
  ],
  BloodPressure: [
    /\bBP\s*[:=]\s*(\d{2,3})\s*[\/\-]\s*(\d{2,3})[\s/]?(?:mmHg)?/i,
    /\btensi\s*[:=]\s*(\d{2,3})\s*[\/\-]\s*(\d{2,3})/i,
    /\btekanan\s+darah\s*[:=]\s*(\d{2,3})\s*[\/\-]\s*(\d{2,3})/i,
  ],
  Temperature: [
    /\btemp\s*[:=]\s*([\d.]{2,4})[\s°]?c/i,
    /\btemperatur\s*[:=]\s*([\d.]{2,4})[\s°]?c/i,
    /\bfever\s*[:=]\s*([\d.]{2,4})/i,
  ],
  Weight: [
    /\bBB\s*[:=]\s*(\d{1,3})[\s]?kg/i,
    /\bberat\s+badan\s*[:=]\s*(\d{1,3})[\s]?kg/i,
    /\bweight\s*[:=]\s*(\d{1,3})[\s]?kg/i,
  ],
  Height: [
    /\bTB\s*[:=]\s*(\d{2,3})[\s]?cm/i,
    /\btinggi\s+badan\s*[:=]\s*(\d{2,3})[\s]?cm/i,
    /\bheight\s*[:=]\s*(\d{2,3})[\s]?cm/i,
  ],

  // CLINICAL FINDINGS — notasi bilateral dokumen ini SELALU pakai pemisah
  // "/" antara sisi kanan/kiri (mis. "+/+", bukan "+ +"/"++"), lihat
  // notasiMedisParser.js. `\/?` di bawah membuat pattern tetap cocok untuk
  // varian tanpa slash juga (jaga-jaga OCR menghilangkan karakter "/").
  Ronchi: [
    /\bronchi\s*[:\s]*\+\s*\/?\s*\+/i,
    /\brhonchi\s*[:\s]*\+\s*\/?\s*\+/i,
    /\brales\s+rhonchus/i,
  ],
  Whezing: [
    /\bwheez(?:ing)?\s*[:\s]*\+\s*\/?\s*\+/i,
    /\bwheezing\s*[:\s]*\+\s*\/?\s*\+/i,
  ],
  Murmur: [
    /\bmurmur\s*[:\s]*\+\s*\/?\s*\+/i,
    /\bheart\s+murmur/i,
  ],
  Crackles: [
    /\bcrackles?\s*[:\s]*\+\s*\/?\s*\+/i,
    /\brales\s*[:\s]*\+\s*\/?\s*\+/i,
  ],
  Edema: [
    /\bedema\s*[:\s]*\+\s*\/?\s*\+/i,
    /\bpitting\s+edema/i,
  ],
};

// Label section berikutnya yang mungkin muncul setelah blok teks yang sedang
// ditangkap — dipakai sebagai lookahead supaya capture multi-line (mis.
// diagnosis 2-3 baris/numbered list) berhenti di section berikutnya, BUKAN
// "menelan" seluruh sisa dokumen. Daftar ini diambil dari label section yang
// benar-benar dipakai formulir RS ini (lihat KEGAWATDARURATAN_SYSTEM_PROMPT
// di aiReviewService.js untuk daftar section Triage IGD).
const NEXT_SECTION_LABELS = [
  // Marker gabungan multi-halaman (lihat allText di extractClinicalFields) —
  // WAJIB paling duluan supaya capture apapun tidak pernah menyeberang
  // batas halaman, biarpun label section berikutnya tidak dikenali.
  '\\[PAGE\\s+\\d+\\]', '---PAGE BREAK---',
  'Diagnosis\\s+Utama', 'Diagnosis\\s+Sekunder', 'Diagnosis\\s+Keperawatan',
  'Tindakan\\s*\\/\\s*Prosedur', 'Prosedur', 'Terapi(?:\\/pengobatan)?', 'Diet',
  'Keadaan', 'Instruksi', 'Anjuran', 'Catatan', 'Kode\\s+ICD',
  'Riwayat\\s+Penyakit', 'Riwayat\\s+Alergi', 'Keluhan', 'Skala\\s+Nyeri',
  '(?:Skor\\s+)?ESI\\s*:', 'Primary\\s+Survey', 'Vital\\s+Sign',
  'Psikososial', 'Pengkajian\\s+Fungsional', 'Pengkajian\\s+Keperawatan',
  'Kesadaran', 'Tanggal', 'Dokter', 'Perawat', 'Ringkasan',
  'Pemeriksaan\\s+Fisik', 'Triase', 'Triage', 'Resume\\s+Medis',
];
const NEXT_SECTION_LOOKAHEAD = `(?=${NEXT_SECTION_LABELS.join('|')}|$)`;

/**
 * Pattern ekstraksi blok teks terstruktur (Diagnosis & Prosedur, Resume Medis IGD)
 */
const STRUCTURED_TEXT_PATTERNS = {
  DiagnosisUtama: new RegExp(`Diagnosis\\s+Utama\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
  DiagnosisSekunder: new RegExp(`Diagnosis\\s+Sekunder\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
  TindakanProsedur: new RegExp(`Tindakan\\s*\\/\\s*Prosedur\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
  // "Prosedur" berdiri sendiri (tanpa label "Tindakan/") — beberapa dokumen
  // cuma menulis "Prosedur:" polos, bukan gabungan "Tindakan/Prosedur:".
  Prosedur: new RegExp(`(?<!Tindakan\\s*\\/\\s*)\\bProsedur\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
};

/**
 * Pattern ekstraksi Primary Survey (Triage IGD): Airway/Breathing/
 * Circulation/Disability/Exposure — lihat catatan section di
 * KEGAWATDARURATAN_SYSTEM_PROMPT (aiReviewService.js).
 */
const PRIMARY_SURVEY_LOOKAHEAD_TAIL = NEXT_SECTION_LABELS.join('|');
const PRIMARY_SURVEY_PATTERNS = {
  Airway: new RegExp(`Airway\\s*:?\\s*([\\s\\S]*?)(?=Breathing|${PRIMARY_SURVEY_LOOKAHEAD_TAIL}|$)`, 'i'),
  Breathing: new RegExp(`Breathing\\s*:?\\s*([\\s\\S]*?)(?=Circulation|${PRIMARY_SURVEY_LOOKAHEAD_TAIL}|$)`, 'i'),
  Circulation: new RegExp(`Circulation\\s*:?\\s*([\\s\\S]*?)(?=Disability|${PRIMARY_SURVEY_LOOKAHEAD_TAIL}|$)`, 'i'),
  Disability: new RegExp(`Disability\\s*:?\\s*([\\s\\S]*?)(?=Exposure|${PRIMARY_SURVEY_LOOKAHEAD_TAIL}|$)`, 'i'),
  Exposure: new RegExp(`Exposure\\s*:?\\s*([\\s\\S]*?)(?=${PRIMARY_SURVEY_LOOKAHEAD_TAIL}|$)`, 'i'),
};

/**
 * Pattern ekstraksi dari Laporan Operasi (fallback sources) — Diagnosis Pra/Pasca
 * Tindakan, Tindakan Operasi, Anestetik, Obat-obatan.
 */
const LAPORAN_OPERASI_PATTERNS = {
  DiagnosisPraTindakan: new RegExp(`Diagnosis\\s+Pra\\s*Tindakan\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
  DiagnosisPascaTindakan: new RegExp(`Diagnosis\\s+Pasca\\s*Tindakan\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
  TindakanOperasi: new RegExp(`Tindakan\\s+Operasi\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
  Anestetik: new RegExp(`Anestetik\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
  ObatObatan: new RegExp(`Obat(?:\\s*[-–]?\\s*obatan)?\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
};

/**
 * Pattern ekstraksi dari Hasil Pemeriksaan Laboratorium
 */
const LAB_RESULTS_PATTERNS = {
  Hematologi: new RegExp(`HEMATOLOGI\\s*([\\s\\S]*?)(?=KIMIA|ANALISA|SEROLOGY|$)`, 'i'),
  Kimia: new RegExp(`KIMIA|ANALISA\\s+KIMIA\\s*([\\s\\S]*?)(?=SEROLOGY|ANALISA|$)`, 'i'),
};

/**
 * Pattern ekstraksi dari Hasil Pemeriksaan Radiologi
 */
const RADIOLOGY_PATTERNS = {
  DiagnosisRadiologi: new RegExp(`DIAGNOSIS\\s+RADIOLOGI\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
  Findings: new RegExp(`FINDINGS?\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
  Impression: new RegExp(`IMPRESSION|KESIMPULAN\\s*:\\s*([\\s\\S]*?)${NEXT_SECTION_LOOKAHEAD}`, 'i'),
};

/**
 * Pecah teks multi-item (diagnosis/prosedur) jadi array — dokumen sering
 * menulis dalam bentuk numbered list ("1. ... 2. ...") atau baris terpisah,
 * bukan satu kalimat tunggal.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitToList(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/\r?\n|(?=\d{1,2}[\.\)]\s)|;/)
    .map(s => s.replace(/^[-•\d\.\)]+\s*/, '').trim())
    .filter(s => s.length > 1 && s !== '-');
}


/**
 * Extract vital signs dan clinical findings dari OCR text multi-pass
 *
 * Pass 1: General text extraction
 * Pass 2: Structured clinical field extraction dengan regex patterns
 *
 * @param {Array<{page_number, text, confidence}>} ocrPages - OCR results per page
 * @returns {Object} Extracted vital signs dan clinical findings
 */
function extractClinicalFields(ocrPages) {
  const result = {
    vital_signs: {},
    clinical_findings: {},
    // Detail bilateral (+/+, −/−, +/−, −/+) per temuan — pelengkap
    // clinical_findings yang cuma boolean, lihat notasiMedisParser.js.
    clinical_findings_notation: {},
    structured_text: {},
    diagnosis_list: [],
    prosedur_list: [],
    primary_survey: {},
    pengkajian_keperawatan: {},
    assessment: {},
    raw_extractions: [],
    extraction_confidence: {}
  };


  if (!Array.isArray(ocrPages) || ocrPages.length === 0) {
    return result;
  }

  // Combine all OCR text dengan pemisah page yang jelas
  const allText = ocrPages
    .map(p => `[PAGE ${p.page_number}]\n${p.text}`)
    .join('\n\n---PAGE BREAK---\n\n');

  // Extract vital signs
  for (const [fieldName, patterns] of Object.entries(CLINICAL_PATTERNS)) {
    if (fieldName === 'Ronchi' || fieldName === 'Whezing' || fieldName === 'Murmur' ||
        fieldName === 'Crackles' || fieldName === 'Edema') {
      // Clinical findings (boolean/presence)
      for (const pattern of patterns) {
        const match = allText.match(pattern);
        if (match) {
          result.clinical_findings[fieldName] = true;
          result.raw_extractions.push({
            type: 'clinical_finding',
            field: fieldName,
            match: match[0],
            page: findPageNumberInMatch(allText, match.index)
          });
          break;
        }
      }
    } else {
      // Vital signs (numeric values)
      for (const pattern of patterns) {
        const match = allText.match(pattern);
        if (match) {
          const value = fieldName === 'BloodPressure'
            ? `${match[1]}/${match[2]}`
            : match[1];

          if (!result.vital_signs[fieldName]) {
            result.vital_signs[fieldName] = {
              value,
              raw_match: match[0],
              page: findPageNumberInMatch(allText, match.index),
              pattern_index: patterns.indexOf(pattern)
            };
            result.extraction_confidence[fieldName] = 'high'; // regex match = confident
          }
          break;
        }
      }
    }
  }

  // Extract dari tabel Vital Sign (Triage IGD) — jalan lewati label eksplisit
  // dulu, fallback tabel posisional (header + 1 baris angka) kalau tidak ketemu.
  // Diisi HANYA untuk field yang belum terisi dari CLINICAL_PATTERNS linear di atas.
  const vitalSignsFromTable = parseVitalSignsTable(allText);
  for (const [fieldName, data] of Object.entries(vitalSignsFromTable)) {
    if (!result.vital_signs[fieldName]) {
      const approxIndex = allText.indexOf(data.raw_match);
      result.vital_signs[fieldName] = {
        value: data.value,
        raw_match: data.raw_match,
        page: findPageNumberInMatch(allText, approxIndex >= 0 ? approxIndex : 0),
        pattern_index: 99,
        source: data.source
      };
      result.extraction_confidence[fieldName] = data.source === 'label' ? 'high' : 'medium';
    }
  }

  // Extract structured text (Diagnosis, Prosedur, Resume Medis IGD)
  for (const [fieldName, pattern] of Object.entries(STRUCTURED_TEXT_PATTERNS)) {
    const match = allText.match(pattern);
    if (match && match[1] && match[1].trim() && match[1].trim() !== '-') {
      result.structured_text[fieldName] = match[1].trim().replace(/\n/g, ' ');
      result.raw_extractions.push({
        type: 'structured_text',
        field: fieldName,
        match: match[0],
        page: findPageNumberInMatch(allText, match.index)
      });
    }
  }

  // Diagnosis utama + sekunder digabung jadi 1 list terurut (utama duluan) —
  // dipecah per-item karena dokumen sering menulis multi-diagnosis.
  result.diagnosis_list = [
    ...splitToList(result.structured_text.DiagnosisUtama),
    ...splitToList(result.structured_text.DiagnosisSekunder)
  ];
  // Prosedur/Tindakan: gabung dari label "Tindakan/Prosedur" dan "Prosedur" berdiri
  // sendiri (dedupe karena bisa sama-sama cocok di dokumen yang beririsan).
  result.prosedur_list = Array.from(new Set([
    ...splitToList(result.structured_text.TindakanProsedur),
    ...splitToList(result.structured_text.Prosedur)
  ]));

  // Primary Survey (Triage IGD): Airway/Breathing/Circulation/Disability/Exposure
  for (const [fieldName, pattern] of Object.entries(PRIMARY_SURVEY_PATTERNS)) {
    const match = allText.match(pattern);
    if (match && match[1] && match[1].trim() && match[1].trim() !== '-') {
      result.primary_survey[fieldName] = match[1].trim().replace(/\s*\n\s*/g, ' ');
    }
  }

  // Pengkajian Keperawatan box (Triage IGD): keluhan, riwayat penyakit, skala
  // nyeri, skor ESI.
  result.pengkajian_keperawatan = parsePengkajianKeperawatanBox(allText);

  // Assessment/Lembar Lain: Psikososial/Spiritual, Diagnosis Keperawatan,
  // Pengkajian Fungsional.
  result.assessment = parseAssessmentSection(allText);

  // Temuan pemeriksaan fisik dengan detail bilateral (+/+, −/−, +/−, −/+) —
  // dipakai notasiMedisParser yang sudah teruji, bukan reimplementasi regex
  // baru. Discan PER HALAMAN (bukan allText gabungan) supaya marker
  // "---PAGE BREAK---"/"[PAGE N]" tidak ikut "kebaca" sebagai notasi (garis
  // "---" mengandung tanda "-" yang bisa salah tertangkap sebagai notasi
  // tunggal), dan temuan tidak menyeberang dari satu halaman ke halaman lain.
  try {
    for (const page of ocrPages) {
      const bilateralFindings = parsePhysicalExam(page.text || '');
      for (const [temuan, detail] of Object.entries(bilateralFindings)) {
        // Lewati temuan tanpa notasi jelas (ada:null) — bukan hasil ekstraksi
        // yang bisa diandalkan, cuma noise baris teks tanpa tanda +/−.
        // Field pertama yang ketemu menang (dokumen biasanya cuma sebut 1x).
        if (detail && detail.ada !== null && !result.clinical_findings_notation[temuan]) {
          result.clinical_findings_notation[temuan] = { ...detail, page: page.page_number };
        }
      }
    }
  } catch (err) {
    // Non-blocking — parsing notasi bilateral bukan bagian kritikal ekstraksi.
    console.warn('[EnhancedOCR] Parsing notasi bilateral gagal:', err.message || err);
  }

  return result;
}

/**
 * Helper: find page number dari match index dalam combined text
 */
function findPageNumberInMatch(text, matchIndex) {
  const beforeMatch = text.substring(0, matchIndex);
  const pageMatches = beforeMatch.match(/\[PAGE (\d+)\]/g) || [];
  if (pageMatches.length > 0) {
    const lastPageMatch = pageMatches[pageMatches.length - 1];
    const pageNum = lastPageMatch.match(/\d+/)[0];
    return parseInt(pageNum);
  }
  return 1; // default page 1
}

/**
 * Classify page untuk mendeteksi specialized sections
 * Membantu prioritize OCR focus area
 *
 * @param {string} pageText - Teks halaman dari OCR
 * @returns {Object} Page classification dengan type dan keywords ditemukan
 */
function classifyPageContent(pageText) {
  const classification = {
    type: 'general',
    sections: [],
    keywords_found: []
  };

  if (!pageText || typeof pageText !== 'string') {
    return classification;
  }

  const lowerText = pageText.toLowerCase();

  // Deteksi Resume Medis IGD / Triage
  if (/resume\s+medis\s+igd|triage\s+igd|igd\s+triage/i.test(pageText)) {
    classification.type = 'resume_medis_igd';
    classification.sections.push('vital_signs', 'triage', 'physical_exam');
    // IGD pages PASTI ada vital signs — prioritize ekstraksi
  }

  // Deteksi Resume Medis Rawat Inap
  if (/resume\s+medis\s+(?:rawat\s+inap|RI)/i.test(pageText)) {
    classification.type = 'resume_medis_inap';
    classification.sections.push('physical_exam', 'assessment', 'plan');
  }

  // Deteksi halaman Triase — HANYA jadi type kalau belum ada type lebih
  // spesifik yang terdeteksi (mis. "resume_medis_igd" di atas). Sebelumnya
  // block ini SELALU menimpa classification.type biarpun sudah spesifik —
  // halaman "RESUME MEDIS IGD" yang (wajar) juga menyebut "Vital Signs"
  // salah kena downgrade jadi 'triage' generik.
  if (/triase|triage|vital\s+sign|pemeriksaan\s+fisik/i.test(pageText)) {
    if (classification.type === 'general') classification.type = 'triage';
    classification.sections.push('vital_signs', 'physical_exam');
  }

  // Deteksi box "Pengkajian Keperawatan" (keluhan, riwayat penyakit, skala
  // nyeri, skor ESI) dan Primary Survey — biasanya di halaman Triage IGD.
  if (/pengkajian\s+keperawatan|skor\s+esi|\bESI\s*[:=]/i.test(pageText)) {
    classification.sections.push('pengkajian_keperawatan');
  }
  if (/primary\s+survey/i.test(pageText)) {
    classification.sections.push('primary_survey');
  }

  // Deteksi halaman Assessment/Lembar Lain (Psikososial/Spiritual, Diagnosis
  // Keperawatan, Pengkajian Fungsional) — biasanya lembar terpisah dari Triage.
  if (/psikososial|diagnosis\s+keperawatan|pengkajian\s+fungsional/i.test(pageText)) {
    if (classification.type === 'general') classification.type = 'assessment_keperawatan';
    classification.sections.push('psikososial_spiritual', 'diagnosis_keperawatan', 'pengkajian_fungsional');
  }

  // Deteksi halaman Resep
  if (/resep|prescription|obat[\s-]?obatan/i.test(pageText)) {
    classification.type = 'prescription';
    classification.sections.push('medications');
  }

  // Deteksi SEP / SURAT ELIGIBILITAS PESERTA
  if (/surat\s+eligi|sep|eligibilitas\s+peserta/i.test(pageText)) {
    classification.type = 'sep';
    classification.sections.push('patient_info', 'eligibility');
  }

  // Deteksi Laporan Operasi (fallback source, 19 Sep 2026)
  if (/laporan\s+operasi|laporan\s+tindakan\s+operatif/i.test(pageText)) {
    if (classification.type === 'general') classification.type = 'laporan_operasi';
    classification.sections.push('vital_signs', 'diagnosis', 'prosedur', 'anestetik', 'obat');
  }

  // Deteksi Hasil Pemeriksaan Laboratorium (fallback source, 19 Sep 2026)
  if (/hasil\s+pemeriksaan\s+laboratorium|pemeriksaan\s+laboratorium|hematologi|kimia\s+darah/i.test(pageText)) {
    if (classification.type === 'general') classification.type = 'lab_results';
    classification.sections.push('hematologi', 'kimia', 'lab_results');
  }

  // Deteksi Hasil Pemeriksaan Radiologi (fallback source, 19 Sep 2026)
  if (/hasil\s+pemeriksaan\s+radiologi|radiologi|ct\s+scan|x[\s-]?ray|mri|ultrasound|sonografi/i.test(pageText)) {
    if (classification.type === 'general') classification.type = 'radiology';
    classification.sections.push('diagnosis_radiologi', 'findings', 'impression');
  }

  // Deteksi EKG (fallback source, 19 Sep 2026)
  if (/ekg|elektrokardiogram|electrocardiogram|rekam\s+jantung/i.test(pageText)) {
    if (classification.type === 'general') classification.type = 'ekg';
    classification.sections.push('ekg', 'cardiac_findings');
  }

  // Keyword detection untuk clinical findings
  const clinicalKeywords = [
    'ronchi', 'whezing', 'murmur', 'crackles', 'edema', 'auskultasi',
    'palpasi', 'perkusi', 'inspeksi', 'pemeriksaan fisik'
  ];
  for (const kw of clinicalKeywords) {
    if (lowerText.includes(kw)) {
      classification.keywords_found.push(kw);
    }
  }

  return classification;
}

/**
 * Extract fallback dokumen sources (Laporan Operasi, Lab Results, Radiology)
 * — dipanggil ketika Triase IGD tidak ditemukan sebagai fallback untuk K1-K5
 *
 * @param {Array<{page_number, text, confidence}>} ocrPages - OCR results per page
 * @returns {Object} Extracted data dari fallback sources
 */
function extractFallbackDocumentData(ocrPages) {
  const result = {
    laporan_operasi: {
      vital_signs: null,
      diagnosis_pra_tindakan: null,
      diagnosis_pasca_tindakan: null,
      tindakan_operasi: null,
      anestetik: null,
      obat_obatan: null,
    },
    lab_results: {
      hematologi: [],
      kimia: [],
    },
    radiology: {
      diagnosis_radiologi: null,
      findings: null,
      impression: null,
    },
    ekg: {
      interpretation: null,
    },
  };

  if (!Array.isArray(ocrPages) || ocrPages.length === 0) {
    return result;
  }

  const allText = ocrPages
    .map(p => `[PAGE ${p.page_number}]\n${p.text}`)
    .join('\n\n---PAGE BREAK---\n\n');

  // Extract Laporan Operasi
  for (const [fieldName, pattern] of Object.entries(LAPORAN_OPERASI_PATTERNS)) {
    const match = allText.match(pattern);
    if (match && match[1] && match[1].trim() && match[1].trim() !== '-') {
      const fieldKey = fieldName.replace(/^([A-Z])/, s => s.toLowerCase()).replace(/([A-Z])/g, '_$1').toLowerCase();
      result.laporan_operasi[fieldKey] = match[1].trim().replace(/\n/g, ' ').substring(0, 500);
    }
  }

  // Ekstrak vital signs dari tabel Laporan Operasi
  const operasiMatch = allText.match(/LAPORAN\s+OPERASI[\s\S]{0,2000}?(?=---PAGE|$)/i);
  if (operasiMatch) {
    const vitalSigns = parseLaporanOperasiVitalSigns(operasiMatch[0]);
    if (Object.keys(vitalSigns).length > 0) {
      result.laporan_operasi.vital_signs = vitalSigns;
    }
  }

  // Extract Lab Results
  const labMatch = allText.match(/HASIL\s+PEMERIKSAAN\s+LABORATORIUM[\s\S]{0,2000}?(?=---PAGE|$)/i);
  if (labMatch) {
    const labData = parseLabResults(labMatch[0]);
    result.lab_results = labData;
  }

  // Extract Radiology
  for (const [fieldName, pattern] of Object.entries(RADIOLOGY_PATTERNS)) {
    const match = allText.match(pattern);
    if (match && match[1] && match[1].trim() && match[1].trim() !== '-') {
      const fieldKey = fieldName.replace(/^([A-Z])/, s => s.toLowerCase()).replace(/([A-Z])/g, '_$1').toLowerCase();
      result.radiology[fieldKey] = match[1].trim().replace(/\n/g, ' ').substring(0, 500);
    }
  }

  const radiologyMatch = allText.match(/HASIL\s+PEMERIKSAAN\s+RADIOLOGI[\s\S]{0,2000}?(?=---PAGE|$)/i);
  if (radiologyMatch) {
    const radiologyData = parseRadiologyFindings(radiologyMatch[0]);
    Object.assign(result.radiology, radiologyData);
  }

  // Extract EKG (simplified — cukup deteksi adanya temuan EKG)
  const ekgMatch = allText.match(/EKG|ELEKTROKARDIOGRAM[\s\S]{0,500}?(?=---PAGE|$)/i);
  if (ekgMatch) {
    const ekgInterpMatch = ekgMatch[0].match(/INTERPRETATION|INTERPRETASI|KESIMPULAN\s*:?\s*([^\n]+)/i);
    if (ekgInterpMatch && ekgInterpMatch[1]) {
      result.ekg.interpretation = ekgInterpMatch[1].trim().substring(0, 200);
    }
  }

  return result;
}

/**
 * Validate extracted vital signs dengan sanity checks
 *
 * @param {Object} vitalSigns - Result dari extractClinicalFields.vital_signs
 * @returns {Object} Validation report dengan warnings dan errors
 */
function validateVitalSigns(vitalSigns) {
  const report = {
    valid: true,
    warnings: [],
    errors: [],
    validated_values: {}
  };

  if (!vitalSigns || typeof vitalSigns !== 'object') {
    return report;
  }

  // HR: 40-200 bpm adalah range realistik
  if (vitalSigns.HeartRate) {
    const hr = parseInt(vitalSigns.HeartRate.value);
    if (hr < 40) {
      report.warnings.push(`HR ${hr} bpm di bawah normal (<40), kemungkinan bradikardia`);
    } else if (hr > 200) {
      report.errors.push(`HR ${hr} bpm di atas range realistik (>200), mungkin OCR error`);
      report.valid = false;
    }
    report.validated_values.HeartRate = hr;
  }

  // RR: 10-40 breaths/min adalah range realistik
  if (vitalSigns.RespiratoryRate) {
    const rr = parseInt(vitalSigns.RespiratoryRate.value);
    if (rr < 8) {
      report.errors.push(`RR ${rr} di bawah minimum (bradiapnea), kemungkinan OCR error`);
      report.valid = false;
    } else if (rr > 50) {
      report.errors.push(`RR ${rr} di atas range normal (takipnea berat), validate manual`);
      report.warnings.push('Nilai ekstrem, perlu cek dokumen asli');
    }
    report.validated_values.RespiratoryRate = rr;
  }

  // SpO2: 88-100% adalah range realistik
  if (vitalSigns.SpO2) {
    const spo2 = parseInt(vitalSigns.SpO2.value);
    if (spo2 < 80) {
      report.errors.push(`SpO2 ${spo2}% kritical (<80%), pasien perlu intervensi`);
      report.warnings.push('Nilai kritis, cek dokumen asli');
      report.valid = false;
    } else if (spo2 > 100) {
      report.warnings.push(`SpO2 ${spo2}% di atas 100%, kemungkinan OCR error`);
    }
    report.validated_values.SpO2 = spo2;
  }

  // Temperature: 35-42C adalah range realistik
  if (vitalSigns.Temperature) {
    const temp = parseFloat(vitalSigns.Temperature.value);
    if (temp < 35) {
      report.errors.push(`Temperature ${temp}C hypothermia, validate manual`);
      report.valid = false;
    } else if (temp > 42) {
      report.errors.push(`Temperature ${temp}C hyperthermia ekstrem, validate manual`);
      report.valid = false;
    }
    report.validated_values.Temperature = temp;
  }

  // BP: Systolic 70-250, Diastolic 40-150
  if (vitalSigns.BloodPressure) {
    const [sys, dia] = vitalSigns.BloodPressure.value.split('/').map(Number);
    if (sys < 70 || sys > 250) {
      report.warnings.push(`Systolic BP ${sys} di luar range normal, validate manual`);
    }
    if (dia < 40 || dia > 150) {
      report.warnings.push(`Diastolic BP ${dia} di luar range normal, validate manual`);
    }
    report.validated_values.BloodPressure = `${sys}/${dia}`;
  }

  return report;
}

/**
 * Multi-pass OCR enhancement untuk PDF klaim
 *
 * @param {string|Buffer} pdfPath - Path ke PDF
 * @param {number[]} pageNumbers - Nomor halaman target (opsional)
 * @returns {Promise<Object>} Enhanced extraction result dengan vital signs & clinical findings
 */
async function enhancedOcrExtraction(pdfPath, pageNumbers = null) {
  const result = {
    success: false,
    pass1_general_ocr: null,
    pass2_clinical_extraction: null,
    page_classifications: [],
    vital_signs_validated: {},
    clinical_findings_validated: {},
    processing_time_ms: 0,
    errors: []
  };

  const startTime = Date.now();

  try {
    // PASS 1: Standard OCR text extraction
    console.log('[EnhancedOCR] Pass 1: General text extraction...');
    const awal = await ocrPdfPages(pdfPath, pageNumbers || 'all');
    const ocrMentah = await require('./pemulihanPembacaanService').pulihkanPembacaan(awal,
      halaman => ocrPdfPages(pdfPath, halaman, undefined, { timeoutMs: 180000 }));
    // Lembar grouper E-Klaim (hasil casemix) dipisahkan: tidak ikut ekstraksi
    // klinis maupun teks klaim, hanya disimpan sebagai pembanding.
    const halamanOcr = (ocrMentah && ocrMentah.pages) || [];
    result.halaman_grouper = halamanOcr.filter(p => isLembarGrouper(p.text));
    const ocrResult = { ...ocrMentah, pages: halamanOcr.filter(p => !isLembarGrouper(p.text)) };
    result.pass1_general_ocr = ocrResult;

    if (!ocrResult.success || !ocrResult.pages || ocrResult.pages.length === 0) {
      result.errors.push('OCR Pass 1 gagal atau tidak ada halaman terproses');
      result.processing_time_ms = Date.now() - startTime;
      return result;
    }

    // PASS 2: Structured clinical field extraction
    console.log('[EnhancedOCR] Pass 2: Structured clinical field extraction...');
    const clinicalExtraction = extractClinicalFields(ocrResult.pages);
    result.pass2_clinical_extraction = clinicalExtraction;

    // Classify setiap halaman untuk context
    console.log('[EnhancedOCR] Classifying page content...');
    result.page_classifications = ocrResult.pages.map(page => ({
      page_number: page.page_number,
      classification: classifyPageContent(page.text)
    }));

    // Validate extracted vital signs
    console.log('[EnhancedOCR] Validating vital signs...');
    const vitalSignsValidation = validateVitalSigns(clinicalExtraction.vital_signs);
    result.vital_signs_validated = vitalSignsValidation;

    // Summary clinical findings
    result.clinical_findings_validated = {
      found: Object.keys(clinicalExtraction.clinical_findings).filter(
        k => clinicalExtraction.clinical_findings[k]
      ),
      total_examined: Object.keys(clinicalExtraction.clinical_findings).length,
      confidence: 'high' // regex-based = confident
    };

    result.success = true;
    console.log('[EnhancedOCR] Enhancement complete:', {
      pages_processed: ocrResult.pages.length,
      vital_signs_found: Object.keys(clinicalExtraction.vital_signs).length,
      clinical_findings: result.clinical_findings_validated.found.length
    });

  } catch (error) {
    result.errors.push(error.message || String(error));
    console.error('[EnhancedOCR] Enhancement gagal:', error);
  }

  result.processing_time_ms = Date.now() - startTime;
  return result;
}

module.exports = {
  extractClinicalFields,
  extractFallbackDocumentData,
  classifyPageContent,
  validateVitalSigns,
  enhancedOcrExtraction,
  splitToList,
  CLINICAL_PATTERNS,
  STRUCTURED_TEXT_PATTERNS,
  PRIMARY_SURVEY_PATTERNS,
  LAPORAN_OPERASI_PATTERNS,
  LAB_RESULTS_PATTERNS,
  RADIOLOGY_PATTERNS
};
