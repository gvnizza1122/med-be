/**
 * Parser notasi medis untuk menerjemahkan temuan pemeriksaan fisik klinis.
 *
 * Notasi yang didukung:
 * - + : ada/positif
 * - − : tidak ada/negatif
 * - +/+ : bilateral positif (kanan positif, kiri positif)
 * - −/− : bilateral negatif (kanan negatif, kiri negatif)
 * - +/− : kanan positif, kiri negatif
 * - −/+ : kanan negatif, kiri positif
 */

const singkatanMedisData = require('../data/singkatan_medis.json');

/**
 * Dictionary singkatan klinis (case-insensitive lookup)
 */
const singkatanDict = new Map();
Object.entries(singkatanMedisData.singkatan || {}).forEach(([key, value]) => {
  singkatanDict.set(key.toUpperCase(), value);
});

/**
 * Parse notasi bilateral (kanan/kiri).
 * Format: +/+, −/−, +/−, −/+, atau notasi tunggal +/−
 *
 * @param {string} notasi - notasi bilateral (contoh: "+/+", "−/−", "+/−", "−/+")
 * @returns {{ada: boolean, sisi: string}} | null
 *   - ada: true jika ada minimal satu sisi positif
 *   - sisi: 'bilateral', 'kanan', 'kiri', atau 'negatif'
 *   - null jika notasi tidak valid
 */
function parseBilateralNotation(notasi) {
  if (!notasi || typeof notasi !== 'string') return null;

  const normalized = notasi.trim();

  // Pattern: notasi/notasi (bilateral)
  // Gunakan unicode escape karena − (minus/en-dash) berbeda dengan - (hyphen)
  const bilateralPattern = /^([\+\−\-])\s*\/\s*([\+\−\-])$/;
  const match = normalized.match(bilateralPattern);

  if (match) {
    const [, right, left] = match;
    const rightPositive = right === '+';
    const leftPositive = left === '+';

    // Tentukan sisi dan status ada/tidak
    if (rightPositive && leftPositive) {
      return { ada: true, sisi: 'bilateral', kanan: true, kiri: true };
    } else if (!rightPositive && !leftPositive) {
      return { ada: false, sisi: 'negatif', kanan: false, kiri: false };
    } else if (rightPositive && !leftPositive) {
      return { ada: true, sisi: 'kanan', kanan: true, kiri: false };
    } else if (!rightPositive && leftPositive) {
      return { ada: true, sisi: 'kiri', kanan: false, kiri: true };
    }
  }

  return null;
}

/**
 * Parse notasi tunggal (+ atau −).
 *
 * @param {string} notasi - notasi tunggal ('+' atau '−')
 * @returns {{ada: boolean}} | null
 */
function parseSingleNotation(notasi) {
  if (!notasi || typeof notasi !== 'string') return null;

  const normalized = notasi.trim();

  if (normalized === '+') {
    return { ada: true };
  } else if (normalized === '−' || normalized === '-') {
    return { ada: false };
  }

  return null;
}

/**
 * Parse temuan pemeriksaan fisik dalam format: "temuan +/+ beban gerbang −/−"
 *
 * Contoh input:
 *   "ronchi +/+ whezing +/+"
 *   "murmur +/− edema bilateral −"
 *   "hepatomegali + splenomegali −"
 *
 * @param {string} text - teks temuan pemeriksaan fisik
 * @returns {Object} - temuan terstruktur dengan format:
 *   {
 *     temuan_name: {
 *       ada: boolean,
 *       sisi: 'bilateral'|'kanan'|'kiri'|'negatif'|null,
 *       kanan: boolean|null,
 *       kiri: boolean|null,
 *       notasi_asli: string
 *     },
 *     ...
 *   }
 */
function parsePhysicalExam(text) {
  const result = {};

  if (!text || typeof text !== 'string') {
    return result;
  }

  // Split text by line dan kerjakan setiap baris
  const lines = text.split(/\n|;|,/).filter(line => line.trim());

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Deteksi pattern: temuan [notasi] [notasi] ...
    // Notasi bisa +, −, +/+, −/−, +/−, −/+ atau kombinasi

    // Pattern untuk bilateral notation (+/+, −/−, +/−, −/+)
    const bilateralPattern = /([\+\−\-])\s*\/\s*([\+\−\-])/;
    const singlePattern = /[\+\−\-]/;

    // Coba find all notations dalam line
    const notasiMatches = [];
    let searchStr = trimmed;
    let offset = 0;

    // Ekstrak semua notasi (bilateral atau single) dan posisinya
    const allMatches = [];
    for (let i = 0; i < searchStr.length; i++) {
      if (i < searchStr.length - 2 && searchStr[i + 1] === '/') {
        // Cek bilateral notation
        const bilateral = searchStr.slice(i, i + 3);
        if (/^[\+\−\-]\/[\+\−\-]$/.test(bilateral)) {
          allMatches.push({ pos: i, notation: bilateral, type: 'bilateral' });
          i += 2; // Skip the next chars
        }
      } else if (searchStr[i] === '+' || searchStr[i] === '−' || (searchStr[i] === '-' && i + 1 < searchStr.length && !/[\d]/.test(searchStr[i + 1]))) {
        // Single notation (jaga-jaga minus tidak jadi part dari nomor)
        allMatches.push({ pos: i, notation: searchStr[i], type: 'single' });
      }
    }

    // Parse temuan berdasarkan notasi yang ditemukan
    allMatches.forEach((match, idx) => {
      // Ekstrak temuan (text sebelum notasi ini)
      let temuanText = '';

      if (idx === 0) {
        // Temuan sebelum notasi pertama
        temuanText = trimmed.slice(0, match.pos).trim();
      } else {
        // Temuan antara notasi sebelumnya dan notasi sekarang
        const prevNotation = allMatches[idx - 1];
        const startPos = prevNotation.pos + prevNotation.notation.length;
        temuanText = trimmed.slice(startPos, match.pos).trim();
      }

      // Bersihkan notasi dari temuan (jangan ada + atau −)
      temuanText = temuanText.replace(/[\+\−\-]+$/, '').trim();

      if (!temuanText) {
        // Coba ekstrak temuan dari line secara keseluruhan (jika ada multiple notations)
        if (idx === 0 && allMatches.length > 0) {
          temuanText = trimmed.replace(/[\+\−\-].*$/g, '').trim();
        }
      }

      // Skip jika temuan kosong
      if (!temuanText || temuanText.length < 2) {
        return;
      }

      // Normalisasi nama temuan (lowercase, trim)
      const temuan = temuanText.toLowerCase().trim();

      // Translate singkatan jika ada
      const temuanTranslated = translateAbbreviation(temuan);

      // Parse notasi
      let parsed = null;
      if (match.type === 'bilateral') {
        parsed = parseBilateralNotation(match.notation);
      } else {
        parsed = parseSingleNotation(match.notation);
      }

      if (parsed) {
        result[temuan] = {
          ...parsed,
          notasi_asli: match.notation,
          translasi: temuanTranslated !== temuan ? temuanTranslated : undefined
        };
      }
    });

    // Fallback: jika tidak ada notasi ditemukan dalam line, coba ekstrak temuan saja
    if (allMatches.length === 0 && trimmed.length > 0) {
      const temuan = trimmed.toLowerCase().trim();
      const temuanTranslated = translateAbbreviation(temuan);

      if (temuan && temuan.length > 1) {
        result[temuan] = {
          ada: null, // Status tidak jelas tanpa notasi
          sisi: null,
          notasi_asli: null,
          translasi: temuanTranslated !== temuan ? temuanTranslated : undefined
        };
      }
    }
  });

  return result;
}

/**
 * Terjemahkan singkatan medis ke bentuk lengkap.
 *
 * @param {string} text - teks yang mungkin mengandung singkatan
 * @returns {string} - teks yang sudah diterjemahkan
 */
function translateAbbreviation(text) {
  if (!text) return text;

  const upper = text.toUpperCase().trim();

  // Exact match
  if (singkatanDict.has(upper)) {
    return singkatanDict.get(upper);
  }

  // Partial match (untuk kombinasi seperti "ronchi bilateral")
  let result = text;
  for (const [key, value] of singkatanDict.entries()) {
    const regex = new RegExp(`\\b${key}\\b`, 'gi');
    result = result.replace(regex, value);
  }

  return result;
}

/**
 * Translate teks klinis (ganti singkatan dengan bentuk lengkap).
 *
 * @param {string} text - teks klinis
 * @returns {string} - teks yang sudah diterjemahkan
 */
function translateClinicalText(text) {
  if (!text || typeof text !== 'string') return text;

  let result = text;

  // Replace singkatan secara case-insensitive
  for (const [key, value] of singkatanDict.entries()) {
    const regex = new RegExp(`\\b${key}\\b`, 'gi');
    result = result.replace(regex, value);
  }

  return result;
}

/**
 * Parse temuan pemeriksaan fisik dan kembalikan dalam format JSON terstruktur.
 * Wrapper utama untuk API eksternal.
 *
 * @param {string} text - teks pemeriksaan fisik
 * @returns {Object} struktur hasil parsing
 */
function parsePhysicalExamStructured(text) {
  const findings = parsePhysicalExam(text);

  return {
    success: Object.keys(findings).length > 0,
    findings: findings,
    raw_input: text,
    parsed_at: new Date().toISOString()
  };
}

module.exports = {
  parsePhysicalExam,
  parsePhysicalExamStructured,
  parseBilateralNotation,
  parseSingleNotation,
  translateAbbreviation,
  translateClinicalText,
  getSingkatanDict: () => Object.fromEntries(singkatanDict)
};
