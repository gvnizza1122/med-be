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
 * Mencari/generate tarif estimasi INA-CBG
 * Jika kode ditemukan di kamus, gunakan nilai aktual
 * Jika tidak ditemukan, generate estimasi berdasarkan severity level
 * @param {string} inacbgCode Kode INA-CBG (mis: 'J-4-15-I')
 * @returns {object|null} Objek berisi deskripsi dan tarif, atau null jika input invalid
 */
function getInacbgEstimasi(inacbgCode) {
  if (!inacbgCode) return null;
  const upperCode = inacbgCode.toUpperCase().trim();

  // Cek kamus terlebih dahulu
  if (INACBG_TARIF_DICTIONARY[upperCode]) {
    return INACBG_TARIF_DICTIONARY[upperCode];
  }

  // Generate estimasi untuk kode yang tidak ditemukan di kamus
  const parts = upperCode.split('-');
  if (parts.length < 4) return null; // Format kode tidak valid

  const family = parts[0];
  const severity = parts[3]; // I=Ringan, II=Sedang, III=Berat

  // Base tariff per keluarga (RS Tipe C Regional 1, dalam IDR)
  const baseByFamily = {
    A: 2500000, // Penyakit Infeksi
    B: 2200000, // Penyakit Neoplasma
    C: 1800000, // Penyakit Darah
    D: 2100000, // Penyakit Endokrin
    E: 2800000, // Penyakit Mental
    F: 3200000, // Penyakit Saraf
    G: 2900000, // Penyakit Mata
    H: 3100000, // Penyakit Telinga
    I: 3500000, // Penyakit Jantung
    J: 3800000, // Penyakit Pernapasan
    K: 2600000, // Penyakit Pencernaan
    L: 2400000, // Penyakit Kulit
    M: 4200000, // Penyakit Muskuloskeletal
    N: 3300000, // Penyakit Genitourinaria
    O: 5200000, // Kehamilan & Persalinan
    P: 4800000, // Periode Perinatal
    Q: 3900000, // Penyakit Kongenital
    R: 2700000, // Gejala Umum
    S: 2500000, // Trauma
    T: 2300000, // Penyebab Eksternal
    U: 2100000, // Faktor Eksternal
    V: 2200000, // Faktor Lainnya
    Z: 1500000, // Faktor Sosial
  };

  let baseAmount = baseByFamily[family] || 3000000; // Default 3 juta jika family tidak dikenali

  // Adjustment berdasarkan severity
  let multiplier = 1.0;
  if (severity === 'III' || severity === '3') {
    multiplier = 1.8; // Berat: +80%
  } else if (severity === 'II' || severity === '2') {
    multiplier = 1.4; // Sedang: +40%
  }
  // Severity I atau 1 tetap 1.0x (Ringan)

  const estimatedAmount = Math.round(baseAmount * multiplier);

  return {
    deskripsi: `Estimasi - ${family}-${parts[1]}-${parts[2]} (Severity: ${severity})`,
    tarif: estimatedAmount,
  };
}

module.exports = {
  INACBG_TARIF_DICTIONARY,
  getInacbgEstimasi
};
