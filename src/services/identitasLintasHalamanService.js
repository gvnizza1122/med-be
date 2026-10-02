/**
 * Verifikasi identitas lintas halaman.
 *
 * Tujuannya menangkap berkas klaim yang ketumpangan halaman milik pasien lain
 * -- risiko nyata saat berkas discan berkelompok. Halaman nyasar bisa membuat
 * klaim dinilai dari kondisi klinis orang lain, dan pembenaran yang kita
 * kirim ke BPJS jadi tidak berasal dari pasien yang diklaim.
 *
 * DIRANCANG DARI DATA SUNGGUHAN (23 Sep 2026, 36 klaim di server). Tiga
 * temuan yang membentuk aturan di bawah:
 *
 * 1. No RM yang berbeda SERING BUKAN pasien berbeda. Satu klaim memuat
 *    laporan radiologi dari RS Soerojo Magelang dengan No RM rumah sakit itu
 *    (00305609), padahal No RM klaimnya 160642 -- pasiennya sama persis.
 *    Dokumen rujukan dari faskes lain memang membawa nomor rekam medis
 *    faskes tersebut.
 *
 * 2. Sebagian selisih No RM cuma SALAH BACA OCR satu digit: 172338 vs 172339,
 *    114831 vs 114931. Kalau tiap selisih dialarmkan, petugas akan dibanjiri
 *    peringatan palsu dan berhenti mempercayainya.
 *
 * 3. Nama pasien jauh lebih andal daripada No RM maupun kop rumah sakit.
 *    Kop RS terbaca sangat berantakan ("RS LEST ARI RAHAR Ia", "RS Lestan
 *    Raharja"), sedangkan nama masih terbaca utuh walau ada satu huruf
 *    meleset ("ELFATIM" untuk "ELFATIH").
 *
 * Karena itu NAMA yang dijadikan penentu identitas, dan No RM yang berbeda
 * hanya dipersoalkan kalau namanya juga tidak cocok.
 */

// --- Nama ---

// Gelar dan penanda yang menempel di nama pasien pada berkas RS dan tidak
// ikut menentukan identitas: Tn/Ny/Sdr/Nn/An (anak), By (bayi), Bp.
const GELAR = /\b(TN|NY|NN|SDR|SDRI|AN|BY|BP|TUAN|NYONYA|SAUDARA|ANAK|BAYI)\b\.?/g;

/** Samakan bentuk nama supaya bisa dibandingkan: huruf besar, tanpa gelar/tanda baca. */
function normalisasiNama(nama) {
  if (!nama) return '';
  return String(nama)
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .replace(GELAR, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Jarak Levenshtein, dipakai menoleransi satu-dua huruf yang salah dibaca OCR. */
function jarakEdit(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let sebelumnya = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const sekarang = [i];
    for (let j = 1; j <= b.length; j++) {
      sekarang[j] = Math.min(
        sebelumnya[j] + 1,
        sekarang[j - 1] + 1,
        sebelumnya[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    sebelumnya = sekarang;
  }
  return sebelumnya[b.length];
}

/** Dua kata dianggap sama kalau selisihnya kecil relatif panjangnya. */
function kataMirip(a, b) {
  if (a === b) return true;
  const toleransi = Math.min(2, Math.floor(Math.max(a.length, b.length) / 4));
  return jarakEdit(a, b) <= toleransi;
}

/**
 * Apakah dua nama merujuk orang yang sama?
 *
 * Dibandingkan per kata, bukan sebagai satu untai, karena berkas sering
 * memuat nama sebagian saja (hanya nama depan, atau tanpa nama belakang).
 * Cukup kalau SEMUA kata pada nama yang lebih pendek punya pasangan di nama
 * yang lebih panjang -- dengan syarat minimal dua kata cocok, supaya dua orang
 * yang kebetulan sama-sama bernama depan "MUHAMMAD" tidak dianggap satu orang.
 */
function namaCocok(a, b) {
  const kataA = normalisasiNama(a).split(" ").filter(k => k.length >= 3);
  const kataB = normalisasiNama(b).split(" ").filter(k => k.length >= 3);
  if (!kataA.length || !kataB.length) return null; // tidak bisa dinilai

  const [pendek, panjang] = kataA.length <= kataB.length ? [kataA, kataB] : [kataB, kataA];
  const tersisa = [...panjang];
  let cocok = 0;
  for (const kata of pendek) {
    const idx = tersisa.findIndex(k => kataMirip(kata, k));
    if (idx !== -1) { tersisa.splice(idx, 1); cocok++; }
  }

  // Dua kata cocok sudah cukup meyakinkan, dan ambang itu sengaja tidak
  // menuntut SEMUA kata cocok: teks OCR kerap menyisipkan potongan label
  // yang bukan bagian dari nama, dan menuntut kecocokan penuh membuat
  // halaman yang sah dituduh milik pasien lain.
  // OCR kerap menghilangkan spasi antar kata ("IKAMARWATI" untuk "IKA
  // MARWATI"). Dibandingkan juga tanpa spasi supaya orang yang sama tidak
  // dianggap berbeda hanya karena satu spasi hilang.
  const rapatA = kataA.join("");
  const rapatB = kataB.join("");
  if (kataMirip(rapatA, rapatB)) return true;

  if (cocok >= 2) return true;

  // Sama sekali tidak ada kata yang cocok -- ini baru pantas disebut beda.
  if (cocok === 0) return false;

  // Tepat satu kata cocok. Kalau memang cuma satu kata yang tersedia
  // (halaman hanya mencantumkan satu nama), itu kecocokan penuh. Selain itu
  // biarkan tidak pasti daripada menuduh -- "MUHAMMAD" saja tidak cukup
  // untuk menyimpulkan apa pun, ke arah mana pun.
  return pendek.length === 1 ? true : null;
}

// --- No RM ---

// Pemisah WAJIB ada. Tanpa itu, kata "Normal" ikut tertangkap sebagai
// "No" + "rm" -- betul-betul terjadi pada teks OCR di server ("Normal ECG").
const POLA_RM = /\bno\.?\s*\.?\s*rm\b\s*[.:#=_-]*\s*(\d{5,8})/i;

function ekstrakNoRm(teks) {
  const m = String(teks || '').match(POLA_RM);
  return m ? m[1] : null;
}

/**
 * Selisih No RM yang masih masuk akal sebagai salah baca OCR, bukan nomor
 * yang benar-benar lain: panjangnya sama dan hanya satu digit berbeda.
 */
function kemungkinanSalahBacaRm(a, b) {
  if (!a || !b) return false;
  // Selisih panjang satu digit ikut dihitung: OCR tidak hanya salah baca
  // digit, tapi juga kerap menyisipkan atau menghilangkan satu ("1178341"
  // untuk "178341"). Tanpa ini, kekeliruan baca tersebut salah digolongkan
  // sebagai dokumen dari faskes lain.
  if (Math.abs(a.length - b.length) > 1) return false;
  return jarakEdit(a, b) === 1;
}

// --- Nama pada halaman ---

// Label nama di berkas RS kerap diikuti tanda baca hasil OCR yang aneh
// (contoh nyata: 'NAMA " ELFATIM'), jadi pemisahnya dibuat longgar.
// Nilainya berhenti di label berikutnya (kata BESAR diikuti titik dua) supaya
// tidak menelan sisa baris.
const POLA_NAMA = /\bnama\s*(?:pasien|peserta)?\s*[^A-Za-z0-9]{0,4}\s*([A-Za-z][A-Za-z. '-]{2,60})/i;

function ekstrakNama(teks) {
  const m = String(teks || "").match(POLA_NAMA);
  if (!m) return null;
  // Nilai nama sering menelan label di sebelahnya (contoh nyata:
  // "ELFATIM NO. FOTO"). Sisa itu harus dibuang -- kata sampah membuat
  // pencocokan gagal dan memicu alarm "pasien berbeda" yang keliru.
  const LABEL_BERIKUT = /\s(?:NO|TGL|JENIS|KELAMIN|ALAMAT|UMUR|USIA|RUANG|RUANGAN|DOKTER|DPJP|PEMERIKSAAN|KLINIS|STATUS|SEP|RM|REGISTER|POLI|KELAS|LAHIR|AGAMA|PEKERJAAN)\b/i;
  const nama = m[1].split(LABEL_BERIKUT)[0].replace(/\s+/g, " ").trim();
  // Kata "Nama" paling sering muncul justru sebagai JUDUL KOLOM tabel obat
  // ("Nama Obat Oral", "Nama Obat Injeksi"), bukan sebagai nama pasien. Di
  // data produksi inilah sumber terbesar salah tuduh "pasien berbeda".
  // "Nama Faskes RS ..." (layar aplikasi rujukan/skrining) dan "Nama Ibu/Ayah"
  // (data bayi baru lahir) bukan nama pasien -- dulu halaman skrining bayi
  // YETY NOVIATI dituduh milik pasien lain karena "Faskes RS LESTARI RAHARJA".
  const BUKAN_ORANG = /^(OBAT|TINDAKAN|BARANG|JENIS|PERAWATAN|RUANG|RUANGAN|PERUSAHAAN|BERKAS|FILE|LAYANAN|PEMERIKSAAN|PRODUK|ALAT|DIAGNOSA|TARIF|KELAS|POLI|KAMAR|INFUS|INTUS|CAIRAN|TERANG|DOKTER|PETUGAS|FASKES|RS|RSU|RSUD|RUMAH|PUSKESMAS|KLINIK|INSTANSI|IBU|AYAH|SUAMI|ISTRI|WALI|KELUARGA|PENANGGUNG|DPJP|PERAWAT|BIDAN)\b/i;
  if (BUKAN_ORANG.test(nama)) return null;

  // Nama orang yang terbaca utuh selalu punya setidaknya satu kata utuh.
  // Potongan seperti "ora" tidak layak dipakai menilai identitas siapa pun.
  // Label "Nama Peserta" kadang terbaca meleset ("Peseria") sehingga lolos
  // dari pola label dan ikut terbawa sebagai nilainya.
  if (jarakEdit(nama.toUpperCase(), "PESERTA") <= 2 || jarakEdit(nama.toUpperCase(), "PASIEN") <= 2) return null;

  const kataUtuh = nama.split(" ").filter(k => k.length >= 3);
  if (!kataUtuh.length) return null;

  // Nama satu kata harus cukup panjang. Nama tunggal memang lazim di
  // Indonesia, tapi potongan tiga huruf seperti "ora" lebih mungkin sisa
  // OCR daripada nama seseorang.
  if (kataUtuh.length === 1 && kataUtuh[0].length < 4) return null;

  return nama.length >= 3 ? nama : null;
}

// --- Bayi baru lahir dari pasien yang diklaim ---

const TANDA_BAYI = /\b(?:by\.?\s*ny|bayi\s+(?:ny|nyonya)|neonatus|neonatal|bayi\s+baru\s+lahir|nama\s+ibu|skrining\s+hipotiroid|telah\s+lahir)\b/i;

function halamanBayiPasien(teks, namaKlaim) {
  if (!namaKlaim || !TANDA_BAYI.test(teks)) return false;
  // Nama ibu (= pasien yang diklaim) harus tertulis di halaman itu: semua
  // kata nama yang >= 3 huruf ada di teks, toleran salah baca satu huruf.
  const kataTeks = String(teks).toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const kataNama = String(namaKlaim).toUpperCase().replace(/\b(NY|NN|TN|AN|BY|SDR|NONA|NYONYA)\b\.?/g, ' ')
    .split(/[^A-Z]+/).filter(k => k.length >= 3);
  return kataNama.length > 0 && kataNama.every(k => kataTeks.some(t => kataMirip(k, t)));
}

// --- Pemeriksaan utama ---

/**
 * Periksa apakah setiap halaman benar milik pasien yang diklaim.
 *
 * @param {Array<{page_number: number, ocr_text: string}>} halaman
 * @param {{nama_pasien: string, mrn: string}} klaim identitas dari berkas klaim
 * @returns {Array<{page_number, jenis, keparahan, pesan, ditemukan, diharapkan}>}
 */
function verifikasiIdentitas(halaman, klaim) {
  const temuan = [];
  const namaKlaim = klaim && klaim.nama_pasien;
  const rmKlaim = klaim && klaim.mrn ? String(klaim.mrn).trim() : null;

  for (const hal of halaman || []) {
    const teks = hal && hal.ocr_text;
    if (!teks) continue;
    // Bayi yang lahir pada episode ini (assesmen neonatus, skrining bayi baru
    // lahir, surat kelahiran) memang punya No RM sendiri, tetapi berkasnya
    // bagian dari klaim persalinan ibunya -- bukan halaman pasien lain.
    if (halamanBayiPasien(teks, namaKlaim)) continue;
    const namaHal = ekstrakNama(teks);
    const rmHal = ekstrakNoRm(teks);
    const cocokNama = namaHal && namaKlaim ? namaCocok(namaKlaim, namaHal) : null;

    // Nama yang jelas berbeda adalah sinyal terkuat bahwa halaman ini milik
    // orang lain. Ini satu-satunya temuan yang diperlakukan berat.
    if (cocokNama === false) {
      // Nama yang tidak cocok SAJA bukan bukti cukup. Di data produksi, nama
      // pasien yang sama bisa terbaca hancur ("goukThan MAnGEL HAN" untuk
      // "LEONATHAN MARCEL H"), sehingga tuduhan berdasarkan nama semata
      // membanjiri petugas dengan alarm palsu -- dan alarm yang sering salah
      // akan diabaikan juga ketika ia benar.
      //
      // Karena itu keparahan tinggi menuntut DUA sinyal yang berdiri sendiri:
      // nama tidak cocok DAN No RM yang berbeda. Halaman milik pasien lain
      // hampir selalu membawa keduanya sekaligus.
      const rmJugaBeda = rmHal && rmKlaim && rmHal !== rmKlaim
        && !kemungkinanSalahBacaRm(rmHal, rmKlaim);

      if (rmJugaBeda) {
        temuan.push({
          page_number: hal.page_number, jenis: "identitas_berbeda", keparahan: "tinggi",
          pesan: "Nama dan No RM di halaman ini sama-sama tidak cocok dengan pasien yang diklaim. Periksa apakah halaman ini milik pasien lain.",
          ditemukan: namaHal + " / RM " + rmHal,
          diharapkan: namaKlaim + " / RM " + rmKlaim,
        });
      } else {
        temuan.push({
          page_number: hal.page_number, jenis: "nama_tidak_cocok", keparahan: "rendah",
          pesan: "Nama di halaman ini tidak cocok dengan pasien yang diklaim, tetapi No RM-nya tidak menguatkan. Sering kali ini hasil pembacaan OCR yang buruk, bukan halaman pasien lain.",
          ditemukan: namaHal, diharapkan: namaKlaim,
        });
      }
      continue; // nama sudah jadi pokok temuannya, No RM tidak perlu diadukan lagi
    }

    if (!rmHal || !rmKlaim || rmHal === rmKlaim) continue;

    // Selisih satu digit pada panjang yang sama hampir selalu salah baca OCR,
    // bukan nomor yang benar-benar lain.
    if (kemungkinanSalahBacaRm(rmHal, rmKlaim)) {
      temuan.push({
        page_number: hal.page_number, jenis: "rm_kemungkinan_salah_baca", keparahan: "rendah",
        pesan: "No RM di halaman ini beda satu digit dari No RM klaim. Kemungkinan besar salah baca OCR, bukan pasien lain.",
        ditemukan: rmHal, diharapkan: rmKlaim,
      });
      continue;
    }

    // Nama cocok tapi No RM lain: lazim pada dokumen rujukan dari faskes lain,
    // yang membawa nomor rekam medis faskes tersebut. Bukan masalah, tapi
    // tetap dicatat supaya asal dokumennya terlihat.
    if (cocokNama === true) {
      temuan.push({
        page_number: hal.page_number, jenis: "rm_faskes_lain", keparahan: "info",
        pesan: "No RM berbeda tetapi nama pasien cocok. Lazimnya dokumen dari faskes lain yang memakai nomor rekam medis mereka sendiri.",
        ditemukan: rmHal, diharapkan: rmKlaim,
      });
      continue;
    }

    // No RM lain dan namanya tidak terbaca sama sekali -- tidak bisa
    // dipastikan, jadi diserahkan ke manusia alih-alih ditebak.
    temuan.push({
      page_number: hal.page_number, jenis: "rm_berbeda_nama_tak_terbaca", keparahan: "sedang",
      pesan: "No RM di halaman ini berbeda dan nama pasien tidak terbaca, sehingga tidak bisa dipastikan halaman ini milik siapa. Perlu diperiksa manual.",
      ditemukan: rmHal, diharapkan: rmKlaim,
    });
  }

  return temuan;
}
module.exports = {
  verifikasiIdentitas,
  ekstrakNama,
  normalisasiNama,
  namaCocok,
  jarakEdit,
  ekstrakNoRm,
  kemungkinanSalahBacaRm,
};
