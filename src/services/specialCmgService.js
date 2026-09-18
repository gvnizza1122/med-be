/**
 * Special CMG Detection & Top-Up Calculation Service
 * Based on PMK No. 3 Tahun 2023 (Regional 1, Kelas D, Swasta - RS Lestari Raharja)
 */

const SPECIAL_CMG_DATA = require('../data/special_cmg_pmk3_2023.json');

/**
 * Normalisasi string daftar kode (pemisah koma atau titik koma)
 * @param {string} codeString
 * @returns {Array<string>}
 */
function parseCodeList(codeString) {
  if (!codeString || typeof codeString !== 'string') return [];
  return codeString
    .split(/[;,]/)
    .map(c => c.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Cek apakah salah satu kode klaim mencakup prefix atau exact match dari kode pemicu
 * @param {Array<string>} claimCodes
 * @param {Array<string>} requiredCodes
 * @returns {boolean}
 */
function matchesCodes(claimCodes, requiredCodes) {
  if (!Array.isArray(requiredCodes) || requiredCodes.length === 0) return true;
  if (!Array.isArray(claimCodes) || claimCodes.length === 0) return false;

  return requiredCodes.some(req => {
    const reqUpper = req.trim().toUpperCase();
    return claimCodes.some(claimCode => {
      return claimCode === reqUpper || claimCode.startsWith(reqUpper);
    });
  });
}

/**
 * Mendeteksi Special CMG yang aktif untuk suatu record klaim
 * @param {Object} claimRecord
 * @returns {Array<Object>} daftar Special CMG yang lolos kriteria & aktif
 */
function detectSpecialCmg(claimRecord) {
  if (!claimRecord) return [];

  const diagCodes = parseCodeList(claimRecord.diagnosa_list || claimRecord.primary_diagnosis);
  const procCodes = parseCodeList(claimRecord.prosedur_list || claimRecord.procedure_codes);
  const jenisKlaim = (claimRecord.jenis_klaim || 'RAWAT_INAP').trim().toUpperCase();

  const activeTopups = [];

  for (const cmg of (SPECIAL_CMG_DATA.special_cmgs || [])) {
    // 1. Cek batasan jenis layanan (RAWAT_JALAN / RAWAT_INAP / ALL)
    if (cmg.allowed_service_type && cmg.allowed_service_type !== 'ALL') {
      if (cmg.allowed_service_type !== jenisKlaim) {
        continue;
      }
    }

    // 2. Cek kriteria pemicu prosedur
    if (cmg.required_procedure_codes && cmg.required_procedure_codes.length > 0) {
      if (!matchesCodes(procCodes, cmg.required_procedure_codes)) {
        continue;
      }
    }

    // 3. Cek kriteria pemicu diagnosis
    if (cmg.required_diagnosis_codes && cmg.required_diagnosis_codes.length > 0) {
      if (!matchesCodes(diagCodes, cmg.required_diagnosis_codes)) {
        continue;
      }
    }

    // Jika semua kriteria terpenuhi -> Special CMG aktif
    activeTopups.push({
      code: cmg.code,
      name: cmg.name,
      category: cmg.category,
      description: cmg.description,
      tarif_topup: Number(cmg.tarif_topup || 0)
    });
  }

  return activeTopups;
}

/**
 * Menghitung total nilai top-up dari Special CMG yang terdeteksi
 * @param {Array<Object>} activeTopups
 * @returns {number}
 */
function calculateTotalTopup(activeTopups) {
  if (!Array.isArray(activeTopups)) return 0;
  return activeTopups.reduce((sum, item) => sum + (Number(item.tarif_topup) || 0), 0);
}

module.exports = {
  detectSpecialCmg,
  calculateTotalTopup,
  SPECIAL_CMG_DATA
};
