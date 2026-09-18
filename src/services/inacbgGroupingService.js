/**
 * INA-CBG Grouping & Simulation Service
 * Based on PMK No. 3 Tahun 2023 (Regional 1, Kelas D, Swasta - RS Lestari Raharja)
 */

const { getTarifResmi, validateTarifDiscrepancy } = require('./tarifInacbgLookup');
const { detectSpecialCmg, calculateTotalTopup } = require('./specialCmgService');

/**
 * Membandingkan tarif klaim eksisting vs hasil kalkulasi grouping internal
 * (Base INA-CBG + Special CMG Top-Ups) tanpa mengubah record klaim asli.
 *
 * @param {Object} claimRecord - Data klaim yang diekstrak/di-input
 * @returns {Object} Hasil simulasi perbandingan grouping
 */
function simulateGroupingComparison(claimRecord) {
  if (!claimRecord) {
    return {
      status: 'INVALID_INPUT',
      error: 'Data record klaim kosong.'
    };
  }

  const kodeInacbg = (claimRecord.inacbg_code || '').trim().toUpperCase();
  const kelasRawat = claimRecord.kelas_rawat;
  const tarifKlaimEksisting = Number(claimRecord.tarif_inacbg) || 0;

  // 1. Lookup tarif dasar resmi PMK 3/2023
  const resmiInfo = getTarifResmi(kodeInacbg, kelasRawat);
  const tarifBaseResmi = resmiInfo && resmiInfo.tarif !== null ? Number(resmiInfo.tarif) : null;

  // 2. Deteksi Special CMG & Top-Up otomatis
  const activeSpecialCmgs = detectSpecialCmg(claimRecord);
  const totalTopup = calculateTotalTopup(activeSpecialCmgs);

  // 3. Kalkulasi total tarif grouping internal (Base + Special CMG Top-Up)
  const tarifInternalTotal = (tarifBaseResmi !== null ? tarifBaseResmi : 0) + totalTopup;

  // 4. Hitung selisih & match status
  const selisihBase = tarifBaseResmi !== null ? Math.abs(tarifKlaimEksisting - tarifBaseResmi) : null;
  const selisihTotal = Math.abs(tarifKlaimEksisting - tarifInternalTotal);
  const isMatch = tarifKlaimEksisting > 0 && selisihTotal === 0;

  // 5. Rekomendasi & Temuan
  const rekomendasi = [];
  if (!kodeInacbg) {
    rekomendasi.push('Kode INA-CBG belum diisi pada klaim.');
  } else if (!resmiInfo) {
    rekomendasi.push(`Kode INA-CBG ${kodeInacbg} tidak ditemukan pada tabel PMK 3/2023 Regional 1 Kelas D Swasta.`);
  } else if (resmiInfo.tarif === null) {
    rekomendasi.push(`Kode INA-CBG ${kodeInacbg} tidak memiliki tarif yang dijamin untuk kelas rawat ${kelasRawat}.`);
  } else if (selisihBase && selisihBase > 0) {
    rekomendasi.push(`Terdapat selisih tarif dasar sebesar Rp ${selisihBase.toLocaleString('id-ID')} antara tarif klaim vs tarif resmi PMK 3/2023.`);
  }

  if (activeSpecialCmgs.length > 0) {
    rekomendasi.push(`Terdeteksi ${activeSpecialCmgs.length} potensi Special CMG (Top-up Rp ${totalTopup.toLocaleString('id-ID')}).`);
  }

  return {
    kode_inacbg: kodeInacbg,
    kelas_rawat: kelasRawat,
    jenis_klaim: claimRecord.jenis_klaim || 'RAWAT_INAP',
    tarif_klaim_eksisting: tarifKlaimEksisting,
    tarif_base_resmi: tarifBaseResmi,
    special_cmg_active: activeSpecialCmgs,
    total_topup: totalTopup,
    tarif_internal_total: tarifInternalTotal,
    selisih_total: selisihTotal,
    status_match: isMatch,
    rekomendasi: rekomendasi
  };
}

module.exports = {
  simulateGroupingComparison
};
