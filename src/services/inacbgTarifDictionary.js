/**
 * Kamus Estimasi Tarif INA-CBG (Proof of Concept)
 * Berdasarkan Permenkes No. 3 Tahun 2023.
 * Catatan: Ini adalah sampel kamus untuk tujuan estimasi (Pre-Coding).
 * Nilai yang digunakan adalah asumsi dasar RS Tipe C Regional 1.
 */

const INACBG_TARIF_DICTIONARY = {
  // --- Penyakit Sistem Pernapasan (J) ---
  'J-4-15-I': { deskripsi: 'INFEKSI SALURAN NAPAS BAWAH RINGAN', tarif: 3500000 },
  'J-4-15-II': { deskripsi: 'INFEKSI SALURAN NAPAS BAWAH SEDANG', tarif: 4200000 },
  'J-4-15-III': { deskripsi: 'INFEKSI SALURAN NAPAS BAWAH BERAT', tarif: 5800000 },
  'J-4-16-I': { deskripsi: 'GANGGUAN SALURAN NAPAS BAWAH LAINNYA RINGAN', tarif: 2800000 },
  
  // --- Penyakit Sistem Kardiovaskular (I) ---
  'I-4-10-I': { deskripsi: 'HIPERTENSI TANPA KOMPLIKASI', tarif: 2100000 },
  'I-4-10-II': { deskripsi: 'HIPERTENSI DENGAN KOMPLIKASI SEDANG', tarif: 3200000 },
  'I-4-11-I': { deskripsi: 'GANGGUAN JANTUNG RINGAN', tarif: 4500000 },

  // --- Penyakit Sistem Pencernaan (K) ---
  'K-4-17-I': { deskripsi: 'GASTROENTERITIS & INFEKSI PENCERNAAN RINGAN', tarif: 2300000 },
  'K-4-17-II': { deskripsi: 'GASTROENTERITIS & INFEKSI PENCERNAAN SEDANG', tarif: 3100000 },

  // --- Penyakit Infeksi & Parasit (A) ---
  'A-4-14-I': { deskripsi: 'INFEKSI BAKTERI/VIRUS RINGAN (Tipes/Demam Berdarah)', tarif: 2500000 },
  'A-4-14-II': { deskripsi: 'INFEKSI BAKTERI/VIRUS SEDANG', tarif: 3500000 },
  
  // --- Gangguan Endokrin (E) ---
  'E-4-10-I': { deskripsi: 'DIABETES MELLITUS TANPA KOMPLIKASI', tarif: 2800000 },
  'E-4-10-II': { deskripsi: 'DIABETES MELLITUS DENGAN KOMPLIKASI', tarif: 4100000 },
};

/**
 * Mencari tarif estimasi INA-CBG dari kamus
 * @param {string} inacbgCode Kode INA-CBG (mis: 'J-4-15-I')
 * @returns {object|null} Objek berisi deskripsi dan tarif, atau null jika tidak ditemukan
 */
function getInacbgEstimasi(inacbgCode) {
  if (!inacbgCode) return null;
  const upperCode = inacbgCode.toUpperCase().trim();
  return INACBG_TARIF_DICTIONARY[upperCode] || null;
}

module.exports = {
  INACBG_TARIF_DICTIONARY,
  getInacbgEstimasi
};
