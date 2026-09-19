// Lookup tarif resmi INA-CBG (PMK No. 3 Tahun 2023), khusus irisan
// Regional 1 x Kelas D Swasta (satu-satunya kombinasi yang relevan untuk
// RS Lestari Raharja, Kode Provider 0170). Dipakai oleh RV-21 di
// ruleEngine.js untuk memvalidasi TARIF_INACBG klaim terhadap tarif resmi.
//
// Data dimuat langsung dari JSON (bukan query DB) supaya validateRecord()
// di ruleEngine.js tetap sinkron/murni seperti fungsi-fungsi rule lain di
// file itu -- tabel tarif_inacbg_pmk3_2023 di database (lihat
// src/database/init.js) tetap ada untuk keperluan lain (mis. endpoint API
// referensi tarif), tapi rule engine tidak bergantung padanya.
//
// Lihat src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json (field "meta")
// untuk metode ekstraksi, cross-check kode K-4-17-I, dan catatan cakupan.

const DATA = require('../data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json');

const TARIF_MAP = new Map();
// Data can be in either 'tarif' array (old format) or 'data' array (current format)
const tariffData = DATA.tarif || DATA.data || [];
for (const row of tariffData) {
  if (row && row.code) {
    TARIF_MAP.set(String(row.code).trim().toUpperCase(), row);
  }
}

/**
 * @param {string} kodeInacbg
 * @returns {object|undefined} baris tarif resmi, atau undefined kalau kode
 *   tidak ada di tabel Regional 1 x Kelas D Swasta ini.
 */
function lookupTarifInacbg(kodeInacbg) {
  if (!kodeInacbg) return undefined;
  return TARIF_MAP.get(String(kodeInacbg).trim().toUpperCase());
}

/**
 * Tarif resmi yang berlaku untuk kombinasi kode INACBG + kelas rawat +
 * jenis klaim tertentu.
 * @param {string} kodeInacbg
 * @param {number|string} kelasRawat - 1, 2, atau 3 (dipakai hanya untuk RAWAT_INAP)
 * @returns {{tarif: number|null, sumber: object}|undefined} undefined kalau
 *   kode tidak ditemukan di tabel sama sekali; { tarif: null, ... } kalau
 *   kode DITEMUKAN tapi tarif untuk kelas ini "-" (tidak berlaku/tidak
 *   dijamin) di dokumen sumber -- BEDA arti dari kode tidak ditemukan sama
 *   sekali.
 */
function getTarifResmi(kodeInacbg, kelasRawat) {
  const row = lookupTarifInacbg(kodeInacbg);
  if (!row) return undefined;

  // JSON uses kelasA, kelasB, kelasC, kelasD format
  // Map BPJS kelas (1, 2, 3) to JSON kelas (A, B, C, D)
  const kelas = Number(kelasRawat);
  let tarifValue = null;

  if (kelas === 3) {
    tarifValue = row.kelasC ?? row.tarif_kelas_3 ?? null;
  } else if (kelas === 2) {
    tarifValue = row.kelasB ?? row.tarif_kelas_2 ?? null;
  } else if (kelas === 1) {
    tarifValue = row.kelasA ?? row.tarif_kelas_1 ?? null;
  }
  // kelas_rawat kosong/tidak dikenal (mis. klaim RAWAT_JALAN yang memang
  // tidak mengisi kelas_rawat) -> tarifValue tetap null di titik ini,
  // JANGAN langsung `return undefined` di sini -- lanjut ke fallback kelasD
  // di bawah dulu sebelum menyerah, karena kode ini BISA SAJA valid.

  // Fix (19 Sep 2026): ~287 dari 1075 kode di tabel PMK 3/2023 ini adalah
  // kode day-care/RJTL yang TIDAK distratifikasi per kelas kamar (1/2/3) --
  // datanya hanya terisi di kolom kelasD (satu tarif tunggal, kelasA/B/C
  // memang "-"/null untuk kode-kode itu). RV-21 di ruleEngine.js sudah lama
  // mendokumentasikan niat ini ("kelas rawat diabaikan untuk RAWAT_JALAN"),
  // tapi implementasi di sini sebelumnya TIDAK PERNAH membaca kelasD sama
  // sekali -- akibatnya kode-kode day-care/RJTL yang sebenarnya valid & ada
  // tarifnya selalu tampil "tidak ditemukan"/"tarif tidak berlaku". Kalau
  // kolom kelas rawat yang diminta kosong TAPI kelasD terisi, pakai kelasD
  // sebagai tarif tunggal tsb -- ini murni membaca field lain di baris resmi
  // yang sama, BUKAN mengarang/mengestimasi angka.
  if (tarifValue === null && row.kelasD != null) {
    tarifValue = row.kelasD;
  }

  return { tarif: tarifValue, sumber: row };
}

/**
 * Memvalidasi tarif klaim vs tarif resmi PMK 3/2023 (Regional 1 Kelas D Swasta).
 * Jika selisih > 0, hasilkan detail selisih & error deterministik.
 * @param {string} kodeInacbg
 * @param {number|string} kelasRawat
 * @param {number|string} tarifKlaim
 * @returns {{ valid: boolean, status: string, selisih: number, tarifResmi: number|null, tarifKlaim: number|null, detail?: object }}
 */
function validateTarifDiscrepancy(kodeInacbg, kelasRawat, tarifKlaim) {
  const resmi = getTarifResmi(kodeInacbg, kelasRawat);
  if (!resmi) {
    return { valid: true, status: 'KODE_TIDAK_DITEMUKAN', selisih: 0, tarifResmi: null, tarifKlaim: Number(tarifKlaim) || null };
  }
  if (resmi.tarif === null) {
    return { valid: false, status: 'TARIF_TIDAK_BERLAKU', selisih: 0, tarifResmi: null, tarifKlaim: Number(tarifKlaim) || null };
  }
  const claimValue = Number(tarifKlaim);
  if (isNaN(claimValue) || claimValue <= 0) {
    return { valid: true, status: 'TARIF_KLAIM_KOSONG', selisih: 0, tarifResmi: Number(resmi.tarif), tarifKlaim: null };
  }

  const selisih = Math.abs(Math.round(claimValue) - Math.round(Number(resmi.tarif)));
  const valid = selisih === 0;

  return {
    valid,
    status: valid ? 'MATCH' : 'DISCREPANCY',
    selisih,
    tarifResmi: Number(resmi.tarif),
    tarifKlaim: claimValue,
    detail: resmi.sumber
  };
}

module.exports = { lookupTarifInacbg, getTarifResmi, validateTarifDiscrepancy, TARIF_MAP };

