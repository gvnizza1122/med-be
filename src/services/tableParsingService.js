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
// Pemisah antara nama field dan nilainya: spasi MENDATAR saja, tidak pernah
// ganti baris. Di formulir Triage IGD format baru, nama kolom berjejer di
// satu baris ("VITAL SIGN BB TB TD Heart Rate RR Temp SpO2") dan nilainya di
// baris berikutnya. Kalau pemisahnya membolehkan ganti baris, kata "SpO2" di
// ujung baris header menyambar angka PERTAMA baris nilai di bawahnya --
// terbukti pada berkas MUNAWIR: SpO2 terbaca 141, padahal 141 itu tekanan
// darah sistolik dan SpO2 sebenarnya 88%. Saturasi kritis jadi tampak normal,
// justru kebalikan dari tujuan pembacaan ini.
// [^\S\r\n] = spasi mendatar saja. Dipakai sebagai ganti \s di antara nama
// field dan nilainya.
const VITAL_SIGN_FIELD_PATTERNS = {
  Weight: [/\bBB[^\S\r\n]*[:=]?[^\S\r\n]*(\d{1,3}(?:[.,]\d)?)\s*kg/i],
  Height: [/\bTB[^\S\r\n]*[:=]?[^\S\r\n]*(\d{2,3})\s*cm/i],
  BloodPressure: [
    /\bTD[^\S\r\n]*[:=]?[^\S\r\n]*(\d{2,3})\s*[/-]\s*(\d{2,3})/i,
    /\bTensi[^\S\r\n]*[:=]?[^\S\r\n]*(\d{2,3})\s*[/-]\s*(\d{2,3})/i,
  ],
  HeartRate: [/\b(?:Heart\s*Rate|HR|Nadi)[^\S\r\n]*[:=]?[^\S\r\n]*(\d{2,3})\s*x/i],
  RespiratoryRate: [/\bRR[^\S\r\n]*[:=]?[^\S\r\n]*(\d{1,2})\s*x/i],
  Temperature: [/\bTemp(?:erature)?[^\S\r\n]*[:=]?[^\S\r\n]*([\d.,]{2,4})\s*°?\s*C/i],
  // Tanda % WAJIB di jalur label ini. Tanpa itu, "SpO2" apa pun yang diikuti
  // angka akan diterima — termasuk nama kolom yang diikuti nilai kolom lain.
  // Tabel tanpa tanda % tetap terbaca lewat jalur posisional di bawah, yang
  // mencocokkan kolom menurut urutannya.
  SpO2: [/\bSpO2[^\S\r\n]*[:=]?[^\S\r\n]*(\d{1,3})\s*%/i],
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
 * Baca baris nilai tabel Vital Sign menurut SATUAN yang tercetak, bukan
 * menurut posisi kolom.
 *
 * Pemetaan posisional tidak bisa dipakai di formulir ini. Headernya punya 7
 * kolom ("BB TB TD Heart Rate RR Temp SpO2") tapi baris nilainya sering hanya
 * berisi 5 — BB dan TB kerap dikosongkan — sehingga kolom ke-n tidak berpadanan
 * dengan nilai ke-n. Contoh nyata dari berkas MUNAWIR:
 *
 *   VITAL SIGN BB TB TD Heart Rate RR Temp SpO2
 *   141/86 mmHg 71 x/mnt 20 x/mnt 36.9oC 88%
 *
 * Satuannya justru tidak ambigu: mmHg untuk tekanan darah, % untuk saturasi,
 * C untuk suhu. Yang bertumpang tindih hanya nadi dan laju napas — keduanya
 * "x/mnt" — dan itu dipisahkan menurut urutan kemunculan, mengikuti urutan
 * kolomnya di header.
 *
 * @returns {Object} map field -> {value, raw_match, source}
 */
function bacaVitalMenurutSatuan(barisNilai) {
  const hasil = {};
  if (!barisNilai) return hasil;

  // "mmHg" opsional: formulir format lama menulis tekanan darah tanpa satuan
  // ("141/86 71 Kali 20 Kali 36.9oC"). Aman di sini karena fungsi ini hanya
  // dipanggil untuk baris tepat di bawah header Vital Sign — di luar konteks
  // itu, pola dua angka berpisah garis miring terlalu longgar.
  const td = barisNilai.match(/(\d{2,3})\s*\/\s*(\d{2,3})(?:\s*mmHg)?/i);
  if (td) hasil.BloodPressure = { value: `${td[1]}/${td[2]}`, raw_match: td[0], source: 'satuan' };

  const spo2 = barisNilai.match(/(\d{1,3})\s*%/);
  if (spo2) hasil.SpO2 = { value: spo2[1], raw_match: spo2[0], source: 'satuan' };

  // "36.9oC" — huruf o di berkas ini menggantikan lambang derajat.
  const suhu = barisNilai.match(/([\d]{2}(?:[.,]\d)?)\s*[o°]?\s*C\b/i);
  if (suhu) hasil.Temperature = { value: suhu[1], raw_match: suhu[0], source: 'satuan' };

  const bb = barisNilai.match(/(\d{1,3}(?:[.,]\d)?)\s*kg/i);
  if (bb) hasil.Weight = { value: bb[1], raw_match: bb[0], source: 'satuan' };

  const tb = barisNilai.match(/(\d{2,3})\s*cm/i);
  if (tb) hasil.Height = { value: tb[1], raw_match: tb[0], source: 'satuan' };

  // Nadi dan laju napas sama-sama "x/mnt". Urutan kemunculan dipakai karena di
  // header Heart Rate selalu mendahului RR; kalau hanya ada satu nilai, ia
  // TIDAK ditebak ke salah satunya — menebak di sini berarti mengarang angka
  // nadi atau laju napas yang tidak pernah tertulis.
  // "x/mnt" pada formulir format baru, "Kali" pada format lama.
  const xmnt = [...barisNilai.matchAll(/(\d{1,3})\s*(?:x\s*\/\s*m(?:e?nit|nt)|kali)/gi)];
  if (xmnt.length >= 2) {
    hasil.HeartRate = { value: xmnt[0][1], raw_match: xmnt[0][0], source: 'satuan' };
    hasil.RespiratoryRate = { value: xmnt[1][1], raw_match: xmnt[1][0], source: 'satuan' };
  }

  return hasil;
}

/** Baris yang memuat setidaknya tiga nama kolom vital yang dikenal. */
function barisHeaderVital(baris) {
  const nama = [/\bBB\b/i, /\bTB\b/i, /\bTD\b/i, /heart\s*rate/i, /\bRR\b/i, /\btemp/i, /\bspo2\b/i];
  return nama.filter(re => re.test(baris)).length >= 3;
}

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

  // Cadangan menurut satuan — dipakai untuk formulir Triage IGD format baru,
  // yang menaruh nama kolom di satu baris dan nilainya di baris berikutnya.
  // Dicoba SEBELUM jalur posisional karena di formulir itu kolom kosong
  // membuat urutan nilai tidak lagi berpadanan dengan urutan kolom.
  if (Object.keys(VITAL_SIGN_FIELD_PATTERNS).some(f => !result[f])) {
    const barisScope = scope.split(/\r?\n/);
    for (let i = 0; i < barisScope.length - 1; i++) {
      if (!barisHeaderVital(barisScope[i])) continue;
      const dariSatuan = bacaVitalMenurutSatuan(barisScope[i + 1]);
      for (const [field, nilai] of Object.entries(dariSatuan)) {
        if (!result[field]) result[field] = nilai;
      }
      break;
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

/**
 * Ekstrak vital signs dari Laporan Operasi: Time, Sistole, Diastole, Nadi,
 * Respirasi, Suhu, SpO2 (ketujuh field sesuai tugas).
 *
 * @param {string} text - teks halaman Laporan Operasi
 * @returns {{jam?: string, sistole?: string, diastole?: string, nadi?: string, respirasi?: string, suhu?: string, spo2?: string, raw_table?: Object}}
 */
function parseLaporanOperasiVitalSigns(text) {
  const result = {};
  if (!text || typeof text !== 'string') return result;

  // Fokus ke sekitar tabel vital signs di Laporan Operasi
  const sectionMatch = text.match(/(?:TABEL\s+VITAL\s+SIGN|VITAL\s+SIGN|VITAL\s+SIGNS?|MONITORING\s+TEKANAN\s+DARAH)[\s\S]{0,1000}?(?=ANESTETIK|OBAT|DIAGNOSIS|TINDAKAN|$)/i);
  const scope = sectionMatch ? sectionMatch[0] : text;

  // Ekstraksi tabel generik dari scope
  const table = parseTable(scope);
  if (table.header.length > 0 && table.rows.length > 0) {
    // Simpan tabel raw untuk audit
    result.raw_table = table;

    // Map header ke field nama standard (case-insensitive)
    const headerMap = {};
    table.header.forEach((h, idx) => {
      const lower = (h || '').toLowerCase();
      if (/^(jam|waktu|time)$/i.test(lower)) headerMap[idx] = 'jam';
      else if (/^sistole|^sys|^sbp/i.test(lower)) headerMap[idx] = 'sistole';
      else if (/^diastole|^dia|^dbp/i.test(lower)) headerMap[idx] = 'diastole';
      else if (/^nadi|^hr|^pulse|heart\s+rate/i.test(lower)) headerMap[idx] = 'nadi';
      else if (/^respirasi|^rr|^resp/i.test(lower)) headerMap[idx] = 'respirasi';
      else if (/^suhu|^temp|temperature/i.test(lower)) headerMap[idx] = 'suhu';
      else if (/^spo2|^o2\s*sat|oxygen\s+sat/i.test(lower)) headerMap[idx] = 'spo2';
    });

    // Ekstrak baris pertama (waktu operasi biasanya)
    if (table.rows.length > 0) {
      const row = table.rows[0];
      Object.entries(headerMap).forEach(([idx, field]) => {
        const val = row[`col${Number(idx) + 1}`];
        if (val && val.trim()) {
          result[field] = val.trim();
        }
      });
    }
  }

  return result;
}

/**
 * Ekstrak hasil laboratorium (Hematologi & Kimia) dari dokumen Hasil Pemeriksaan
 * Laboratorium. Struktur: HEMATOLOGI (WBC, RBC, Hemoglobin, Hematocrit, Platelet, dll)
 * dan KIMIA (Glucose, Creatinine, Bilirubin, Albumin, dll).
 *
 * @param {string} text - teks halaman Hasil Pemeriksaan Laboratorium
 * @returns {{hematologi?: Array<{test?: string, value?: string, unit?: string, flag?: string}>, kimia?: Array<{test?: string, value?: string, unit?: string, flag?: string}>}}
 */
function parseLabResults(text) {
  const result = { hematologi: [], kimia: [] };
  if (!text || typeof text !== 'string') return result;

  // Ekstraksi HEMATOLOGI
  const hematologyMatch = text.match(/HEMATOLOGI[\s\S]{0,800}?(?=KIMIA|ANALISA|SEROLOGY|$)/i);
  if (hematologyMatch) {
    const hematologyText = hematologyMatch[0];
    // Parse baris "NamaTest    Nilai    Unit    Flag" atau serupa
    const hematologyLines = hematologyText.split(/\n/).slice(1); // skip header "HEMATOLOGI"
    for (const line of hematologyLines) {
      if (!line.trim() || /^(HEMATOLOGI|KIMIA|ANALISA)/i.test(line)) break;
      const tokens = splitRowTokens(line);
      if (tokens.length >= 2) {
        result.hematologi.push({
          test: tokens[0] || null,
          value: tokens[1] || null,
          unit: tokens[2] || null,
          flag: tokens[3] || null
        });
      }
    }
  }

  // Ekstraksi KIMIA
  const chemistryMatch = text.match(/KIMIA|ANALISA\s+KIMIA[\s\S]{0,800}?(?=SEROLOGY|ANALISA|$)/i);
  if (chemistryMatch) {
    const chemistryText = chemistryMatch[0];
    // Parse baris serupa dengan HEMATOLOGI
    const chemistryLines = chemistryText.split(/\n/).slice(1); // skip header
    for (const line of chemistryLines) {
      if (!line.trim() || /^(HEMATOLOGI|KIMIA|SEROLOGY|ANALISA)/i.test(line)) break;
      const tokens = splitRowTokens(line);
      if (tokens.length >= 2) {
        result.kimia.push({
          test: tokens[0] || null,
          value: tokens[1] || null,
          unit: tokens[2] || null,
          flag: tokens[3] || null
        });
      }
    }
  }

  return result;
}

/**
 * Ekstrak temuan radiologi dari dokumen Hasil Pemeriksaan Radiologi
 *
 * @param {string} text - teks halaman radiologi
 * @returns {{diagnosis_radiologi?: string, findings?: string, impression?: string, technique?: string}}
 */
function parseRadiologyFindings(text) {
  const result = {};
  if (!text || typeof text !== 'string') return result;

  const patterns = {
    diagnosis_radiologi: /DIAGNOSIS\s+RADIOLOGI\s*:?\s*([\s\S]*?)(?=FINDINGS|IMPRESSION|TEKNIK|$)/i,
    findings: /FINDINGS?\s*:?\s*([\s\S]*?)(?=IMPRESSION|DIAGNOSIS|KESIMPULAN|REKOMENDASI|$)/i,
    impression: /IMPRESSION|KESIMPULAN\s*:?\s*([\s\S]*?)(?=REKOMENDASI|TEKNIK|FINDINGS|DIAGNOSIS|$)/i,
    technique: /TEKNIK|TECHNIQUE\s*:?\s*([\s\S]*?)(?=FINDINGS|IMPRESSION|DIAGNOSIS|$)/i,
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match && match[1] !== undefined && match[1].trim() && match[1].trim() !== '-') {
      result[key] = match[1].trim().replace(/\s*\n\s*/g, ' ').substring(0, 500);
    }
  }

  return result;
}

module.exports = {
  parseTable,
  parseVitalSignsTable,
  parsePengkajianKeperawatanBox,
  parseAssessmentSection,
  parseLaporanOperasiVitalSigns,
  parseLabResults,
  parseRadiologyFindings,
  // Diekspor untuk unit test granular
  splitRowTokens,
  looksLikeHeaderLine,
};
