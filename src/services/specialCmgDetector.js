// Deteksi Top-Up Special CMG yang TERLEWAT (missed top-up) pada klaim --
// PMK No. 3 Tahun 2023, Lampiran I.A (Kriteria Special CMG: special
// procedure/drugs/investigation/prosthesis, Pasal 27 ayat 2 huruf a-d) DAN
// Lampiran Bagian II (Ketentuan Penjaminan per kelas RS, Pasal 34).
//
// PENTING -- kedua sumber data DIPAKAI BERSAMAAN, SENGAJA: kriteria kode
// yang cocok (special_cmg_kriteria.json) BUKAN berarti top-up itu boleh
// diklaim RS ini. Kalau kode_special_cmg-nya ada di tabel penjaminan
// (special_cmg_penjaminan_kelas_rs.json) DAN kelas RS pemanggil TIDAK
// termasuk yang diizinkan (mis. RR-04-III Hip/Knee Implant: "Penjaminan
// tidak dapat dilakukan di RS kelas D"), fungsi ini TIDAK menyarankan top-up
// itu sama sekali -- walau kriteria kode (group/diagnosis/prosedur) cocok
// 100%. Memakai satu tanpa yang lain bisa bikin sistem menyarankan top-up
// yang sebenarnya akan DITOLAK BPJS kalau diajukan RS Kelas D.
//
// Data dimuat langsung dari JSON (bukan query DB), sama seperti
// tarifInacbgLookup.js -- lihat file itu untuk alasan (validateRecord() di
// ruleEngine.js tetap sinkron/murni). Modul ini BELUM di-wire ke
// ruleEngine.js/aiReviewService.js (sengaja -- lihat instruksi tugas),
// berdiri sendiri dulu sampai severity/framing-nya diputuskan.
//
// Cakupan data: HANYA special procedure/drugs/investigation/prosthesis
// (Pasal 27 ayat 2 huruf a-d). Subacute/chronic cases (huruf e/f) TIDAK
// dicakup -- tidak punya tabel kriteria kode-per-kode di dokumen sumber
// (kemungkinan ditentukan dari LOS/durasi rawat, bukan pencocokan kode).

const KRITERIA_DATA = require('../data/special_cmg_kriteria.json');
const PENJAMINAN_DATA = require('../data/special_cmg_penjaminan_kelas_rs.json');

/**
 * Normalisasi input daftar kode -- terima array ATAU string dipisah ';'/','
 * (mengikuti konvensi claim_records.diagnosa_list/prosedur_list di
 * ruleEngine.js, yang dipisah ';').
 * @param {string[]|string|null|undefined} input
 * @returns {string[]} kode-kode ter-uppercase, trimmed, tanpa entri kosong/'-'
 */
function normalizeCodeList(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[;,]/);
  return raw
    .map(c => String(c || '').trim().toUpperCase())
    .filter(c => c && c !== '-');
}

// Index kriteria per KODE_GROUP_INACBG -> daftar baris special_cmg_kriteria
// yang berlaku untuk kode group itu (satu kode group bisa dipakai >1 baris
// special CMG berbeda, mis. M-1-04-* dipakai RR-04-III (prosthesis) DAN
// YY-01-II (procedure) sekaligus -- keduanya top-up TERPISAH utk operasi
// yang sama).
const KRITERIA_BY_GROUP = new Map();
for (const row of (KRITERIA_DATA.kriteria || [])) {
  for (const groupCode of (row.kode_group_inacbg || [])) {
    const key = String(groupCode).trim().toUpperCase();
    if (!KRITERIA_BY_GROUP.has(key)) KRITERIA_BY_GROUP.set(key, []);
    KRITERIA_BY_GROUP.get(key).push(row);
  }
}

// Index penjaminan per KODE_SPECIAL_CMG (baris tanpa kode_special_cmg, mis.
// Kemoterapi/Hemodialisis, sengaja tidak diindex -- itu kriteria kompetensi
// FKRTL umum di luar skema Special CMG, lihat catatan di init.js).
const PENJAMINAN_BY_KODE = new Map();
for (const row of (PENJAMINAN_DATA.penjaminan || [])) {
  if (row.kode_special_cmg) {
    PENJAMINAN_BY_KODE.set(String(row.kode_special_cmg).trim().toUpperCase(), row);
  }
}

/**
 * Cek apakah kelas RS tertentu diizinkan menurut satu baris penjaminan.
 * @param {object} penjaminanRow
 * @param {string} kelasRs - mis. 'D' (kelas akreditasi RS, BUKAN kelas_rawat 1/2/3)
 * @returns {boolean}
 */
function isKelasRsDiizinkan(penjaminanRow, kelasRs) {
  if (!penjaminanRow) return true; // tidak ada ketentuan penjaminan -> tidak dibatasi
  const kelas = String(kelasRs || '').trim().toUpperCase();

  if (kelas === 'D' && penjaminanRow.boleh_kelas_d === false) return false;

  if (Array.isArray(penjaminanRow.excluded_kelas_rs) && penjaminanRow.excluded_kelas_rs.includes(kelas)) {
    return false;
  }
  if (Array.isArray(penjaminanRow.allowed_kelas_rs) && penjaminanRow.allowed_kelas_rs.length > 0) {
    return penjaminanRow.allowed_kelas_rs.includes(kelas);
  }
  return true;
}

/**
 * Deteksi top-up Special CMG yang mungkin TERLEWAT pada suatu klaim.
 *
 * @param {string} kodeInacbg - kode group INA-CBG hasil grouping klaim (mis. "I-4-10-I")
 * @param {string[]|string} diagnosaList - daftar/​string kode ICD-10 klaim
 * @param {string[]|string} prosedurList - daftar/​string kode ICD-9-CM klaim
 * @param {string} kelasRs - kelas akreditasi RS (mis. "D") -- BUKAN kelas_rawat 1/2/3
 * @returns {{kode_special: string, deskripsi: string, alasan: string}|null}
 *   null kalau tidak ada temuan (tidak cocok kriteria, ATAU cocok kriteria
 *   tapi dilarang utk kelas RS ini -- kedua kasus SAMA-SAMA null, sengaja,
 *   supaya caller tidak perlu tahu bedanya "tidak cocok" vs "cocok tapi
 *   dilarang" -- keduanya berarti "jangan disarankan").
 */
function detectMissedTopUp(kodeInacbg, diagnosaList, prosedurList, kelasRs) {
  const results = detectAllMissedTopUps(kodeInacbg, diagnosaList, prosedurList, kelasRs);
  return results.length > 0 ? results[0] : null;
}

/**
 * Sama seperti detectMissedTopUp(), tapi mengembalikan SEMUA kecocokan
 * (bisa >1, mis. satu kode group INACBG dipakai top-up prosthesis DAN
 * procedure sekaligus) -- disediakan terpisah krn signature resmi yang
 * diminta cuma kembalikan satu objek/null.
 * @returns {Array<{kode_special: string, deskripsi: string, alasan: string}>}
 */
function detectAllMissedTopUps(kodeInacbg, diagnosaList, prosedurList, kelasRs) {
  if (!kodeInacbg) return [];
  const groupKey = String(kodeInacbg).trim().toUpperCase();
  const candidates = KRITERIA_BY_GROUP.get(groupKey);
  if (!candidates || candidates.length === 0) return [];

  const claimDiag = normalizeCodeList(diagnosaList);
  const claimProc = normalizeCodeList(prosedurList);

  const found = [];
  for (const row of candidates) {
    const kriteriaDiag = (row.kode_diagnosis || []).map(c => c.toUpperCase());
    const kriteriaProc = (row.kode_prosedur || []).map(c => c.toUpperCase());

    // Syarat diagnosis: kalau kriteria punya daftar diagnosis, klaim wajib
    // punya minimal 1 kode yang cocok. Kalau kriteria tidak mensyaratkan
    // diagnosis spesifik (daftar kosong), syarat ini otomatis terpenuhi.
    const diagOk = kriteriaDiag.length === 0 || kriteriaDiag.some(d => claimDiag.includes(d));
    // Syarat prosedur: sama polanya.
    const procOk = kriteriaProc.length === 0 || kriteriaProc.some(p => claimProc.includes(p));

    if (!diagOk || !procOk) continue;

    // Kriteria kode cocok -- SEBELUM disarankan, cek dulu ketentuan
    // penjaminan per kelas RS (Bagian II). Kalau dilarang utk kelas RS ini,
    // JANGAN disarankan sama sekali walau kriterianya cocok.
    const penjaminan = PENJAMINAN_BY_KODE.get(row.kode_special_cmg.toUpperCase());
    if (!isKelasRsDiizinkan(penjaminan, kelasRs)) continue;

    const alasanParts = [`Kode INACBG ${kodeInacbg} cocok dengan kriteria Special CMG ${row.kode_special_cmg} (${row.deskripsi}).`];
    if (kriteriaDiag.length > 0) {
      alasanParts.push(`Diagnosis klaim cocok kriteria (mis. ${kriteriaDiag.find(d => claimDiag.includes(d))}).`);
    }
    if (kriteriaProc.length > 0) {
      alasanParts.push(`Prosedur klaim cocok kriteria (mis. ${kriteriaProc.find(p => claimProc.includes(p))}).`);
    }
    if (penjaminan) {
      alasanParts.push(`Penjaminan utk kelas RS ${kelasRs || '(tidak diketahui)'}: diizinkan (${penjaminan.catatan_kelas_rs}).`);
    }

    found.push({
      kode_special: row.kode_special_cmg,
      deskripsi: row.deskripsi,
      alasan: alasanParts.join(' '),
    });
  }
  return found;
}

module.exports = { detectMissedTopUp, detectAllMissedTopUps, normalizeCodeList };
