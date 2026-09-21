/**
 * INA-CBG Grouping & Simulation Service
 * Based on PMK No. 3 Tahun 2023 (Regional 1, Kelas D, Swasta - RS Lestari Raharja)
 */

const { getTarifResmi, validateTarifDiscrepancy } = require('./tarifInacbgLookup');
const { detectSpecialCmg, calculateTotalTopup } = require('./specialCmgService');

/**
 * Memetakan kode diagnosis dan prosedur ke INA-CBG berdasarkan diagnosis utama.
 * Fungsi ini menggunakan diagnosis utama (primary diagnosis) untuk menentukan
 * kategori INA-CBG yang paling sesuai.
 *
 * PENTING: Ini adalah heuristik prefix-matching sederhana yang men-generate
 * BENTUK kode INA-CBG yang terlihat plausible (mis. 'J-4-15-II') sebagai
 * fallback, dipakai HANYA kalau grouping resmi Permenkes tidak tersedia.
 * Fungsi ini BUKAN grouper INA-CBG resmi/tersertifikasi Permenkes -- ia
 * tidak menjamin kode yang dihasilkan benar-benar ada/valid di tabel tarif
 * PMK No. 3 Tahun 2023 (lihat tarifInacbgLookup.js untuk data resmi).
 * Fungsi ini sebaiknya HANYA dipakai kalau saran AI (suggested_inacbg) tidak
 * tersedia atau terbukti tidak valid (tidak ada di tabel Permenkes) --
 * lihat validasi di aiReviewService.js.
 *
 * @param {Array<string>} diagnosisCodes - Array kode diagnosis ICD-10 (prioritas: urutan pertama adalah primary)
 * @param {Array<string>} procedureCodes - Array kode prosedur ICD-9-CM (opsional, untuk konteks)
 * @param {string} jenisKlaim - Jenis klaim: 'RAWAT_INAP', 'RAWAT_JALAN'
 * @returns {Object|null} {code, confidence, reasoning} atau null jika tidak bisa memetakan
 */
function groupCodesToInaCBG(diagnosisCodes, procedureCodes = [], jenisKlaim = 'RAWAT_INAP') {
  if (!Array.isArray(diagnosisCodes) || diagnosisCodes.length === 0) {
    return null;
  }

  // Ambil diagnosis utama (kode pertama dari DIAGLIST)
  const primaryDiagnosis = diagnosisCodes[0]?.trim().toUpperCase();
  if (!primaryDiagnosis) return null;

  // Mapping sederhana dari prefiks ICD-10 ke kategori INA-CBG
  // Ini adalah heuristik dasar -- implementasi produksi bisa lebih sophisticated
  let suggestedCategory = null;
  let confidence = 0.5; // confidence default untuk mapping

  // Pemetaan berdasarkan prefiks dan struktur kode ICD-10
  const prefix = primaryDiagnosis.substring(0, 1);
  const codeNum = primaryDiagnosis.substring(1, 2);

  // Mapping kategori INA-CBG berdasarkan diagnosis
  // Format: [Letter]-[Block]-[Category]-[Severity]
  // Contoh: J (Respiratory) -> J-4-15 (Lower Respiratory Infection), I/II/III (severity)

  switch (prefix) {
    case 'J': // Respiratory diseases
      if (primaryDiagnosis.includes('18') || primaryDiagnosis.includes('15')) {
        // Pneumonia / Lower respiratory infection
        suggestedCategory = 'J-4-15'; // akan ditambah severity di bawah
        confidence = 0.7;
      } else if (primaryDiagnosis.includes('45') || primaryDiagnosis.includes('46')) {
        // Asthma
        suggestedCategory = 'J-4-16';
        confidence = 0.7;
      } else {
        // Fallback untuk penyakit respirasi lainnya
        suggestedCategory = 'J-4-18';
        confidence = 0.5;
      }
      break;

    case 'I': // Cardiovascular diseases
      if (primaryDiagnosis.includes('10') || primaryDiagnosis.includes('11')) {
        // Hypertension
        suggestedCategory = 'I-4-10';
        confidence = 0.7;
      } else if (primaryDiagnosis.includes('21') || primaryDiagnosis.includes('20')) {
        // Heart failure
        suggestedCategory = 'I-4-11';
        confidence = 0.65;
      } else {
        // Fallback untuk penyakit kardiovaskular lainnya
        suggestedCategory = 'I-4-12';
        confidence = 0.5;
      }
      break;

    case 'K': // Digestive diseases
      if (primaryDiagnosis.includes('59')) {
        // Gastroenteritis
        suggestedCategory = 'K-4-17';
        confidence = 0.7;
      } else {
        // Fallback untuk penyakit digestif lainnya
        suggestedCategory = 'K-4-18';
        confidence = 0.5;
      }
      break;

    case 'A': // Certain infectious and parasitic diseases
      if (primaryDiagnosis.includes('01') || primaryDiagnosis.includes('15')) {
        // Bacterial/viral infections
        suggestedCategory = 'A-4-14';
        confidence = 0.6;
      } else {
        // Fallback untuk infeksi lainnya
        suggestedCategory = 'A-4-15';
        confidence = 0.5;
      }
      break;

    case 'E': // Endocrine diseases
      if (primaryDiagnosis.includes('10') || primaryDiagnosis.includes('11')) {
        // Diabetes mellitus
        suggestedCategory = 'E-4-10';
        confidence = 0.7;
      } else {
        // Fallback untuk penyakit endokrin lainnya
        suggestedCategory = 'E-4-11';
        confidence = 0.5;
      }
      break;

    case 'M': // Musculoskeletal diseases
      suggestedCategory = 'M-4-13';
      confidence = 0.5;
      break;

    case 'N': // Genitourinary diseases
      suggestedCategory = 'N-4-14';
      confidence = 0.5;
      break;

    case 'O': // Pregnancy, childbirth, postpartum (Obstetri)
      suggestedCategory = 'O-4-15';
      confidence = 0.6;
      break;

    case 'P': // Perinatal conditions
      suggestedCategory = 'P-4-16';
      confidence = 0.5;
      break;

    case 'Q': // Congenital anomalies
      suggestedCategory = 'Q-4-17';
      confidence = 0.5;
      break;

    case 'R': // Symptoms, signs, abnormal findings
      suggestedCategory = 'R-4-18';
      confidence = 0.4;
      break;

    case 'B': // Parasitic diseases
      suggestedCategory = 'B-4-14';
      confidence = 0.5;
      break;

    case 'C': // Malignant neoplasms
      suggestedCategory = 'C-4-19';
      confidence = 0.6;
      break;

    case 'D': // In-situ, benign neoplasms
      suggestedCategory = 'D-4-20';
      confidence = 0.5;
      break;

    case 'F': // Mental, behavioral disorders
      suggestedCategory = 'F-4-11';
      confidence = 0.5;
      break;

    case 'G': // Nervous system diseases
      suggestedCategory = 'G-4-12';
      confidence = 0.5;
      break;

    case 'H': // Eye, ear diseases
      suggestedCategory = 'H-4-13';
      confidence = 0.5;
      break;

    case 'L': // Skin, subcutaneous tissue diseases
      suggestedCategory = 'L-4-14';
      confidence = 0.5;
      break;

    case 'T': // Injury, poisoning, consequences
      suggestedCategory = 'T-4-19';
      confidence = 0.5;
      break;

    case 'V': // External causes (factors)
    case 'W':
    case 'X':
    case 'Y':
      suggestedCategory = 'T-4-19'; // Grouped with injury/poisoning
      confidence = 0.4;
      break;

    case 'U': // External causes of morbidity (unspecified)
      suggestedCategory = 'U-4-20';
      confidence = 0.4;
      break;

    case 'Z': // Factors influencing health status
      suggestedCategory = 'Z-4-21';
      confidence = 0.3;
      break;

    default:
      // Truly unknown prefix
      return null;
  }

  if (!suggestedCategory) {
    // Fallback: tidak bisa pemetakan, tapi jangan gagal total
    return null;
  }

  // Tentukan severity berdasarkan ada/tidaknya komplikasi atau prosedur
  let severity = 'I'; // default: ringan/mild

  if (procedureCodes.length > 0) {
    // Jika ada prosedur kompleks, asumsikan kasus lebih berat
    const complexProcedures = procedureCodes.filter(p => {
      const code = p?.trim().toUpperCase();
      // Prosedur kompleks biasanya > 1 tindakan atau tindakan invasif
      return code && (code.includes('87') || code.includes('89') || code.includes('93') || code.includes('96'));
    });
    if (complexProcedures.length > 0) {
      severity = 'II'; // sedang
      confidence += 0.1;
    }
  }

  // Jika diagnosis lebih dari 1 (ada komorbiditas), tingkatkan severity
  if (diagnosisCodes.length > 1) {
    if (severity === 'I') {
      severity = 'II';
    } else if (severity === 'II') {
      severity = 'III';
    }
    confidence += 0.05;
  }

  const finalCode = `${suggestedCategory}-${severity}`;

  return {
    code: finalCode,
    confidence: Math.min(confidence, 1.0),
    reasoning: `Pemetaan dari diagnosis utama ${primaryDiagnosis} dengan ${diagnosisCodes.length} diagnosis total, ${procedureCodes.length} prosedur. Severity: ${severity}.`,
  };
}

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
  simulateGroupingComparison,
  groupCodesToInaCBG
};
