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

// Kategori 3 karakter ICD-10 WHO yang punya subkode (mis. J45 -> J45.0..J45.9).
const PUNYA_SUBKODE = new Set([...DIAGNOSIS.keys()].filter(k => k.includes('.')).map(k => k.split('.')[0]));

/**
 * Padanan ICD-10 WHO untuk kode yang tidak ada di kamus WHO (umumnya kode
 * ICD-10-CM Amerika). Hanya pemetaan yang PASTI: kode X.Y dipetakan ke
 * kategori X bila X ada di kamus WHO dan TIDAK punya subkode -- mis. J81.0
 * (CM) -> J81 "Pulmonary oedema". Kategori yang punya subkode (J45.3 -> J45.?)
 * tidak ditebak. Mengembalikan null bila tidak ada padanan pasti.
 */
function padananWho(kode) {
  const k = String(kode || '').trim().toUpperCase();
  if (!k.includes('.') || deskripsiDiagnosis(k)) return null;
  const kategori = k.split('.')[0];
  return deskripsiDiagnosis(kategori) && !PUNYA_SUBKODE.has(kategori) ? kategori : null;
}
const deskripsiProsedur = (kode) => cari(PROSEDUR, kode, 2);

module.exports = { deskripsiDiagnosis, deskripsiProsedur, padananWho };
