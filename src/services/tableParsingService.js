/**
 * Table Parsing Service — ekstraksi data tabel/box terstruktur dari teks OCR
 * (Vital Sign, Pengkajian Keperawatan, Assessment Psikososial/Diagnosis
 * Keperawatan/Pengkajian Fungsional) di dokumen Triage IGD & Lembar Lain.
 *
 * Dipakai oleh ocrEnhancement.js sebagai pelengkap CLINICAL_PATTERNS/
 * STRUCTURED_TEXT_PATTERNS yang linear (satu baris "Label: nilai") — tabel
 * OCR sering berupa 1 baris header diikuti 1 baris nilai (kolom dipisah
 * spasi ganda, BUKAN label per nilai), jadi butuh strategi parsing berbeda.
 *
 * CATATAN: parser di sini heuristik (regex + tokenisasi baris), bukan OCR
 * table-detection berbasis bounding box — cukup untuk teks hasil tesseract.js
 * yang sudah berupa string linear per baris (lihat ocrService.js).
 */

/**
 * Pecah 1 baris jadi token kolom. Tabel OCR biasanya kolom dipisah run spasi
 * panjang (>=2) atau tab; kalau tidak ada run panjang, fallback ke spasi
 * tunggal (baris label-nilai sederhana).
 */
function splitRowTokens(line) {
  const byRuns = String(line || '')
    .split(/\s{2,}|\t+/)
    .map(t => t.trim())
    .filter(Boolean);
  if (byRuns.length > 1) return byRuns;
  return String(line || '')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);
}

/** Heuristik: baris "terlihat" seperti header tabel (token pendek, bukan kalimat). */
function looksLikeHeaderLine(line) {
  const byRuns = String(line || '')
    .split(/\s{2,}|\t+/)
    .map(t => t.trim())
    .filter(Boolean);
  const usingColumnRuns = byRuns.length > 1;
  const tokens = usingColumnRuns ? byRuns : splitRowTokens(line);
  if (tokens.length < 2) return false;

  // Kalau kolom kepisah run spasi panjang (>=2), itu format tabel yang kuat —
  // cukup cek panjang token. Kalau fallback ke spasi tunggal, JAUH lebih rawan
  // false-positive (kalimat narasi biasa juga jadi banyak token pendek) —
  // batasi jumlah kolom & tolak token yang diakhiri tanda baca kalimat.
  if (!usingColumnRuns) {
    if (tokens.length > 6) return false;
    if (tokens.some(t => /[.,]$/.test(t))) return false;
  }

  return tokens.every(t => t.length <= 24 && !/[.,]\s/.test(t));
}

/**
 * Parser tabel generik: cari baris header (>=2 kolom pendek) diikuti baris
 * data, kembalikan struktur JSON standar `{header: [], rows: [{col1, col2, ...}]}`.
 *
 * @param {string} text - potongan teks (idealnya sudah di-scope ke sekitar tabel target)
 * @returns {{header: string[], rows: Object[]}}
 */
function parseTable(text) {
  const result = { header: [], rows: [] };
  if (!text || typeof text !== 'string') return result;

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length - 1; i++) {
    if (!looksLikeHeaderLine(lines[i])) continue;
    const headerTokens = splitRowTokens(lines[i]);
    if (headerTokens.length < 2) continue;

    const dataRows = [];
    let j = i + 1;
    while (j < lines.length) {
      const rowTokens = splitRowTokens(lines[j]);
      if (rowTokens.length === 0) break;
      // Berhenti kalau baris berikutnya kelihatan seperti header tabel LAIN
      // (bukan kelanjutan tabel yang sama) — cukup 1 tabel per pemanggilan.
      if (looksLikeHeaderLine(lines[j]) && dataRows.length > 0) break;
      dataRows.push(rowTokens);
      j++;
      // Tabel Vital Sign/Assessment di dokumen ini maksimal beberapa baris —
      // batasi supaya tidak "menelan" paragraf naratif setelahnya sebagai baris tabel.
      if (dataRows.length >= 5) break;
    }

    if (dataRows.length === 0) continue;

    result.header = headerTokens;
    result.rows = dataRows.map(tokens => {
      const row = {};
      const n = Math.max(headerTokens.length, tokens.length);
      for (let k = 0; k < n; k++) {
        row[`col${k + 1}`] = tokens[k] !== undefined ? tokens[k] : null;
      }
      return row;
    });
    break;
  }

  return result;
}

/**
 * Pattern label->value untuk tiap kolom Vital Sign — dicoba DULUAN karena
 * lebih akurat daripada parsing posisional tabel (tidak tergantung urutan
 * kolom OCR yang kadang berantakan).
 */
const VITAL_SIGN_FIELD_PATTERNS = {
  Weight: [/\bBB\s*[:=]?\s*(\d{1,3}(?:[.,]\d)?)\s*kg/i],
  Height: [/\bTB\s*[:=]?\s*(\d{2,3})\s*cm/i],
  BloodPressure: [
    /\bTD\s*[:=]?\s*(\d{2,3})\s*[\/\-]\s*(\d{2,3})/i,
    /\bTensi\s*[:=]?\s*(\d{2,3})\s*[\/\-]\s*(\d{2,3})/i,
  ],
  HeartRate: [/\b(?:Heart\s*Rate|HR|Nadi)\s*[:=]?\s*(\d{2,3})\s*x/i],
  RespiratoryRate: [/\bRR\s*[:=]?\s*(\d{1,2})\s*x/i],
  Temperature: [/\bTemp(?:erature)?\s*[:=]?\s*([\d.,]{2,4})\s*°?\s*C/i],
  SpO2: [/\bSpO2\s*[:=]?\s*(\d{1,3})\s*%?/i],
};

// Header alias yang mungkin muncul di baris header tabel (nama kolom "as
// printed" di formulir Triage IGD RS ini — lihat catatan VITAL SIGN di
// aiReviewService.js) — dipetakan ke field Vital Sign standar.
const VITAL_SIGN_HEADER_ALIASES = [
  { field: 'Weight', re: /^bb$/i },
  { field: 'Height', re: /^tb$/i },
  { field: 'BloodPressure', re: /^(td|tensi)$/i },
  { field: 'HeartRate', re: /heart\s*rate|^hr$|nadi/i },
  { field: 'RespiratoryRate', re: /^rr$/i },
  { field: 'Temperature', re: /^temp/i },
  { field: 'SpO2', re: /^spo2$/i },
];

/**
 * Ekstrak tabel Vital Sign (BB, TB, TD, Heart Rate, RR, Temp, SpO2) dari
 * halaman Triage IGD. Strategi 2 lapis:
 *  1. Label eksplisit "Label: nilai" (paling akurat, urutan tidak penting).
 *  2. Fallback tabel posisional (header pendek + 1 baris nilai angka murni)
 *     kalau label eksplisit tidak ketemu untuk field tertentu.
 *
 * @param {string} text - teks halaman (idealnya mengandung heading "VITAL SIGN")
 * @returns {Object} map field -> {value, raw_match, source}
 */
function parseVitalSignsTable(text) {
  const result = {};
  if (!text || typeof text !== 'string') return result;

  // Fokus ke sekitar heading "VITAL SIGN" kalau ada, supaya tidak salah
  // tangkap angka dari bagian dokumen lain yang tidak terkait (mis. tarif).
  // SENGAJA ambil teks SETELAH baris heading-nya (bukan termasuk headingnya
  // sendiri) — kalau heading ikut masuk scope, parseTable() posisional di
  // bawah bisa keliru menganggap "VITAL SIGN" sendiri sebagai baris header
  // tabel (2 token pendek), padahal header tabel sesungguhnya (BB/TB/TD/dst)
  // ada di baris berikutnya.
  const sectionMatch = text.match(/VITAL\s+SIGN[S]?\s*:?\s*\n?([\s\S]{0,500})/i);
  const scope = sectionMatch ? sectionMatch[1] : text;

  for (const [field, patterns] of Object.entries(VITAL_SIGN_FIELD_PATTERNS)) {
    for (const pattern of patterns) {
      const match = scope.match(pattern);
      if (match) {
        result[field] = field === 'BloodPressure'
          ? { value: `${match[1]}/${match[2]}`, raw_match: match[0], source: 'label' }
          : { value: match[1], raw_match: match[0], source: 'label' };
        break;
      }
    }
  }

  // Fallback posisional: field yang belum ketemu lewat label, coba tabel generik.
  const missing = Object.keys(VITAL_SIGN_FIELD_PATTERNS).some(f => !result[f]);
  if (missing) {
    const table = parseTable(scope);
    if (table.header.length > 0 && table.rows.length > 0) {
      const row = table.rows[0];
      table.header.forEach((headerLabel, idx) => {
        const alias = VITAL_SIGN_HEADER_ALIASES.find(a => a.re.test(headerLabel));
        if (!alias || result[alias.field]) return;
        const raw = row[`col${idx + 1}`];
        if (!raw) return;
        // BloodPressure butuh "/" (format "120/80"), field lain HANYA angka
        // murni — "88 x/mnt" harus jadi "88", bukan "88/" (sisa slash dari unit "x/mnt").
        const allowedChars = alias.field === 'BloodPressure' ? /[^\d.,\/]/g : /[^\d.,]/g;
        const numeric = raw.replace(allowedChars, '');
        if (!numeric) return;
        result[alias.field] = { value: numeric, raw_match: raw, source: 'table' };
      });
    }
  }

  return result;
}

/**
 * Ekstrak box "Pengkajian Keperawatan" (Triage IGD): keluhan, riwayat
 * penyakit, skala nyeri, skor ESI. Di-scope ke area sekitar heading supaya
 * tidak menangkap teks dari section lain yang kebetulan pakai kata serupa.
 *
 * @param {string} text - teks halaman
 * @returns {{keluhan?: string, riwayat_penyakit?: string, skala_nyeri?: string, skor_esi?: string}}
 */
function parsePengkajianKeperawatanBox(text) {
  const result = {};
  if (!text || typeof text !== 'string') return result;

  const boxMatch = text.match(
    /PENGKAJIAN\s+KEPERAWATAN[\s\S]{0,1500}?(?=PRIMARY\s+SURVEY|PSIKOSOSIAL|DIAGNOSIS\s+KEPERAWATAN|VITAL\s+SIGN|KESADARAN|$)/i
  );
  const scope = boxMatch ? boxMatch[0] : text;

  const fieldPatterns = {
    keluhan: /Keluhan(?:\s+Utama)?\s*:?\s*([\s\S]*?)(?=Riwayat\s+Penyakit|Riwayat\s+Alergi|Skala\s+Nyeri|(?:Skor\s+)?ESI\s*:|$)/i,
    riwayat_penyakit: /Riwayat\s+Penyakit(?:\s+Sekarang)?\s*:?\s*([\s\S]*?)(?=Riwayat\s+Alergi|Skala\s+Nyeri|(?:Skor\s+)?ESI\s*:|Keluhan|$)/i,
    skala_nyeri: /Skala\s+Nyeri\s*:?\s*(\d{1,2})/i,
    skor_esi: /(?:Skor\s+)?ESI\s*:?\s*([1-5])\b/i,
  };

  for (const [key, pattern] of Object.entries(fieldPatterns)) {
    const match = scope.match(pattern);
    if (match && match[1] !== undefined && match[1].trim() && match[1].trim() !== '-') {
      result[key] = match[1].trim().replace(/\s*\n\s*/g, ' ');
    }
  }

  return result;
}

/**
 * Ekstrak section Assessment/Lembar Lain: Psikososial/Spiritual, Diagnosis
 * Keperawatan, Pengkajian Fungsional.
 *
 * @param {string} text - teks halaman
 * @returns {{psikososial_spiritual?: string, diagnosis_keperawatan?: string, pengkajian_fungsional?: string}}
 */
function parseAssessmentSection(text) {
  const result = {};
  if (!text || typeof text !== 'string') return result;

  const fieldPatterns = {
    psikososial_spiritual: /PSIKOSOSIAL\s*\/?\s*SPIRITUAL\s*:?\s*([\s\S]*?)(?=DIAGNOSIS\s+KEPERAWATAN|PENGKAJIAN\s+FUNGSIONAL|RENCANA|INTERVENSI|$)/i,
    diagnosis_keperawatan: /DIAGNOSIS\s+KEPERAWATAN\s*:?\s*([\s\S]*?)(?=PENGKAJIAN\s+FUNGSIONAL|PSIKOSOSIAL|RENCANA|INTERVENSI|$)/i,
    pengkajian_fungsional: /PENGKAJIAN\s+FUNGSIONAL\s*:?\s*([\s\S]*?)(?=DIAGNOSIS\s+KEPERAWATAN|PSIKOSOSIAL|RENCANA|INTERVENSI|$)/i,
  };

  for (const [key, pattern] of Object.entries(fieldPatterns)) {
    const match = text.match(pattern);
    if (match && match[1] !== undefined && match[1].trim() && match[1].trim() !== '-') {
      result[key] = match[1].trim().replace(/\s*\n\s*/g, ' ');
    }
  }

  return result;
}

module.exports = {
  parseTable,
  parseVitalSignsTable,
  parsePengkajianKeperawatanBox,
  parseAssessmentSection,
  // Diekspor untuk unit test granular
  splitRowTokens,
  looksLikeHeaderLine,
};
