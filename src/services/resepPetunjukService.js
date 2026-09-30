/**
 * Petunjuk dari resep (tipe 3: salah tafsir; resep bukan diagnosis).
 *
 * Resep hanya memberi PETUNJUK berbentuk pertanyaan untuk koder/dokter, mis.
 * sukralfat -> "apakah ada gangguan lambung yang belum dicatat?". Modul ini
 * TIDAK PERNAH menambah diagnosis dan tidak mengeluarkan kode ICD apa pun:
 * setiap petunjuk membawa `menambah_diagnosis: false` dan `kode: null`.
 *
 * Isi kamus: src/data/kamusObat.json (merek -> generik -> golongan). Entri yang
 * belum dipastikan diberi terverifikasi:false dan tetap ditandai demikian.
 * Obat simtomatik (kelompok nyeri_demam) tidak memberi petunjuk penyakit.
 *
 * Pengurai aturan pakai: 3dd1, 3x1, 3 dd 1/2, prn, k/p, s.n., a.c., p.c., h.s.,
 * "sebelum/sesudah makan", "5 hari".
 *
 * STATUS: modul murni, teruji dengan teks tiruan. Tersambung ke alur AI review
 * lewat pagarPascaAiService (field ai_review.petunjuk_resep, saklar
 * PETUNJUK_RESEP_AKTIF) HANYA pada baris di bagian terapi/resep. Daftar obat
 * pada berkas RS berupa tabel berkolom yang sulit dibaca OCR, jadi kualitas
 * masukan teksnya masih harus diuji pada PDF asli.
 */

const KAMUS = require('../data/kamusObat.json');
const { rapikan } = require('./kamusPenunjangService');

// ── indeks nama obat ────────────────────────────────────────────────────────
const indeksNama = new Map(); // nama_rapi -> [entri]
const MAKS_KATA_NAMA = 3;

function daftarkan(nama, entri) {
  const kunci = rapikan(nama);
  if (!kunci || kunci.length < 4) return; // terlalu pendek: rawan salah kenal
  const ada = indeksNama.get(kunci) || [];
  if (!ada.includes(entri)) ada.push(entri);
  indeksNama.set(kunci, ada);
}
for (const e of KAMUS.obat) {
  (e.merek || []).forEach(m => daftarkan(m, e));
  if (e.generik) daftarkan(e.generik, e);
}

// ── aturan pakai ────────────────────────────────────────────────────────────
const PECAHAN = { '½': 0.5, '¼': 0.25, '¾': 0.75 };

function angkaDosis(teks) {
  const t = String(teks).replace(',', '.').trim();
  let m = /^(\d+)\s*([½¼¾])$/.exec(t);
  if (m) return Number(m[1]) + PECAHAN[m[2]];
  if (PECAHAN[t] != null) return PECAHAN[t];
  m = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (m && Number(m[2]) !== 0) return Number(m[1]) / Number(m[2]);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Urai aturan pakai obat.
 * @param {string} teks mis. "3dd1 pc", "3 x 1/2 tab sesudah makan", "prn"
 */
function parseAturanPakai(teks) {
  const s = String(teks || '');
  const kecil = s.toLowerCase();
  const hasil = {
    aturan_teks: s.trim(),
    frekuensi_per_hari: null,
    dosis_per_kali: null,
    dosis_angka: null,
    prn: false,
    alasan_prn: null,
    waktu: null,
    durasi_hari: null,
    dikenali: false,
  };

  const f = /(\d{1,2})\s*(?:dd|x|×|kali)\s*(?:sehari\s*)?(\d+\s*[½¼¾]|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?|[½¼¾])/i.exec(s);
  if (f) {
    hasil.frekuensi_per_hari = Number(f[1]);
    hasil.dosis_per_kali = f[2].replace(/\s+/g, '');
    hasil.dosis_angka = angkaDosis(f[2]);
    hasil.dikenali = true;
  }

  // Pemakaian bila perlu. "sn" dan "kp" sengaja dibatasi batas kata supaya
  // tidak menangkap potongan kata lain.
  if (/(?<![a-z])prn(?![a-z])/i.test(kecil)) { hasil.prn = true; hasil.alasan_prn = 'prn'; }
  else if (/(?<![a-z])k\s*\/\s*p(?![a-z])|(?<![a-z])k\.\s?p\.?(?![a-z])|kalau\s+perlu|bila\s+perlu|jika\s+perlu/i.test(kecil)) { hasil.prn = true; hasil.alasan_prn = 'k/p'; }
  else if (/(?<![a-z])s\.\s?n\.?(?![a-z])|(?<![a-z])sn(?![a-z])|(?<![a-z])s\.?o\.?s\.?(?![a-z])/i.test(kecil)) { hasil.prn = true; hasil.alasan_prn = 's.n.'; }
  if (hasil.prn) hasil.dikenali = true;

  if (/(?<![a-z])a\.\s?c\.?(?![a-z])|(?<![a-z])ac(?![a-z])|sebelum\s+makan/i.test(kecil)) hasil.waktu = 'sebelum_makan';
  else if (/(?<![a-z])p\.\s?c\.?(?![a-z])|(?<![a-z])pc(?![a-z])|sesudah\s+makan|setelah\s+makan/i.test(kecil)) hasil.waktu = 'sesudah_makan';
  else if (/(?<![a-z])h\.\s?s\.?(?![a-z])|(?<![a-z])hs(?![a-z])|sebelum\s+tidur/i.test(kecil)) hasil.waktu = 'sebelum_tidur';
  if (hasil.waktu) hasil.dikenali = true;

  const d = /(\d{1,3})\s*hari/i.exec(s);
  if (d) { hasil.durasi_hari = Number(d[1]); hasil.dikenali = true; }

  return hasil;
}

// ── mencocokkan obat ────────────────────────────────────────────────────────
/** Cari entri kamus pada satu baris resep. Frasa terpanjang menang. */
function cariObat(baris) {
  const kata = rapikan(baris).split(' ').filter(Boolean);
  for (let panjang = Math.min(MAKS_KATA_NAMA, kata.length); panjang >= 1; panjang--) {
    for (let i = 0; i + panjang <= kata.length; i++) {
      const frasa = kata.slice(i, i + panjang).join(' ');
      const ada = indeksNama.get(frasa);
      if (ada) return { entri: ada[0], ditulis: frasa, ambigu: ada.length > 1 };
    }
  }
  return null;
}

// Kata kunci diagnosis yang menandakan kelompok itu SUDAH dicatat.
const KATA_DIAGNOSIS = {
  lambung: /gastritis|dispepsia|dyspepsia|gerd|refluks|reflux|tukak|ulkus|ulcer|lambung|gastro/i,
  napas: /asma|asthma|ppok|copd|bronkitis|bronchitis|pneumonia|bronkopneumonia|bronkiolitis|napas/i,
  hipertensi: /hipertensi|hypertension|\bhtn\b|tekanan darah tinggi/i,
  diabetes: /diabetes|\bdm\b|kencing manis/i,
  jantung_cairan: /gagal jantung|heart failure|\bchf\b|edema|oedema|hipertensi|hypertension|\bckd\b|gagal ginjal/i,
  infeksi: /infeksi|infection|pneumonia|sepsis|demam tifoid|tifoid|\bispa\b|\bisk\b|faringitis|tonsilitis|otitis|selulitis|abses|diare|gastroenteritis|\btb\b|tuberkulosis|dengue|\bdbd\b/i,
  mual_muntah: /mual|muntah|nausea|vomit|gastroenteritis|dispepsia|dyspepsia|gastritis/i,
  alergi: /alergi|allerg|urtikaria|dermatitis|rinitis/i,
};

/**
 * Susun petunjuk dari teks resep.
 *
 * @param {string} teksResep baris resep (satu obat per baris)
 * @param {{teksDiagnosis?: string}} [opsi] teks blok diagnosis; bila kelompok
 *   sudah tercatat di sana, petunjuk menjadi catatan "konsisten", bukan pertanyaan
 * @returns {{petunjuk: Array, obat_tidak_dikenali: string[], baris: Array}}
 */
function petunjukDariResep(teksResep, { teksDiagnosis = '' } = {}) {
  const petunjuk = [];
  const tidakDikenali = [];
  const barisHasil = [];
  const sudahAda = new Set();

  for (const mentah of String(teksResep || '').split('\n')) {
    const baris = mentah.replace(/^\s*(?:\d+[.)]\s*)?(?:r\s*\/\s*)?/i, '').trim();
    if (baris.length < 3) continue;
    const cocok = cariObat(baris);
    const aturan = parseAturanPakai(baris);
    if (!cocok) {
      // Baris beraturan pakai tetapi obatnya tak dikenal: catat, jangan buang.
      if (aturan.dikenali) tidakDikenali.push(baris.slice(0, 80));
      continue;
    }
    const e = cocok.entri;
    barisHasil.push({ obat_ditulis: cocok.ditulis, id: e.id, generik: e.generik, golongan: e.golongan, terverifikasi: e.terverifikasi === true, aturan });

    const pertanyaan = KAMUS.kelompok[e.kelompok];
    if (!pertanyaan) continue; // simtomatik: bukan petunjuk penyakit
    const kunciUnik = e.kelompok;
    if (sudahAda.has(kunciUnik)) continue; // satu petunjuk per kelompok
    sudahAda.add(kunciUnik);

    const sudahTercatat = KATA_DIAGNOSIS[e.kelompok] ? KATA_DIAGNOSIS[e.kelompok].test(String(teksDiagnosis)) : false;
    petunjuk.push(Object.freeze({
      jenis: 'petunjuk_resep',
      obat_ditulis: cocok.ditulis,
      generik: e.generik,
      golongan: e.golongan,
      kelompok: e.kelompok,
      pertanyaan: sudahTercatat ? null : pertanyaan,
      catatan: sudahTercatat ? 'Terapi ini sejalan dengan diagnosis yang sudah tercatat.' : null,
      sudah_tercatat_di_diagnosis: sudahTercatat,
      kekuatan: aturan.prn ? 'lemah' : 'sedang', // obat bila perlu lemah sebagai penanda penyakit
      terverifikasi: e.terverifikasi === true,
      aturan_pakai: aturan,
      // Kunci pengaman: resep tidak pernah menambah diagnosis.
      menambah_diagnosis: false,
      kode: null,
    }));
  }

  return { petunjuk, obat_tidak_dikenali: tidakDikenali, baris: barisHasil };
}

module.exports = { parseAturanPakai, cariObat, petunjukDariResep, KAMUS_OBAT: KAMUS, KATA_DIAGNOSIS };
