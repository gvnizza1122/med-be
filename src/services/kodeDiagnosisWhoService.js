/**
 * Memetakan kode diagnosis yang TIDAK ada di ICD-10 WHO ke padanannya.
 *
 * BPJS memakai ICD-10 WHO. Model bahasa cenderung mengeluarkan ICD-10-CM
 * (Amerika), yang memecah kategori lebih halus dan memuat kode yang tidak ada
 * di WHO: R10.84 (nyeri perut menyeluruh) tidak ada di WHO, padanannya R10.4.
 * Kode seperti itu tampil "Valid" di layar dan hampir pasti membuat klaim
 * dipending.
 *
 * CARA KERJA — memilih dari daftar, bukan mengarang:
 *
 *   1. Kode ICD-10-CM hampir selalu memecah kategori WHO yang SAMA lebih halus,
 *      jadi tiga karakter pertamanya (R10) menunjuk kategori yang benar.
 *   2. Semua kode WHO dalam kategori itu diambil dari kamus (R10.0 - R10.4).
 *   3. Kalau hanya satu kandidat, itulah jawabannya.
 *   4. Kalau lebih, AI diminta MEMILIH salah satu dari daftar itu berdasarkan
 *      istilah diagnosis di dokumen. Jawaban di luar daftar ditolak.
 *   5. Hasil disimpan, sehingga istilah yang sama tidak ditanyakan dua kali.
 *
 * Karena AI hanya boleh memilih dari kode yang PASTI ada di kamus, kegagalan
 * "kode karangan" tidak mungkin terjadi di sini. Yang masih mungkin adalah
 * salah pilih di antara kandidat — makanya pemetaan disimpan bersama istilah
 * asalnya supaya bisa diperbaiki sekaligus untuk semua klaim.
 */

const { getDb } = require('../database/init');
const gatewayModelService = require('./gatewayModelService');

const POLA_KATEGORI = /^[A-Z]\d{2}$/;

const { JEMBATAN_CM_KE_WHO } = require('./jembatanCmWho');
// Mendahulukan kandidat yang istilahnya cocok dengan dokumen (D49.2 "kulit,
// tulang, jaringan lunak" -> D48.0/D48.1/D48.5) dilakukan AI pilih-dari-daftar.

function normal(kode) {
  return String(kode || '').trim().toUpperCase();
}

function kunciIstilah(teks) {
  return String(teks || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ambil kandidat WHO dalam satu kategori, dahulukan yang berdigit keempat. */
async function ambilKandidat(db, kategori) {
  const rows = await db.all(
    'SELECT code, description_id, description_en FROM icd10_who_codes WHERE code LIKE ? ORDER BY code',
    [`${kategori}%`],
  );
  const anak = rows.filter(r => String(r.code).includes('.'));
  return anak.length > 0 ? anak : rows;
}

async function bacaDipelajari(db, kunci) {
  try {
    const rows = await db.all(
      'SELECT kode, nama FROM kamus_diagnosis_dipelajari WHERE kunci = ?',
      [kunci],
    );
    return rows[0] || null;
  } catch (err) {
    console.warn(`[KodeWho] Kamus dipelajari tidak terbaca: ${err.message}`);
    return null;
  }
}

async function simpanDipelajari(db, kunci, kode, nama, kodeAsal, teksAsal) {
  try {
    await db.run(
      `INSERT INTO kamus_diagnosis_dipelajari (kunci, kode, nama, kode_asal, teks_asal, dipelajari_pada)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(kunci) DO NOTHING`,
      [kunci, kode, nama, kodeAsal, String(teksAsal || '').slice(0, 200)],
    );
  } catch (err) {
    console.warn(`[KodeWho] Gagal menyimpan pemetaan: ${err.message}`);
  }
}

async function pilihDenganAi(kandidat, teksDiagnosis, kodeAsing, dikenal = {}, db = null) {
  if (!process.env.AI_PROVIDER_API_KEY && !process.env.KIMI_API_KEY) return null;

  const daftar = kandidat
    .map(k => `${k.code} — ${k.description_id || k.description_en}`)
    .join('\n');

  try {
    const panggilan = await gatewayModelService.panggilModel('petakan_diagnosis_who', {
      system: 'Kamu pemberi kode ICD-10 WHO untuk klaim BPJS Indonesia. Pilih SATU kode dari DAFTAR yang diberikan ' +
        'yang paling sesuai dengan diagnosis. Kamu HANYA boleh menjawab dengan kode yang ada di daftar; ' +
        'jangan membuat kode lain. Kalau tidak ada yang cocok, jawab null. ' +
        'Jawab JSON: {"kode":"R10.4"} atau {"kode":null}.',
      prompt: `Diagnosis di dokumen: "${teksDiagnosis}"\nKode yang sebelumnya tertulis (tidak ada di ICD-10 WHO): ${kodeAsing}\n\nDAFTAR:\n${daftar}`,
      json: true,
      maxTokens: 200,
      dikenal,
    }, { db });
    if (!panggilan.ok) throw new Error(panggilan.error || 'Panggilan gateway gagal');
    const jawab = panggilan.hasil && panggilan.hasil.kode;
    return jawab ? normal(jawab) : null;
  } catch (err) {
    console.warn(`[KodeWho] Gagal memilih kode: ${err.message}`);
    return null;
  }
}

/**
 * @param {string} kodeAsing kode yang tidak ada di ICD-10 WHO (mis. "r10.84")
 * @param {string} teksDiagnosis istilah diagnosis di dokumen (mis. "kolik abdomen")
 * @returns {Promise<{kode:string, nama:string, dari:string}|null>}
 */
async function petakanKeKodeWho(kodeAsing, teksDiagnosis, dikenal = {}) {
  const asal = normal(kodeAsing);
  const kategoriAsal = asal.slice(0, 3);
  if (!/^[A-Z]\d[0-9A-Z]$/.test(kategoriAsal)) return null;
  const kategori = JEMBATAN_CM_KE_WHO[kategoriAsal] || kategoriAsal;
  if (!POLA_KATEGORI.test(kategori)) return null;

  const db = getDb();
  let kandidat;
  try {
    kandidat = await ambilKandidat(db, kategori);
  } catch (err) {
    console.warn(`[KodeWho] Kamus WHO tidak terbaca: ${err.message}`);
    return null;
  }
  if (kandidat.length === 0) return null;

  const nama = (k) => k.description_id || k.description_en || null;
  if (kandidat.length === 1) {
    return { kode: kandidat[0].code, nama: nama(kandidat[0]), dari: 'satu_kandidat' };
  }

  // Tanpa istilah diagnosis tidak ada dasar untuk memilih di antara beberapa
  // kandidat, dan menebak hanya memindahkan kekeliruan ke kode lain.
  const kunciTeks = kunciIstilah(teksDiagnosis);
  if (!kunciTeks) return null;

  const kunci = `${kategori}|${kunciTeks}`;
  const tersimpan = await bacaDipelajari(db, kunci);
  if (tersimpan && tersimpan.kode && kandidat.some(k => normal(k.code) === normal(tersimpan.kode))) {
    return { kode: tersimpan.kode, nama: tersimpan.nama, dari: 'kamus_dipelajari' };
  }

  const pilihan = await pilihDenganAi(kandidat, teksDiagnosis, asal, dikenal, db);
  const dipilih = pilihan && kandidat.find(k => normal(k.code) === pilihan);
  // Jawaban di luar daftar ditolak — itulah pagar yang membuat kode karangan
  // mustahil di tahap ini.
  if (!dipilih) return null;

  await simpanDipelajari(db, kunci, dipilih.code, nama(dipilih), asal, teksDiagnosis);
  return { kode: dipilih.code, nama: nama(dipilih), dari: 'ai_pilih_dari_daftar' };
}

module.exports = { petakanKeKodeWho, kunciIstilah, JEMBATAN_CM_KE_WHO };
