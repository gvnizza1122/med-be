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
  const kelasRawatValid = kelas === 1 || kelas === 2 || kelas === 3;
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

  // Fix (21 Sep 2026): kasus produksi G-4-22-I (kode rawat inap murni --
  // kelasA/B/C terisi, kelasD null, jadi fallback di atas TIDAK berlaku).
  // Sebelum fix ini, pemanggil (aiReviewService.js) diam-diam mengganti
  // kelas_rawat yang kosong dengan default '3' SEBELUM sampai ke fungsi ini,
  // jadi kalau field kelas_rawat hasil ekstraksi berisi sampah non-numerik
  // (mis. AI salah menyalin "-"/"IGD" alih-alih benar-benar mengosongkan
  // field itu -- lihat aturan 8 di pdfExtractionService.js), default '3' itu
  // TIDAK ikut menyelamatkan (default cuma jalan kalau field itu falsy/
  // kosong total, bukan kalau isinya sampah tapi truthy) -> Number(kelasRawat)
  // jadi NaN, tidak ada kolom kelas yang cocok, tarifValue tetap null SAMPAI
  // SINI tanpa ada penjelasan ke pengguna kenapa -- panel FE cuma menampilkan
  // "Tidak ditemukan" walau kode & deskripsinya sendiri sudah ketemu (row
  // bukan undefined). aiReviewService.js sekarang TIDAK lagi mendefault
  // kelas_rawat ke '3' sebelum memanggil fungsi ini -- nilai mentah
  // diteruskan apa adanya supaya kelasRawatValid di atas benar-benar
  // mencerminkan apakah kelas kamar pasien diketahui, lalu alasanTarifKosong
  // di bawah membedakan 2 penyebab tarif null yang beda maknanya:
  //  1. kelas_rawat tidak diketahui/tidak valid -> kita GENUINELY tidak tahu
  //     kolom mana yang harus dibaca, JANGAN menebak salah satu (itu sama
  //     saja mengarang angka).
  //  2. kelas_rawat valid (1/2/3) TAPI kolom itu sendiri "-"/kosong di
  //     dokumen PMK 3/2023 sumber untuk kode ini (kode ada, tapi memang
  //     tidak dijamin BPJS untuk kelas rawat tsb).
  let alasanTarifKosong = null;
  if (tarifValue === null) {
    if (kelasRawatValid) {
      alasanTarifKosong = `Kode ${row.code} ditemukan di PMK No. 3 Tahun 2023 (Regional 1, Kelas D Swasta), tapi tarif untuk kelas rawat ${kelas} memang tidak berlaku/tidak dijamin ("-") di dokumen sumber untuk kode ini.`;
    } else {
      const nilaiMentah = kelasRawat === undefined || kelasRawat === null || kelasRawat === ''
        ? '(kosong)'
        : JSON.stringify(String(kelasRawat));
      alasanTarifKosong = `Kode ${row.code} ditemukan di PMK No. 3 Tahun 2023 (Regional 1, Kelas D Swasta), tapi kelas rawat pasien tidak diketahui/tidak valid (nilai kelas_rawat: ${nilaiMentah}), sehingga tarif kelas 1/2/3 untuk kode ini belum bisa ditentukan. Kode ini juga bukan kode day-care/RJTL (tidak punya tarif tunggal kelas D).`;
    }
  }

  return { tarif: tarifValue, sumber: row, kelasRawatValid, alasanTarifKosong };
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
    return {
      valid: false,
      status: 'TARIF_TIDAK_BERLAKU',
      selisih: 0,
      tarifResmi: null,
      tarifKlaim: Number(tarifKlaim) || null,
      // Fix 21 Sep 2026: status di atas tetap 'TARIF_TIDAK_BERLAKU' apa
      // adanya (jangan pecah jadi status baru) supaya ruleEngine.js RV-21
      // yang sudah switch di atas status ini tidak diam-diam berhenti
      // menandai error -- tapi pemanggil sekarang bisa membaca alasan/
      // kelasRawatValid untuk pesan yang lebih spesifik daripada teks
      // generik "tidak berlaku" saja.
      alasan: resmi.alasanTarifKosong,
      kelasRawatValid: resmi.kelasRawatValid,
    };
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

/**
 * Apakah kode INA-CBG cocok dengan jenis klaim. Kode rawat jalan/day-care
 * hanya bertarif tunggal di kolom kelasD; kode rawat inap bertarif per kelas
 * kamar (kelasA/B/C). Dipakai untuk menolak usulan AI yang ada di tabel
 * tetapi salah jenis layanan -- ditemukan pada klaim rawat jalan EIFFELIN
 * (R06.0;J45.3) yang diberi J-4-13-I "Trauma Dada" Rp3.276.500.
 * Jenis klaim tidak dikenal -> tidak dinilai (true).
 */
function cocokJenisKlaim(kodeInacbg, jenisKlaim) {
  const row = lookupTarifInacbg(kodeInacbg);
  if (!row) return false;
  const rawatJalan = row.kelasD != null;
  if (jenisKlaim === 'RAWAT_JALAN') return rawatJalan;
  if (jenisKlaim === 'RAWAT_INAP') return row.kelasA != null || row.kelasB != null || row.kelasC != null;
  return true;
}

module.exports = { lookupTarifInacbg, getTarifResmi, validateTarifDiscrepancy, cocokJenisKlaim, TARIF_MAP };

