/**
 * Penentu kode vs bukti pendukung (bagian 3 spek) — SELALU terpisah dari
 * pemilihan kode (pemilihKodeService.js). Fungsi murni, tidak menyentuh DB
 * atau model, tidak dipanggil dari pipeline hidup.
 *
 * - "Penentu kode" (lokasi, penyebab, akut/kronis, lateralitas, kehamilan,
 *   kerusakan organ) membantu memilih di antara kandidat yang SETARA lewat
 *   pencocokan kata kunci best-effort (BUKAN aturan per-kode yang di-hardcode).
 *   Tidak pernah memaksakan pilihan: kalau tidak ada kata kunci yang cocok,
 *   hasilnya null — ini juga yang mencegah "upcoding diam-diam" ketika
 *   determinan (pendekatan, kontras, dst.) tidak terdokumentasi.
 * - "Bukti pendukung" (VAS/suhu/TD/SpO2/nadi, lewat fungsi ambang_klinis milik
 *   agen lain) TIDAK PERNAH mengubah kode yang dipilih — hanya anotasi risiko
 *   terpisah (`buktiPendukung`, `risikoPending`).
 * - Tiga perilaku tabel-3: (1) ditulis+bukti mendukung -> jalan normal,
 *   (2) ditulis+bukti KONTRADIKSI -> risikoPending:true, (3) bukti ada tapi
 *   diagnosis TIDAK ditulis -> jangan tambah diagnosis, hanya
 *   `pertanyaanKeDokter` (saran teks, tidak pernah otomatis masuk daftar kode).
 *
 * KONTRAK ambangKlinis (diasumsikan dari penugasan agen lain, DIREKONSILIASI
 * saat merge): { cocokTekananDarah(sistol,diastol), cocokSuhu(c), cocokVas(n),
 * cocokSpo2(pct), cocokNadi(n) }. Tiap fungsi boleh mengembalikan boolean
 * (true = memenuhi ambang kegawatan) ATAU objek {gawat, kategori, keterangan}
 * — keduanya dinormalkan di sini (lihat normalisasiHasilAmbang) supaya kode
 * ini tidak patah kalau bentuk persis hasil akhir sedikit berbeda.
 */

const KATA_KUNCI_PENENTU = {
  lokasi: [
    'epigastrium', 'umbilikus', 'kuadran kanan atas', 'kuadran kiri atas',
    'suprapubik', 'pinggang', 'panggul', 'perut kanan', 'perut kiri',
  ],
  penyebab: ['trauma', 'infeksi', 'obat', 'alergi', 'keracunan', 'gigitan'],
  akut_kronis: ['akut', 'kronis', 'kronik'],
  lateralitas: ['kanan', 'kiri', 'bilateral'],
  kehamilan: ['hamil', 'gravida', 'kehamilan'],
  kerusakan_organ: [
    'gagal ginjal', 'edema paru', 'ensefalopati', 'kerusakan organ',
    'retinopati', 'perdarahan otak',
  ],
};

const KATA_GAWAT_TINGGI = ['emergensi', 'krisis'];
const KATA_KERUSAKAN_ORGAN_DOKUMENTASI = [
  'kerusakan organ', 'edema paru', 'ensefalopati', 'gagal ginjal akut',
  'perdarahan otak', 'retinopati hipertensi',
];
const KATA_NEGASI_LOKAL = ['tidak ada', 'tanpa', 'tidak ditemukan', 'tidak tampak', 'disangkal', 'bukan', 'belum ada'];

/**
 * Cek apakah `kataKunci` muncul di `teks` sebagai pernyataan POSITIF (bukan
 * dinegasikan oleh kata seperti "tidak ada"/"tanpa" tepat sebelum frasa itu).
 * Best-effort (jendela 25 karakter sebelum frasa), bukan parser negasi penuh
 * — cukup untuk menghindari kesalahan jelas semacam "tidak ada ... kerusakan
 * organ" terbaca sebagai BUKTI ADANYA kerusakan organ.
 */
function adaFrasaPositif(teks, kataKunci) {
  let dariIndeks = 0;
  for (;;) {
    const pos = teks.indexOf(kataKunci, dariIndeks);
    if (pos === -1) return false;
    const sebelum = teks.slice(Math.max(0, pos - 25), pos);
    const dinegasikan = KATA_NEGASI_LOKAL.some((n) => sebelum.includes(n));
    if (!dinegasikan) return true;
    dariIndeks = pos + kataKunci.length;
  }
}

function normalisasiHasilAmbang(hasil) {
  if (hasil == null) return { gawat: false, kategori: null, keterangan: null };
  if (typeof hasil === 'boolean') return { gawat: hasil, kategori: hasil ? 'memenuhi_ambang' : 'normal', keterangan: null };
  if (typeof hasil === 'object') {
    return { gawat: !!hasil.gawat, kategori: hasil.kategori || null, keterangan: hasil.keterangan || null };
  }
  return { gawat: false, kategori: null, keterangan: null };
}

/**
 * Pencocokan kata kunci penentu best-effort. Mengembalikan null (tidak
 * memaksakan pilihan) kalau tidak ada kata kunci yang terbukti dipakai di
 * KEDUA sisi (judul kandidat DAN teks konteks).
 */
function temukanPenentu(teksKonteks, kandidat) {
  const konteks = String(teksKonteks || '').toLowerCase();
  if (!konteks || !Array.isArray(kandidat) || kandidat.length < 2) return null;
  const semuaKataKunci = Object.values(KATA_KUNCI_PENENTU).flat();

  let terbaik = null;
  for (const k of kandidat) {
    const judul = String((k && k.judul) || '').toLowerCase();
    if (!judul) continue;
    const cocok = semuaKataKunci.filter((kw) => judul.includes(kw) && konteks.includes(kw));
    if (cocok.length > 0 && (!terbaik || cocok.length > terbaik.cocok.length)) {
      terbaik = { kode: k.kode, judul: k.judul, cocok };
    }
  }
  if (!terbaik) return null;
  return {
    kodeDisarankan: terbaik.kode,
    alasan: `Kata kunci penentu (${terbaik.cocok.join(', ')}) disebut di konteks dan cocok dengan judul kode ${terbaik.kode} ("${terbaik.judul}").`,
    kataKunciCocok: terbaik.cocok,
  };
}

function evaluasiBukti(vital = {}, ambangKlinis = {}) {
  const detail = [];
  const tambah = (jenis, nilaiMentah, fn, args) => {
    if (nilaiMentah == null || typeof fn !== 'function') return;
    let hasil;
    try { hasil = fn(...args); } catch { hasil = null; }
    detail.push({ jenis, nilai: nilaiMentah, ...normalisasiHasilAmbang(hasil) });
  };

  if (vital.sistol != null && vital.diastol != null) {
    tambah('tekanan_darah', `${vital.sistol}/${vital.diastol}`, ambangKlinis.cocokTekananDarah, [vital.sistol, vital.diastol]);
  }
  tambah('suhu', vital.suhu, ambangKlinis.cocokSuhu, [vital.suhu]);
  tambah('vas', vital.vas, ambangKlinis.cocokVas, [vital.vas]);
  tambah('spo2', vital.spo2, ambangKlinis.cocokSpo2, [vital.spo2]);
  tambah('nadi', vital.nadi, ambangKlinis.cocokNadi, [vital.nadi]);

  const adaGawat = detail.some((d) => d.gawat);
  return {
    dievaluasi: detail.length > 0,
    kegawatan: detail.length === 0 ? null : (adaGawat ? 'tinggi' : 'rendah'),
    detail,
  };
}

function ringkasDetail(detail) {
  return (detail || []).map((d) => `${d.jenis}=${d.nilai}`).join(', ');
}

/**
 * Perilaku (2): diagnosis tertulis memakai istilah "gawat tinggi" (emergensi/
 * krisis) tapi (a) tidak ada bukti kerusakan organ terdokumentasi di konteks
 * DAN (b) nilai vital yang tersedia tidak menunjukkan kegawatan tinggi
 * -> kontradiksi, risikoPending. Best-effort (kata kunci), bukan medis pasti.
 * Tanpa data vital sama sekali, tidak dituduh kontradiksi (tidak cukup dasar).
 */
function cekKontradiksi(teksDiagnosis, teksKonteks, bukti) {
  const diag = String(teksDiagnosis || '').toLowerCase();
  const konteks = String(teksKonteks || '').toLowerCase();
  const kataGawat = KATA_GAWAT_TINGGI.find((k) => diag.includes(k));
  if (!kataGawat) return { risiko: false, alasan: null };

  const adaBuktiOrganRusak = KATA_KERUSAKAN_ORGAN_DOKUMENTASI.some((k) => adaFrasaPositif(konteks, k));
  if (adaBuktiOrganRusak) return { risiko: false, alasan: null };

  if (!bukti.dievaluasi) return { risiko: false, alasan: null };
  if (bukti.kegawatan === 'tinggi') return { risiko: false, alasan: null };

  return {
    risiko: true,
    alasan: `Diagnosis menyebut kondisi gawat tinggi ("${kataGawat}") tetapi nilai vital (${ringkasDetail(bukti.detail)}) `
      + 'tidak menunjukkan kegawatan tinggi dan tidak ada bukti kerusakan organ terdokumentasi di sekitar diagnosis.',
  };
}

/**
 * @param {object} opsi
 *   diagnosisTertulis: boolean (default true) — perilaku (3) kalau false.
 *   teksDiagnosis: string
 *   teksKonteks: string (anamnesis/pemeriksaan di sekitar diagnosis, dipakai
 *     penentu kode + cek kontradiksi)
 *   kandidat: Array<{kode, judul, lapis}>
 *   vital: {sistol?, diastol?, suhu?, vas?, spo2?, nadi?}
 *   ambangKlinis: {cocokTekananDarah, cocokSuhu, cocokVas, cocokSpo2, cocokNadi}
 * @returns {{penentu, buktiPendukung, risikoPending, alasanRisiko, pertanyaanKeDokter}}
 */
function nilaiPenentuVsBukti(opsi = {}) {
  const {
    diagnosisTertulis = true, teksDiagnosis = '', teksKonteks = '',
    kandidat = [], vital = {}, ambangKlinis = {},
  } = opsi;

  const bukti = evaluasiBukti(vital, ambangKlinis);

  // Perilaku (3): bukti ada, diagnosis TIDAK tertulis.
  if (!diagnosisTertulis) {
    const adaIndikasi = bukti.detail.some((d) => d.gawat);
    return {
      penentu: null,
      buktiPendukung: bukti,
      risikoPending: false,
      alasanRisiko: null,
      pertanyaanKeDokter: adaIndikasi
        ? `Nilai vital (${ringkasDetail(bukti.detail)}) menunjukkan kemungkinan kondisi yang belum tertulis sebagai `
          + 'diagnosis di berkas — konfirmasi ke dokter dulu, jangan tambahkan diagnosis secara otomatis.'
        : null,
    };
  }

  const penentu = temukanPenentu(teksKonteks, kandidat);
  const kontradiksi = cekKontradiksi(teksDiagnosis, teksKonteks, bukti);

  return {
    penentu,
    buktiPendukung: bukti,
    risikoPending: kontradiksi.risiko,
    alasanRisiko: kontradiksi.alasan,
    pertanyaanKeDokter: null,
  };
}

module.exports = {
  KATA_KUNCI_PENENTU,
  temukanPenentu,
  evaluasiBukti,
  cekKontradiksi,
  nilaiPenentuVsBukti,
};
