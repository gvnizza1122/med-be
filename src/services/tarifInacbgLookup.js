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
for (const row of (DATA.tarif || [])) {
  if (row && row.kode_inacbg) {
    TARIF_MAP.set(String(row.kode_inacbg).trim().toUpperCase(), row);
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

  if (row.jenis_layanan === 'RAWAT_JALAN') {
    return { tarif: row.tarif_kelas_3 ?? null, sumber: row };
  }

  const kelas = Number(kelasRawat);
  if (kelas === 3) return { tarif: row.tarif_kelas_3 ?? null, sumber: row };
  if (kelas === 2) return { tarif: row.tarif_kelas_2 ?? null, sumber: row };
  if (kelas === 1) return { tarif: row.tarif_kelas_1 ?? null, sumber: row };
  return undefined; // kelas_rawat tidak valid (1/2/3) -- biarkan RV-07 yang menangani
}

module.exports = { lookupTarifInacbg, getTarifResmi, TARIF_MAP };
