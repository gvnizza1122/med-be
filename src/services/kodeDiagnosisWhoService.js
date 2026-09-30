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

const POLA_KATEGORI = /^[A-Z]\d{2}$/;

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

async function pilihDenganAi(kandidat, teksDiagnosis, kodeAsing) {
  const apiKey = process.env.AI_PROVIDER_API_KEY;
  if (!apiKey) return null;

  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);

  const daftar = kandidat
    .map(k => `${k.code} — ${k.description_id || k.description_en}`)
    .join('\n');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Kamu pemberi kode ICD-10 WHO untuk klaim BPJS Indonesia. Pilih SATU kode dari DAFTAR yang diberikan ' +
              'yang paling sesuai dengan diagnosis. Kamu HANYA boleh menjawab dengan kode yang ada di daftar; ' +
              'jangan membuat kode lain. Kalau tidak ada yang cocok, jawab null. ' +
              'Jawab JSON: {"kode":"R10.4"} atau {"kode":null}.',
          },
          {
            role: 'user',
            content: `Diagnosis di dokumen: "${teksDiagnosis}"\nKode yang sebelumnya tertulis (tidak ada di ICD-10 WHO): ${kodeAsing}\n\nDAFTAR:\n${daftar}`,
          },
        ],
        max_completion_tokens: 200,
        response_format: { type: 'json_object' },
      }),
    });
    const teks = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${teks.slice(0, 160)}`);
    const data = JSON.parse(teks);
    console.warn(`[KodeWho] tokens: ${data.usage?.total_tokens ?? '?'} untuk ${kodeAsing}`);
    const jawab = JSON.parse(data.choices?.[0]?.message?.content || '{}').kode;
    return jawab ? normal(jawab) : null;
  } catch (err) {
    console.warn(`[KodeWho] Gagal memilih kode: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} kodeAsing kode yang tidak ada di ICD-10 WHO (mis. "r10.84")
 * @param {string} teksDiagnosis istilah diagnosis di dokumen (mis. "kolik abdomen")
 * @returns {Promise<{kode:string, nama:string, dari:string}|null>}
 */
async function petakanKeKodeWho(kodeAsing, teksDiagnosis) {
  const asal = normal(kodeAsing);
  const kategori = asal.slice(0, 3);
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
  if (tersimpan && tersimpan.kode) {
    return { kode: tersimpan.kode, nama: tersimpan.nama, dari: 'kamus_dipelajari' };
  }

  const pilihan = await pilihDenganAi(kandidat, teksDiagnosis, asal);
  const dipilih = pilihan && kandidat.find(k => normal(k.code) === pilihan);
  // Jawaban di luar daftar ditolak — itulah pagar yang membuat kode karangan
  // mustahil di tahap ini.
  if (!dipilih) return null;

  await simpanDipelajari(db, kunci, dipilih.code, nama(dipilih), asal, teksDiagnosis);
  return { kode: dipilih.code, nama: nama(dipilih), dari: 'ai_pilih_dari_daftar' };
}

module.exports = { petakanKeKodeWho, kunciIstilah };
