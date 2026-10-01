/**
 * Mesin pencarian kode diagnosis (ICD-10 WHO) / prosedur (ICD-9-CM) --
 * SISTEM BARU & PARALEL terhadap alur suggested_codes lama
 * (kodeDiagnosisWhoService.js / kodeTindakanBaruService.js / aiReviewService.js).
 * Modul-modul lama TIDAK disentuh dan TIDAK disambungkan ke sini.
 *
 * Membangun layer 1-3 dari waterfall pencarian kode di catatan produk.
 * Layer 4 (kemiripan makna / embedding, pgvector) TIDAK dibangun -- extension
 * `vector` tidak tersedia sama sekali di image Postgres produksi saat ini.
 * Kolom `embedding vector(1536)` di `ref_istilah_kode` HANYA komentar/TODO,
 * bukan DDL nyata (lihat ensureSchema di bawah) -- membuat kolom bertipe
 * `vector` akan membuat seluruh ensureSchema gagal karena tipe itu tidak ada.
 *
 * ATURAN KERAS yang dijaga modul ini (lihat HANDOFF.md):
 *  - Tidak pernah mengarang kode. Setiap kandidat yang dikembalikan WAJIB
 *    sudah di-JOIN ke `ref_kode`, yang HANYA diisi dari `icd10_who_codes` /
 *    `icd9_cm_procedures` (lihat seedDariTabelReferensi). Kalau join gagal
 *    (kode di ref_istilah_kode/kamus_lokal_kode tidak ada di ref_kode), baris
 *    itu DIBUANG, bukan ditampilkan dengan judul kosong -- itu bug seed, bukan
 *    hasil yang boleh ditampilkan ke koder.
 *
 * WATERFALL (lihat cariKandidatKode):
 *   Layer 1 "Pasti" -- kamus lokal RS ini (kamus_lokal_kode), persis sama
 *     tulisan yang sudah pernah disetujui koder RS ini sebelumnya.
 *   Layer 2 "Kuat" -- degradasi yang JUJUR dari "indeks alfabetis ICD-10
 *     Volume 3" yang diminta catatan produk asli: kita TIDAK punya dataset
 *     indeks/inklusi WHO (istilah seperti "Hyperpyrexia NOS" di bawah R50.9
 *     tidak ada di data kita, sudah dicek langsung). Yang kita punya cuma
 *     JUDUL kode (`ref_istilah_kode` jenis='judul', dari deskripsi
 *     icd10_who_codes/icd9_cm_procedures). Jadi layer ini cuma mencocokkan
 *     tulisan dengan JUDUL kode (persis atau mengandung), bukan indeks
 *     Volume 3 yang sesungguhnya. `jenis` 'inklusi'/'indeks'/'sinonim_id'
 *     sengaja dibiarkan kosong -- pekerjaan lanjutan kalau dataset itu ada,
 *     seedDariTabelReferensi menerima daftar istilah tambahan tanpa ubah skema.
 *   Layer 3 "Sedang" -- kemiripan trigram (pg_trgm) terhadap judul kode.
 *     Separuh dari query "skor gabungan" di catatan produk asli (trigram +
 *     embedding) -- separuh embedding dibuang (layer 4, lihat atas).
 *   BERHENTI di layer pertama yang mengembalikan hasil (tidak lanjut ke
 *   layer berikutnya kalau layer sebelumnya sudah dapat kandidat).
 */

const ambangKlinisService = require('./ambangKlinisService');

const SISTEM = Object.freeze({ ICD10: 'icd10_2010', ICD9: 'icd9cm_2010' });
const SISTEM_VALID = Object.freeze([SISTEM.ICD10, SISTEM.ICD9]);

// Dapat diubah: jumlah maksimum kandidat yang dikembalikan per pencarian.
const MAKS_KANDIDAT = 5;
// Dapat diubah: ambang similarity minimum pg_trgm (0..1) layer 3 supaya hasil
// sampah (mis. kesamaan kebetulan 2-3 huruf) tidak ikut tampil.
const AMBANG_SKOR_LAYER3 = 0.3;

// ───────────────────────── normalisasi istilah ─────────────────────────────

/**
 * Samakan bentuk istilah untuk pencocokan & kolom istilah_rapi: NFKC dulu
 * (melebur ligatur hasil ekstraksi PDF, mis. "ﬁbrosis" -> "fibrosis"), lalu
 * lucuti tanda aksen (NFD + buang diakritik), huruf kecil, tanda baca -> spasi,
 * spasi dirapatkan. Gaya ini meniru kamusPenunjangService.rapikan (modul lain,
 * TIDAK dipakai bersama -- lihat catatan di sana) supaya konsisten, tapi
 * ditulis ulang di sini karena ini modul terpisah dengan domain beda (judul
 * kode, bukan singkatan medis bertabrakan).
 */
function normalisasiIstilah(teks) {
  return String(teks || '')
    .normalize('NFKC')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────── heuristik ref_kode ───────────────────────────────
// Semua fungsi di bawah murni (tidak menyentuh DB) supaya bisa diuji dengan
// data contoh kecil, terpisah dari query 18 ribu baris asli.

/**
 * Tandai kode yang punya turunan (kode anak yang lebih spesifik), mis. "R10"
 * punya turunan karena ada "R10.0", "R10.1", dst.
 *
 * CARA KERJA: urutkan semua kode (string sort biasa), lalu untuk tiap kode
 * cek apakah kode BERIKUTNYA dalam urutan diawali kode itu sendiri (prefix
 * string, lebih panjang). Ini valid untuk format ICD-10 WHO maupun ICD-9-CM
 * Vol.3 yang kita pakai karena SEMUA kode anak adalah perluasan string dari
 * kode induknya (baik lewat titik baru "R10" -> "R10.0", maupun lewat digit
 * tambahan tanpa titik baru "00.0" -> "00.01") -- dan dalam urutan string,
 * seluruh kode yang berbagi prefix itu SELALU mengelompok tepat setelah induk,
 * sebelum kode "saudara" berikutnya yang berbeda. Diverifikasi terhadap data
 * nyata (18.549 kode ICD-10 + 4.626 ICD-9) sebelum dipakai: tidak ditemukan
 * kode yang format panjangnya tanpa titik di luar level kategori, jadi tidak
 * ada tabrakan prefix palsu.
 */
function tandaiPunyaTurunan(daftarKode) {
  const sorted = [...new Set(daftarKode)].sort();
  const hasil = new Set();
  for (let i = 0; i < sorted.length - 1; i++) {
    const ini = sorted[i];
    const berikut = sorted[i + 1];
    if (berikut.length > ini.length && berikut.startsWith(ini)) hasil.add(ini);
  }
  return hasil;
}

/** V01-Y98 (bab XX, "External causes of morbidity and mortality") -- derivable langsung dari kode. */
function deriveSebabLuar(kode) {
  return /^[VWXY]\d/.test(String(kode || ''));
}

/**
 * Bab R (XVIII, "Symptoms, signs and abnormal clinical and laboratory
 * findings") = kode gejala, bukan diagnosis pasti. Dicek dua cara (prefix
 * kode ATAU chapter_number) supaya tetap benar walau salah satu kosong.
 */
function deriveKodeGejala({ kode, chapterNumber } = {}) {
  return chapterNumber === 'XVIII' || /^R/i.test(String(kode || ''));
}

/**
 * Jenis kelamin & umur untuk kode ICD-10 dari chapter_number:
 *  - Bab XV ("Pregnancy, childbirth and the puerperium", kode O..) -> wajib
 *    jenis_kelamin 'P'. Ini bab kehamilan, bukan heuristik per-kode (semua
 *    kode di bab ini memang eksklusif perempuan).
 *  - Bab XVI ("Certain conditions originating in the perinatal period", kode
 *    P..) -> batas usia. HEURISTIK SENGAJA KONSERVATIF: masa perinatal baku
 *    sebenarnya 0-28 hari, tapi kolom umur_min/umur_maks di sini berSATUAN
 *    TAHUN (konvensi paling sederhana untuk kolom INT tanpa kolom satuan
 *    terpisah), jadi "0-28 hari" dibulatkan ke ATAS menjadi umur_min=0,
 *    umur_maks=1 tahun -- sengaja longgar (bukan 0 tahun persis) supaya rule
 *    yang memakai ini tidak salah menolak kasus bayi berumur sedikit di atas
 *    28 hari yang masih wajar dikode dengan kode bab ini di praktik lapangan.
 *    DOKUMENTASIKAN KE PRODUCT OWNER kalau butuh presisi hari, bukan tahun.
 *  - Bab lain -> tidak ditentukan (null), termasuk kondisi khusus-jenis-kelamin
 *    di luar bab O (mis. N40 prostat, N70-98 organ reproduksi perempuan) --
 *    SENGAJA TIDAK dicoba, karena itu butuh parsing rentang kode per-bab yang
 *    lebih rumit dan berisiko salah tanpa sumber rujukan yang bisa dicek balik.
 */
function deriveUsiaKelaminIcd10({ chapterNumber } = {}) {
  if (chapterNumber === 'XV') return { jenisKelamin: 'P', umurMin: null, umurMaks: null };
  if (chapterNumber === 'XVI') return { jenisKelamin: null, umurMin: 0, umurMaks: 1 };
  return { jenisKelamin: null, umurMin: null, umurMaks: null };
}

/**
 * Jenis kelamin untuk prosedur ICD-9-CM dari nama blok (field `block`, bukan
 * bagian resmi kode, lihat migrasi 005). Hanya dua blok yang namanya secara
 * eksplisit menyebut jenis kelamin; blok lain (termasuk yang implisit
 * spesifik-jenis-kelamin tanpa nama eksplisit) dibiarkan null -- sama alasan
 * dengan ICD-10 di atas, tidak mau menebak tanpa sinyal nama yang jelas.
 */
function deriveJenisKelaminIcd9DariBlok(block) {
  if (block === 'Operations on the Male Genital Organs') return 'L';
  if (block === 'Operations on the Female Genital Organs') return 'P';
  return null;
}

// Asterisk (kode dagger-asterisk WHO): dataset sumber kita (lihat
// icd10_who_dictionary.json meta) TIDAK menandai ini sama sekali -- tidak ada
// karakter '*'/'+' pada kode mana pun (dicek: 0 dari 18.549). Tidak ada
// pola/sinyal lain yang bisa diandalkan untuk menebak per-kode, jadi SELALU
// FALSE, didokumentasikan sebagai keterbatasan data, bukan logika yang hilang.
function deriveAsterisk() {
  return false;
}

// ───────────────────────── ensureSchema ────────────────────────────────────

async function ensureSchema(db) {
  // pg_trgm WAJIB untuk layer 3 (similarity + index gin_trgm_ops). Tersedia
  // di image produksi (dikonfirmasi), tinggal diaktifkan.
  await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  await db.query(`
    CREATE TABLE IF NOT EXISTS ref_kode (
      kode VARCHAR(8) PRIMARY KEY,
      sistem VARCHAR(12) NOT NULL,
      judul TEXT,
      punya_turunan BOOLEAN NOT NULL DEFAULT FALSE,
      jenis_kelamin CHAR(1),
      umur_min INT,
      umur_maks INT,
      asterisk BOOLEAN NOT NULL DEFAULT FALSE,
      sebab_luar BOOLEAN NOT NULL DEFAULT FALSE,
      kode_gejala BOOLEAN NOT NULL DEFAULT FALSE
      -- embedding vector(1536) -- TODO layer 4: extension 'vector' TIDAK
      -- tersedia di image Postgres ini. JANGAN tambah kolom bertipe vector
      -- sebelum extension-nya ada -- CREATE TABLE ini akan gagal total kalau
      -- tipe itu tidak dikenal Postgres.
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_ref_kode_sistem ON ref_kode(sistem)');

  await db.query(`
    CREATE TABLE IF NOT EXISTS ref_istilah_kode (
      id SERIAL PRIMARY KEY,
      kode VARCHAR(8) NOT NULL,
      sistem VARCHAR(12) NOT NULL CHECK (sistem IN ('icd10_2010','icd9cm_2010')),
      istilah TEXT NOT NULL,
      jenis VARCHAR(12) NOT NULL CHECK (jenis IN ('judul','inklusi','indeks','sinonim_id')),
      istilah_rapi TEXT NOT NULL
      -- embedding vector(1536) -- TODO layer 4, sama seperti ref_kode di atas.
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_ref_istilah_kode_trgm ON ref_istilah_kode USING gin (istilah_rapi gin_trgm_ops)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_ref_istilah_kode_sistem ON ref_istilah_kode (sistem, jenis)');
  // Index UNIK tambahan -- BUKAN bagian skema literal dari catatan produk,
  // ditambahkan karena tabel ini tidak punya primary key alami dan
  // seedDariTabelReferensi harus idempoten (ON CONFLICT butuh target unik).
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_ref_istilah_kode ON ref_istilah_kode (kode, sistem, jenis, istilah_rapi)');

  await db.query(`
    CREATE TABLE IF NOT EXISTS kamus_lokal_kode (
      rs_id TEXT NOT NULL,
      tulisan_rapi TEXT NOT NULL,
      kode VARCHAR(8) NOT NULL,
      jumlah_disetujui INT NOT NULL DEFAULT 1,
      terakhir_disetujui TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (rs_id, tulisan_rapi, kode)
    )
  `);

  // ambang_klinis dimiliki ambangKlinisService (termasuk seed nilai awal) --
  // dipanggil dari sini supaya pemanggil cuma perlu SATU titik wiring
  // (ensureSchema modul ini) untuk keempat tabel.
  await ambangKlinisService.ensureSchema(db);
}

// ───────────────────────── seedDariTabelReferensi ──────────────────────────

async function seedRefKodeDariSumber(db, { tabel, kolomSelect, sistem, hitungAtribut }) {
  const baris = await db.all(`SELECT ${kolomSelect} FROM ${tabel}`);
  const turunan = tandaiPunyaTurunan(baris.map((b) => b.code));
  for (const b of baris) {
    const atribut = hitungAtribut(b);
    await db.run(
      `INSERT INTO ref_kode (kode, sistem, judul, punya_turunan, jenis_kelamin, umur_min, umur_maks, asterisk, sebab_luar, kode_gejala)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kode) DO NOTHING`,
      [
        b.code, sistem, atribut.judul, turunan.has(b.code),
        atribut.jenisKelamin, atribut.umurMin, atribut.umurMaks,
        deriveAsterisk(), deriveSebabLuar(b.code), deriveKodeGejala({ kode: b.code, chapterNumber: b.chapter_number }),
      ],
    );
  }
}

async function seedRefKodeIcd10(db) {
  await seedRefKodeDariSumber(db, {
    tabel: 'icd10_who_codes',
    kolomSelect: 'code, description_en, description_id, chapter_number',
    sistem: SISTEM.ICD10,
    hitungAtribut: (b) => {
      const judul = (b.description_en && b.description_en.trim()) || (b.description_id && b.description_id.trim()) || null;
      const usiaKelamin = deriveUsiaKelaminIcd10({ chapterNumber: b.chapter_number });
      return { judul, ...usiaKelamin };
    },
  });
}

async function seedRefKodeIcd9(db) {
  await seedRefKodeDariSumber(db, {
    tabel: 'icd9_cm_procedures',
    kolomSelect: 'code, description_en, block',
    sistem: SISTEM.ICD9,
    hitungAtribut: (b) => ({
      judul: (b.description_en && b.description_en.trim()) || null,
      jenisKelamin: deriveJenisKelaminIcd9DariBlok(b.block),
      umurMin: null,
      umurMaks: null,
    }),
  });
}

async function insertIstilah(db, { kode, sistem, istilah, jenis = 'judul' }) {
  if (!istilah || !istilah.trim()) return;
  const rapi = normalisasiIstilah(istilah);
  if (!rapi) return;
  await db.run(
    `INSERT INTO ref_istilah_kode (kode, sistem, istilah, jenis, istilah_rapi)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kode, sistem, jenis, istilah_rapi) DO NOTHING`,
    [kode, sistem, istilah.trim(), jenis, rapi],
  );
}

async function seedRefIstilahIcd10(db) {
  const baris = await db.all('SELECT code, description_en, description_id FROM icd10_who_codes');
  for (const b of baris) {
    await insertIstilah(db, { kode: b.code, sistem: SISTEM.ICD10, istilah: b.description_en });
    // description_id dimasukkan sebagai baris TERPISAH (bukan menimpa
    // description_en) supaya pencarian berbahasa Indonesia juga kena --
    // icd9_cm_procedures TIDAK punya kolom description_id sama sekali
    // (dikonfirmasi di skema migrasi 005), jadi ini khusus icd10.
    await insertIstilah(db, { kode: b.code, sistem: SISTEM.ICD10, istilah: b.description_id });
  }
}

async function seedRefIstilahIcd9(db) {
  const baris = await db.all('SELECT code, description_en FROM icd9_cm_procedures');
  for (const b of baris) {
    await insertIstilah(db, { kode: b.code, sistem: SISTEM.ICD9, istilah: b.description_en });
  }
}

/**
 * Isi ref_kode + ref_istilah_kode (jenis='judul') dari icd10_who_codes +
 * icd9_cm_procedures. Idempoten: ON CONFLICT DO NOTHING di semua insert,
 * aman dipanggil berkali-kali (mis. tiap start server, atau manual re-seed
 * setelah tabel sumber bertambah baris baru -- baris lama tidak diutak-atik).
 *
 * CELAH YANG SENGAJA DIBIARKAN (future work, didokumentasikan di sini sesuai
 * instruksi): jenis 'inklusi'/'indeks'/'sinonim_id' TIDAK diisi karena kita
 * tidak punya dataset indeks alfabetis WHO Volume 3 / daftar sinonim bahasa
 * Indonesia (dicek langsung: "Hyperpyrexia NOS" di bawah R50.9 TIDAK ada di
 * tabel sumber kita). Kalau dataset itu didapat nanti, tambahkan fungsi
 * seed baru yang memanggil insertIstilah(db, {kode, sistem, istilah, jenis})
 * dengan jenis yang sesuai -- TIDAK perlu ubah skema.
 */
async function seedDariTabelReferensi(db) {
  await seedRefKodeIcd10(db);
  await seedRefKodeIcd9(db);
  await seedRefIstilahIcd10(db);
  await seedRefIstilahIcd9(db);
}

// ───────────────────────── pencarian (waterfall) ───────────────────────────

function urutkanDanPotong(kandidat) {
  return kandidat.slice().sort((a, b) => b.skor - a.skor).slice(0, MAKS_KANDIDAT);
}

function kelompokkanPerKodeAmbilSkorTertinggi(baris) {
  const perKode = new Map();
  for (const b of baris) {
    const ada = perKode.get(b.kode);
    if (!ada || b.skor > ada.skor) perKode.set(b.kode, { kode: b.kode, sistem: b.sistem, skor: b.skor });
  }
  return [...perKode.values()];
}

/**
 * Lengkapi {kode, sistem, skor} dengan `judul` dari ref_kode, SEKALIGUS
 * membuang kode yang ternyata tidak ada di ref_kode (seharusnya tidak pernah
 * terjadi kalau seed benar -- lihat ATURAN KERAS di kepala berkas; ini jaring
 * pengaman, bukan jalur yang diharapkan kepakai).
 */
async function lengkapiJudulDariRefKode(db, kandidat) {
  if (!kandidat.length) return [];
  const tanda = kandidat.map(() => '?').join(', ');
  const baris = await db.all(`SELECT kode, judul FROM ref_kode WHERE kode IN (${tanda})`, kandidat.map((k) => k.kode));
  const judulPerKode = new Map(baris.map((b) => [b.kode, b.judul]));
  return kandidat
    .filter((k) => judulPerKode.has(k.kode))
    .map((k) => ({ kode: k.kode, sistem: k.sistem, judul: judulPerKode.get(k.kode), skor: k.skor }));
}

/**
 * Cari kandidat kode untuk satu potong tulisan (lihat waterfall di kepala
 * berkas). Berhenti di layer pertama yang menghasilkan kandidat.
 *
 * @param {object} db
 * @param {{teks:string, sistem?:'icd10_2010'|'icd9cm_2010', rsId?:string}} opsi
 *   sistem opsional -- kalau tidak diisi, cari di kedua sistem sekaligus
 *   (jarang berguna di praktik karena diagnosis & prosedur beda konteks UI,
 *   tapi tidak dilarang).
 * @returns {Promise<Array<{kode:string, sistem:string, judul:string, lapis:1|2|3, skor:number}>>}
 */
async function cariKandidatKode(db, { teks, sistem, rsId } = {}) {
  const rapi = normalisasiIstilah(teks);
  if (!rapi) return [];

  // ---- Layer 1: Pasti (kamus lokal RS ini) ----
  if (rsId) {
    const sql = sistem
      ? `SELECT k.kode, r.sistem, r.judul FROM kamus_lokal_kode k
         JOIN ref_kode r ON r.kode = k.kode
         WHERE k.rs_id = ? AND k.tulisan_rapi = ? AND r.sistem = ?
         ORDER BY k.jumlah_disetujui DESC`
      : `SELECT k.kode, r.sistem, r.judul FROM kamus_lokal_kode k
         JOIN ref_kode r ON r.kode = k.kode
         WHERE k.rs_id = ? AND k.tulisan_rapi = ?
         ORDER BY k.jumlah_disetujui DESC`;
    const params = sistem ? [rsId, rapi, sistem] : [rsId, rapi];
    const baris1 = await db.all(sql, params);
    if (baris1.length) {
      return urutkanDanPotong(baris1.map((b) => ({ kode: b.kode, sistem: b.sistem, judul: b.judul, lapis: 1, skor: 1 })));
    }
  }

  // ---- Layer 2: Kuat (cocok JUDUL kode -- degradasi dari indeks WHO Vol.3, lihat catatan atas) ----
  const sqlExact = sistem
    ? 'SELECT kode, sistem FROM ref_istilah_kode WHERE jenis = \'judul\' AND istilah_rapi = ? AND sistem = ?'
    : 'SELECT kode, sistem FROM ref_istilah_kode WHERE jenis = \'judul\' AND istilah_rapi = ?';
  const parisExact = sistem ? [rapi, sistem] : [rapi];
  const barisExact = await db.all(sqlExact, parisExact);
  if (barisExact.length) {
    const perKode = kelompokkanPerKodeAmbilSkorTertinggi(barisExact.map((b) => ({ kode: b.kode, sistem: b.sistem, skor: 1 })));
    const lengkap = await lengkapiJudulDariRefKode(db, perKode);
    if (lengkap.length) return urutkanDanPotong(lengkap.map((c) => ({ ...c, lapis: 2 })));
  }

  const sqlMirip = sistem
    ? 'SELECT kode, sistem FROM ref_istilah_kode WHERE jenis = \'judul\' AND istilah_rapi ILIKE ? AND sistem = ?'
    : 'SELECT kode, sistem FROM ref_istilah_kode WHERE jenis = \'judul\' AND istilah_rapi ILIKE ?';
  const parisMirip = sistem ? [`%${rapi}%`, sistem] : [`%${rapi}%`];
  const barisMirip = await db.all(sqlMirip, parisMirip);
  if (barisMirip.length) {
    const perKode = kelompokkanPerKodeAmbilSkorTertinggi(barisMirip.map((b) => ({ kode: b.kode, sistem: b.sistem, skor: 0.8 })));
    const lengkap = await lengkapiJudulDariRefKode(db, perKode);
    if (lengkap.length) return urutkanDanPotong(lengkap.map((c) => ({ ...c, lapis: 2 })));
  }

  // ---- Layer 3: Sedang (pg_trgm similarity terhadap judul) ----
  const sqlTrgm = sistem
    ? `SELECT kode, sistem, similarity(istilah_rapi, ?) AS skor
       FROM ref_istilah_kode WHERE jenis = 'judul' AND sistem = ? AND istilah_rapi % ?`
    : `SELECT kode, sistem, similarity(istilah_rapi, ?) AS skor
       FROM ref_istilah_kode WHERE jenis = 'judul' AND istilah_rapi % ?`;
  const parisTrgm = sistem ? [rapi, sistem, rapi] : [rapi, rapi];
  const barisTrgm = await db.all(sqlTrgm, parisTrgm);
  const diAtasAmbang = barisTrgm.filter((b) => Number(b.skor) >= AMBANG_SKOR_LAYER3);
  const perKode3 = kelompokkanPerKodeAmbilSkorTertinggi(diAtasAmbang.map((b) => ({ kode: b.kode, sistem: b.sistem, skor: Number(b.skor) })));
  const lengkap3 = await lengkapiJudulDariRefKode(db, perKode3);
  return urutkanDanPotong(lengkap3.map((c) => ({ ...c, lapis: 3 })));
}

// ───────────────────────── persetujuan koder (belajar bulanan) ────────────

/**
 * Catat/naikkan persetujuan koder untuk satu pasangan tulisan->kode di RS ini
 * (mekanisme "belajar tiap bulan" dari catatan produk -- jadi semakin sering
 * koder menyetujui pasangan ini, Layer 1 makin cepat menemukannya nanti).
 */
async function simpanPersetujuanKoder(db, { rsId, tulisanRapi, kode } = {}) {
  if (!rsId || !String(rsId).trim()) throw new Error('rsId wajib diisi');
  if (!tulisanRapi || !String(tulisanRapi).trim()) throw new Error('tulisanRapi wajib diisi');
  if (!kode || !String(kode).trim()) throw new Error('kode wajib diisi');

  const rapi = normalisasiIstilah(tulisanRapi);
  if (!rapi) throw new Error('tulisanRapi tidak valid setelah dinormalisasi');
  const kodeTrim = String(kode).trim();

  // Jangan pernah mengarang/menyimpan kode yang tidak berasal dari kamus resmi.
  const ada = await db.get('SELECT kode FROM ref_kode WHERE kode = ?', [kodeTrim]);
  if (!ada) throw new Error(`Kode ${kodeTrim} tidak ditemukan di ref_kode -- tidak boleh menyimpan kode yang tidak berasal dari icd10_who_codes/icd9_cm_procedures`);

  await db.run(
    `INSERT INTO kamus_lokal_kode (rs_id, tulisan_rapi, kode, jumlah_disetujui, terakhir_disetujui)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT (rs_id, tulisan_rapi, kode) DO UPDATE
       SET jumlah_disetujui = kamus_lokal_kode.jumlah_disetujui + 1,
           terakhir_disetujui = CURRENT_TIMESTAMP`,
    [String(rsId).trim(), rapi, kodeTrim],
  );
  return { rsId: String(rsId).trim(), tulisanRapi: rapi, kode: kodeTrim };
}

module.exports = {
  SISTEM,
  SISTEM_VALID,
  MAKS_KANDIDAT,
  AMBANG_SKOR_LAYER3,
  normalisasiIstilah,
  tandaiPunyaTurunan,
  deriveSebabLuar,
  deriveKodeGejala,
  deriveUsiaKelaminIcd10,
  deriveJenisKelaminIcd9DariBlok,
  deriveAsterisk,
  ensureSchema,
  seedDariTabelReferensi,
  cariKandidatKode,
  simpanPersetujuanKoder,
  // diteruskan supaya pemanggil tidak perlu require dua modul terpisah
  terjemahkanAmbangKlinis: ambangKlinisService.terjemahkanAmbangKlinis,
};
