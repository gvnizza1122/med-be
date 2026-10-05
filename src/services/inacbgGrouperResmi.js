/**
 * Grouper INA-CBG berbasis TABEL RESMI E-Klaim (bukan heuristik rentang).
 *
 * Sumber data: patch resmi E-Klaim INA-CBG 5.10.9 (inacbg.kemkes.go.id),
 * tabel MyISAM terbuka yang dibawa installer -- lihat src/data/inacbg/meta.json.
 * TIDAK ada berkas terenkripsi (.iccdb iDRG / grouper ber-ionCube) yang dibuka
 * untuk membangun ini; hanya tabel referensi yang memang terbuka.
 *
 * Yang RESMI & PASTI di sini:
 *   - Base CBG dari diagnosis utama  (src/data/inacbg/grouperDiagnosis.json:
 *     kolom Inpatient/Outpatient tabel alt_diagnosis).
 *   - Base CBG dari prosedur bedah   (grouperProsedur.json: tabel alt_procedures);
 *     bila ada beberapa, prioritas diambil dari urutan hierarki resmi
 *     (grouperHierarki.json: tabel alt_hierarchy1 -- ID kecil = prioritas tinggi).
 *   - Tarif per kelas & rawat jalan  (tarif.json: tabel tariff_20230124, irisan
 *     profil RS di meta.json, default Regional 1 x Kelas D Swasta).
 *
 * Yang BELUM resmi (estimasi):
 *   - Severity I/II/III. Matriks level CC per base-CBG (c51cclm diindeks kolom
 *     dccol) ada di berkas grouper terenkripsi, jadi TIDAK bisa direproduksi di
 *     sini. Severity default = I (paling konservatif, tidak pernah menaikkan
 *     tarif tanpa dasar). `severity_estimasi: true` menandai ini. Otoritas final
 *     tetap lembar grouper casemix / E-Klaim.
 */

const dxTable = require('../data/inacbg/grouperDiagnosis.json');
const pxTable = require('../data/inacbg/grouperProsedur.json');
const hierarki = require('../data/inacbg/grouperHierarki.json');
const tarifTable = require('../data/inacbg/tarif.json');
const META = require('../data/inacbg/meta.json');

const norm = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Base CBG resmi untuk satu kode (rawat inap / rawat jalan). */
function baseDiagnosis(kode, rawatInap) {
  const r = dxTable[norm(kode)];
  if (!r) return [];
  return rawatInap ? (r.ip || []) : (r.op || []);
}
function baseProsedur(kode, rawatInap) {
  const r = pxTable[norm(kode)];
  if (!r) return [];
  return rawatInap ? (r.ip || []) : (r.op || []);
}

/** Tarif resmi untuk kode CBG penuh (mis. "A-4-13-II"). */
function tarifResmi(kodeInacbg, kelasRawat, jenisKlaim) {
  const row = tarifTable[String(kodeInacbg || '').trim().toUpperCase()];
  if (!row) return { tarif: null, status: 'KODE_TIDAK_ADA' };
  const rawatInap = !/JALAN/i.test(String(jenisKlaim || '')) && String(jenisKlaim || '') !== 'RAWAT_JALAN';
  // Rawat jalan di tabel resmi = KELAS_RAWAT '0'. Rawat inap = '1'/'2'/'3'.
  if (!rawatInap) {
    const t = row['0'];
    return t != null ? { tarif: t, kelas: '0', status: 'OK' } : { tarif: null, status: 'TIDAK_BERLAKU_RJ' };
  }
  const kelas = String(Number(kelasRawat));
  if (['1', '2', '3'].includes(kelas) && row[kelas] != null) return { tarif: row[kelas], kelas, status: 'OK' };
  // kelas tak diketahui tetapi kode day-care hanya punya '0'
  if (row['0'] != null && row['1'] == null) return { tarif: row['0'], kelas: '0', status: 'OK' };
  return { tarif: null, status: 'KELAS_TIDAK_DIKETAHUI' };
}

/**
 * Menentukan base CBG (tanpa severity) dari diagnosis + prosedur.
 * @returns {{base, via, prosedur}|null}
 */
function tentukanBase(dxs, pxs, rawatInap) {
  const diags = (dxs || []).map(norm).filter(Boolean);
  const procs = (pxs || []).map(p => String(p || '').trim()).filter(Boolean);
  if (!diags.length) return null;

  // 1. Prosedur bedah: kumpulkan semua base-CBG prosedur, ambil prioritas hierarki.
  //    Prosedur PENUNJANG/TERAPI (ICD-9-CM mayor >= 87: lab 90.x, radiologi 87.x,
  //    EKG 89.52, nebulisasi 93.94, oksigen 93.96, dst.) TIDAK menggerakkan
  //    kelompok -- konsisten dengan konvensi casemix RS (penunjang & tindakan
  //    rutin tidak dikode sebagai prosedur bedah). Tanpa ini, rontgen/nebulisasi
  //    rawat jalan salah menjadi CBG prosedur (mis. 93.94 -> J-3-13).
  const kandidat = [];
  for (const p of procs) {
    const mayor = parseInt(String(p).replace(/[^0-9]/g, '').slice(0, 2), 10);
    if (Number.isFinite(mayor) && mayor >= 87) continue;
    for (const g of baseProsedur(p, rawatInap)) kandidat.push({ grup: g, prosedur: p });
  }
  if (kandidat.length) {
    kandidat.sort((a, b) => (hierarki[a.grup] ?? 9999) - (hierarki[b.grup] ?? 9999));
    return { base: kandidat[0].grup, via: 'prosedur', prosedur: kandidat[0].prosedur };
  }

  // 2. Diagnosis utama. Bila ada beberapa opsi, buang dulu kelompok BEDAH
  //    (casemix 1/2/3) -- itu hanya berlaku kalau ada prosedurnya (yang sudah
  //    ditangani di langkah 1). Dari sisanya ambil opsi PERTAMA (urutan tabel
  //    resmi = prioritas). Contoh: T31 "L-1-20,S-4-16" -> S-4-16 (L-1-20 bedah,
  //    tak ada prosedur); P07.3 "P-8-17,Z-4-12" -> P-8-17 (opsi pertama).
  const opsi = baseDiagnosis(diags[0], rawatInap);
  if (!opsi.length) return null;
  const nonBedah = opsi.filter(g => !/^[A-Z]-[123]-/.test(g));
  return { base: (nonBedah[0] || opsi[0]), via: 'diagnosis', prosedur: null };
}

/**
 * Grouper resmi. Mengembalikan kode CBG penuh + tarif, atau null bila kode
 * primer tidak ada di tabel resmi.
 * @param {string[]} diagnosisCodes - urutan pertama = diagnosis utama
 * @param {string[]} procedureCodes
 * @param {string} jenisKlaim - 'RAWAT_INAP' | 'RAWAT_JALAN'
 * @param {number|string} kelasRawat
 */
function grouperResmi(diagnosisCodes, procedureCodes = [], jenisKlaim = 'RAWAT_INAP', kelasRawat = 3) {
  const rawatInap = jenisKlaim !== 'RAWAT_JALAN';
  const b = tentukanBase(diagnosisCodes, procedureCodes, rawatInap);
  if (!b) return null;

  // Severity: estimasi konservatif = I. Rawat jalan memakai akhiran '0'.
  const severity = rawatInap ? 'I' : '0';
  const code = /-\d-\d+-[0IVX]+$/i.test(b.base) ? b.base : `${b.base}-${severity}`;
  const t = tarifResmi(code, kelasRawat, jenisKlaim);

  return {
    code,
    base: b.base,
    via: b.via,
    prosedur: b.prosedur,
    severity_estimasi: rawatInap, // severity I belum dari matriks CC resmi
    tarif: t.tarif,
    tarif_status: t.status,
    sumber: 'grouper_resmi_tabel_eklaim',
    confidence: b.via === 'prosedur' ? 0.75 : 0.65,
    reasoning: b.via === 'prosedur'
      ? `Base CBG ${b.base} dari prosedur ${b.prosedur} (tabel resmi alt_procedures), diagnosis utama ${norm(diagnosisCodes[0])}. Severity I = estimasi (matriks CC resmi tidak tersedia).`
      : `Base CBG ${b.base} dari diagnosis utama ${norm(diagnosisCodes[0])} (tabel resmi alt_diagnosis). Severity I = estimasi (matriks CC resmi tidak tersedia).`,
  };
}

module.exports = {
  grouperResmi, tarifResmi, tentukanBase, baseDiagnosis, baseProsedur,
  PROFIL: META.profil, META,
};
