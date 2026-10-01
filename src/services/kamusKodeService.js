/**
 * Kamus kode lokal SATUSEHAT: ICD-10 WHO (diagnosis) dan ICD-9-CM (prosedur).
 * Dibaca dari berkas JSON, bukan tabel basis data, supaya tetap jalan walau
 * tabel kamus belum di-seed. Dipakai endpoint keterangan kode dan saran koding.
 */
const icd10 = require('../data/icd10_who_dictionary.json');
const icd9cm = require('../data/icd9cm_procedures.json');

const DIAGNOSIS = new Map(icd10.codes.map(({ code, description_en }) => [code.toUpperCase(), description_en]));
const PROSEDUR = new Map(icd9cm.codes.map(({ code, description_en }) => [code.toUpperCase(), description_en]));

// Kode kadang tersimpan tanpa titik ("N209", "9904"). Kamus memakai titik,
// jadi coba sisipkan titik di posisi bakunya: ICD-10 setelah 3 karakter,
// ICD-9-CM setelah 2 digit.
function cari(kamus, kodeMentah, posisiTitik) {
  if (typeof kodeMentah !== 'string') return undefined;
  const kode = kodeMentah.trim().toUpperCase();
  if (!/^[A-Z0-9.]{2,10}$/.test(kode)) return undefined;
  return kamus.get(kode)
    || (!kode.includes('.') && kode.length > posisiTitik
      ? kamus.get(`${kode.slice(0, posisiTitik)}.${kode.slice(posisiTitik)}`)
      : undefined);
}

const deskripsiDiagnosis = (kode) => cari(DIAGNOSIS, kode, 3);
const deskripsiProsedur = (kode) => cari(PROSEDUR, kode, 2);

module.exports = { deskripsiDiagnosis, deskripsiProsedur };
