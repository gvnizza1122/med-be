/**
 * Tariff Verification Service
 *
 * Service untuk verifikasi tarif klaim terhadap tabel resmi PMK 3/2023.
 * Digunakan oleh RV-21 validation rule dan API endpoints.
 */

const { getTarifResmi, validateTarifDiscrepancy, lookupTarifInacbg } = require('./tarifInacbgLookup');

/**
 * Verifikasi tarif untuk satu record klaim
 * @param {object} record - Record klaim dengan field: kodeInacbg, kelasRawat, tarifInacbg
 * @returns {object} Hasil verifikasi
 */
async function verifyRecordTarif(record) {
  if (!record.kode_inacbg || !record.kelas_rawat || !record.tarif_inacbg) {
    return {
      verified: false,
      reason: 'Missing required fields: kode_inacbg, kelas_rawat, tarif_inacbg'
    };
  }

  const result = validateTarifDiscrepancy(
    record.kode_inacbg,
    record.kelas_rawat,
    record.tarif_inacbg
  );

  return {
    verified: result.valid,
    status: result.status,
    tarifResmi: result.tarifResmi,
    tarifKlaim: result.tarifKlaim,
    selisih: result.selisih,
    persentaseSelisih: result.tarifResmi ?
      Math.round((result.selisih / result.tarifResmi) * 100 * 100) / 100 : 0,
    detail: result.detail
  };
}

/**
 * Verifikasi batch records
 * @param {array} records - Array of claim records
 * @returns {object} Hasil verifikasi batch
 */
async function verifyBatchTarif(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      total: 0,
      verified: [],
      failed: [],
      summary: {
        total_records: 0,
        valid: 0,
        invalid: 0,
        not_found: 0,
        not_applicable: 0
      }
    };
  }

  const verified = [];
  const failed = [];
  let validCount = 0;
  let invalidCount = 0;
  let notFoundCount = 0;
  let notApplicableCount = 0;

  for (const record of records) {
    const result = await verifyRecordTarif(record);

    if (result.status === 'KODE_TIDAK_DITEMUKAN') {
      notFoundCount++;
      failed.push({
        ...record,
        ...result,
        error_type: 'KODE_TIDAK_DITEMUKAN'
      });
    } else if (result.status === 'TARIF_TIDAK_BERLAKU') {
      notApplicableCount++;
      failed.push({
        ...record,
        ...result,
        error_type: 'TARIF_TIDAK_BERLAKU'
      });
    } else if (result.verified) {
      validCount++;
      verified.push({
        ...record,
        ...result
      });
    } else {
      invalidCount++;
      failed.push({
        ...record,
        ...result,
        error_type: 'DISCREPANCY'
      });
    }
  }

  return {
    total: records.length,
    verified,
    failed,
    summary: {
      total_records: records.length,
      valid: validCount,
      invalid: invalidCount,
      not_found: notFoundCount,
      not_applicable: notApplicableCount
    }
  };
}

/**
 * Get tariff details untuk kode INA-CBG tertentu
 * @param {string} kodeInacbg
 * @param {number} kelasRawat
 * @returns {object} Tariff details
 */
function getTarifDetails(kodeInacbg, kelasRawat) {
  const tarif = lookupTarifInacbg(kodeInacbg);

  if (!tarif) {
    return {
      found: false,
      kodeInacbg,
      error: `Kode INA-CBG "${kodeInacbg}" tidak ditemukan`
    };
  }

  const resmi = getTarifResmi(kodeInacbg, kelasRawat);

  return {
    found: true,
    kodeInacbg: tarif.kode_inacbg,
    deskripsi: tarif.deskripsi,
    jenis_layanan: tarif.jenis_layanan,
    kelasRawat: tarif.jenis_layanan === 'RAWAT_JALAN' ? null : kelasRawat,
    tarif_yang_berlaku: resmi?.tarif ?? null,
    tarif_kelas_1: tarif.tarif_kelas_1,
    tarif_kelas_2: tarif.tarif_kelas_2,
    tarif_kelas_3: tarif.tarif_kelas_3,
    regional: tarif.regional,
    tipe_rs: tarif.tipe_rs,
    sumber_halaman: tarif.sumber_halaman,
    sumber_dokumen: 'PMK No. 3 Tahun 2023'
  };
}

/**
 * Cross-check K-4-17-I untuk verifikasi integritas data
 * @returns {object} Cross-check result
 */
function crossCheckK417I() {
  const expectedTarif = 1264200;
  const tarif = lookupTarifInacbg('K-4-17-I');

  if (!tarif) {
    return {
      passed: false,
      kodeInacbg: 'K-4-17-I',
      status: 'NOT_FOUND',
      message: 'Kode K-4-17-I tidak ditemukan dalam tabel tarif',
      expected_tarif_kelas_3: expectedTarif,
      actual_tarif_kelas_3: null
    };
  }

  const actualTarif = tarif.tarif_kelas_3;
  const passed = actualTarif === expectedTarif;

  return {
    passed,
    kodeInacbg: 'K-4-17-I',
    status: passed ? 'PASS' : 'FAIL',
    message: passed
      ? 'Cross-check OK - K-4-17-I cocok dengan nilai terverifikasi dari klaim riil ELVINA SAIDAH'
      : `Cross-check GAGAL - Expected Rp${expectedTarif.toLocaleString('id-ID')} tapi actual Rp${actualTarif?.toLocaleString('id-ID') || '(null)'}`,
    deskripsi: tarif.deskripsi,
    expected_tarif_kelas_3: expectedTarif,
    actual_tarif_kelas_3: actualTarif,
    tarif_kelas_2: tarif.tarif_kelas_2,
    tarif_kelas_1: tarif.tarif_kelas_1,
    regional: tarif.regional,
    tipe_rs: tarif.tipe_rs,
    jenis_layanan: tarif.jenis_layanan,
    sumber_halaman: tarif.sumber_halaman,
    verification_source: 'Claim riil: ELVINA SAIDAH dengan kode K-4-17-I, Kelas 3, Rp1.264.200'
  };
}

module.exports = {
  verifyRecordTarif,
  verifyBatchTarif,
  getTarifDetails,
  crossCheckK417I
};
