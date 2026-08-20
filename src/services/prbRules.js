/**
 * Kategori diagnosis kronis Program Rujuk Balik (PRB) — sumber kebenaran tunggal
 * dipakai ruleEngine.js (RV-15) DAN claimFiles.js (detectAndFlagPRB, cross-record).
 * Daftar prefix ICD-10 sesuai BA Kesepakatan BPJS 1247/2024.
 */
const PRB_ICD10_CATEGORIES = {
  DM: ['E10', 'E11', 'E12', 'E13', 'E14'],
  Hipertensi: ['I10', 'I11', 'I12', 'I13', 'I14', 'I15'],
  Jantung: ['I20', 'I21', 'I22', 'I23', 'I24', 'I25', 'I50'],
  'PPOK/Asma': ['J40', 'J41', 'J42', 'J43', 'J44', 'J45', 'J46'],
  Epilepsi: ['G40', 'G41'],
  Skizofrenia: ['F20', 'F21', 'F22', 'F23', 'F24', 'F25'],
  SLE: ['M32'],
  Stroke: ['I60', 'I61', 'I62', 'I63', 'I64', 'I65', 'I66', 'I67', 'I68', 'I69'],
  CKD: ['N18'],
};

/**
 * Cocokkan diagnosa_list (string kode ICD-10 dipisah titik-koma) ke kategori PRB.
 * @returns {string|null} nama kategori pertama yang cocok, atau null.
 */
function matchPrbCategory(diagnosaListStr) {
  if (!diagnosaListStr || diagnosaListStr === '-') return null;
  const codes = String(diagnosaListStr).split(';').map(c => c.trim().toUpperCase()).filter(Boolean);
  for (const [category, prefixes] of Object.entries(PRB_ICD10_CATEGORIES)) {
    if (codes.some(code => prefixes.some(prefix => code.startsWith(prefix)))) {
      return category;
    }
  }
  return null;
}

module.exports = { PRB_ICD10_CATEGORIES, matchPrbCategory };
