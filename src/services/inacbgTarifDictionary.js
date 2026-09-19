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
 * Mencari tarif INA-CBG dari kamus hardcoded (12 entri, data nyata sampel
 * Permenkes) di atas.
 *
 * PENTING (fix 19 Sep 2026): Fungsi ini SEBELUMNYA meng-generate tarif
 * "estimasi" sintetis (baseByFamily * multiplier severity) untuk kode yang
 * tidak ada di kamus -- angka itu FIKTIF, tidak berdasar Permenkes, dan bisa
 * membuat pengguna mengira itu tarif resmi. Sekarang, kalau kode tidak ada
 * di kamus di atas, fungsi ini TIDAK LAGI mengarang angka: ia mengembalikan
 * `{ source: 'NOT_FOUND', tarif: null }` supaya pemanggil (aiReviewService.js)
 * menampilkan "tarif tidak tersedia" alih-alih angka palsu.
 *
 * Sumber tarif resmi Permenkes yang sesungguhnya (1075 kode, Regional 1 x
 * Kelas D Swasta) ada di src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json,
 * diakses lewat src/services/tarifInacbgLookup.js -- itu yang harus dipakai
 * sebagai sumber utama sebelum fallback ke kamus kecil ini.
 *
 * @param {string} inacbgCode Kode INA-CBG (mis: 'J-4-15-I')
 * @returns {object|null} { deskripsi, tarif, source: 'DICTIONARY' } kalau ada
 *   di kamus hardcoded, { source: 'NOT_FOUND', tarif: null } kalau tidak
 *   ditemukan, atau null kalau input invalid.
 */
function getInacbgEstimasi(inacbgCode) {
  if (!inacbgCode) return null;
  const upperCode = inacbgCode.toUpperCase().trim();

  // Cek kamus hardcoded (data nyata, bukan estimasi) terlebih dahulu
  if (INACBG_TARIF_DICTIONARY[upperCode]) {
    return { ...INACBG_TARIF_DICTIONARY[upperCode], source: 'DICTIONARY' };
  }

  // Kode tidak ditemukan -- JANGAN mengarang angka tarif. Kembalikan
  // penanda eksplisit supaya pemanggil tahu tidak ada data valid.
  return { source: 'NOT_FOUND', tarif: null };
}

module.exports = {
  INACBG_TARIF_DICTIONARY,
  getInacbgEstimasi
};
