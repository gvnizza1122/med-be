/**
 * Kategori yang HANYA ada di ICD-10-CM -> kategori ICD-10 WHO padanannya.
 * Dipakai pemeta WHO (kandidat tetap dipilih dari kamus WHO) dan grouper
 * INA-CBG (supaya kode CM yang belum terpetakan tetap punya kelompok & tarif).
 * Kasus asal: D49.2 (ANNISA NUR CHASANAH) tidak punya kandidat sama sekali.
 */
const JEMBATAN_CM_KE_WHO = Object.freeze({
  D49: 'D48', // neoplasma sifat tak tentu
  E08: 'E13', E09: 'E13', // diabetes karena kondisi lain / obat
  O9A: 'O99', // penyulit kehamilan lain
  M1A: 'M10', // gout kronik
  G89: 'R52', // nyeri NEC
  K68: 'K66', // gangguan retroperitoneum
});

// Subkode D49 (CM) berbeda arti dengan subkode D48 (WHO): D49.2 = tulang,
// jaringan lunak, kulit; D48.2 = saraf tepi. Dipetakan per kode lengkap.
const KODE_CM_KE_WHO = Object.freeze({
  'D49.0': 'D37.9', 'D49.1': 'D38.6', 'D49.2': 'D48.1', 'D49.3': 'D48.6',
  'D49.4': 'D41.4', 'D49.5': 'D41.9', 'D49.6': 'D43.2', 'D49.7': 'D44.9',
  'D49.8': 'D48.9', 'D49.9': 'D48.9',
});

function rapi(kode) {
  const k = String(kode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return k.length > 3 ? `${k.slice(0, 3)}.${k.slice(3)}` : k;
}

/** Padanan WHO untuk dipakai grouper (bukan untuk ditulis ke klaim). */
function padananGrouper(kode) {
  const k = rapi(kode);
  const pas = KODE_CM_KE_WHO[k] || KODE_CM_KE_WHO[k.slice(0, 5)];
  if (pas) return pas;
  const kat = k.slice(0, 3);
  return JEMBATAN_CM_KE_WHO[kat] ? JEMBATAN_CM_KE_WHO[kat] + k.slice(3) : k;
}

/** Kategori WHO untuk 3 karakter pertama sebuah kode (tetap bila sudah WHO). */
function kategoriWho(kode) {
  return padananGrouper(kode).slice(0, 3);
}

module.exports = { JEMBATAN_CM_KE_WHO, KODE_CM_KE_WHO, kategoriWho, padananGrouper };
