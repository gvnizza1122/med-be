#!/usr/bin/env node
/**
 * Seed tabel icd10_who_codes dari src/data/icd10_who_dictionary.json.
 *
 * Latar belakang: fitur "saran kode diagnosis" (suggested_codes, lihat
 * src/services/aiReviewService.js) sempat menghasilkan kode ICD-10-CM
 * (Amerika) alih-alih ICD-10 WHO (yang dipakai BPJS Indonesia via PMK
 * 3/2023, "ICD-10 Versi Tahun 2010") -- sebagai fix sementara, tombol
 * "Terapkan" di frontend eclaim-production DIMATIKAN TOTAL sampai ada
 * kamus ICD-10 WHO untuk validasi. Tabel ini + script ini adalah kamus
 * itu. Setelah kamus ini di-seed, aiReviewService.js menandai tiap entry
 * suggested_codes dengan field tambahan "kamus_valid" (true/false/null)
 * berdasarkan keberadaan kode di tabel ini -- TIDAK membuang kode yang
 * tidak ditemukan (kamus mungkin belum lengkap), cuma menandai.
 *
 * SUMBER DATA (lihat src/data/icd10_who_dictionary.json -> meta untuk detail
 * lengkap termasuk caveat): repo GitHub pihak ketiga fendis0709/icd-10,
 * yang menyatakan datanya "diperoleh dari ICD-X WHO
 * (https://www.who.int/classifications/icd/icdonlineversions/en)". BUKAN
 * unduhan langsung dari WHO ICD-API/ClaML resmi atau Kemenkes/BPJS/INA-CBG
 * (pencarian untuk sumber itu tidak menemukan file bulk yang bisa diunduh
 * publik tanpa menjalankan installer Windows e-Klaim). 10.469 kode, 21 dari
 * 22 bab WHO ICD-10 terisi (bab XXII "Codes for special purposes", U00-U99,
 * KOSONG di sumber ini -- lihat meta.chapters_with_zero_codes). Sudah lolos
 * sanity-check dasar (format kode WHO murni, tanpa ekstensi 7-karakter ala
 * ICD-10-CM, tidak ada duplikat) tapi BELUM diverifikasi baris-per-baris
 * terhadap WHO resmi -- rekomendasi: spot-check oleh koder medis
 * bersertifikat sebelum dipakai sebagai dasar mengaktifkan kembali tombol
 * "Terapkan".
 *
 * PENTING: script ini hanya DISIAPKAN, belum pernah dijalankan ke database
 * manapun. Jalankan manual setelah kamus ini direview:
 *   cd ~/eclaim/be && node scripts/seedIcd10WhoDictionary.js
 *
 * Idempoten -- aman dijalankan ulang (ON CONFLICT DO UPDATE), termasuk untuk
 * re-seed setelah src/data/icd10_who_dictionary.json diperbarui/diperkaya.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDb, closeDb } = require('../src/database/init');

const DATA_PATH = path.join(__dirname, '..', 'src', 'data', 'icd10_who_dictionary.json');
const BATCH_SIZE = 500; // baris per statement INSERT multi-value

async function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`File data tidak ditemukan: ${DATA_PATH}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const meta = raw.meta || {};
  const codes = Array.isArray(raw.codes) ? raw.codes : [];

  if (codes.length === 0) {
    console.error('src/data/icd10_who_dictionary.json tidak berisi kode apapun (codes kosong). Berhenti.');
    process.exit(1);
  }

  const sourceLabel = [meta.source_name, meta.source_repo_url].filter(Boolean).join(' - ')
    || 'src/data/icd10_who_dictionary.json (sumber tidak tercatat di meta)';

  console.log(`Memuat ${codes.length} kode dari ${DATA_PATH}`);
  console.log(`Sumber (kolom "source" per baris): ${sourceLabel}`);
  if (meta.source_caveat) {
    console.log(`Catatan sumber: ${meta.source_caveat}`);
  }
  if (Array.isArray(meta.chapters_with_zero_codes) && meta.chapters_with_zero_codes.length > 0) {
    console.log(`PERINGATAN -- bab TANPA kode sama sekali di sumber ini: ${meta.chapters_with_zero_codes.join('; ')}`);
  }

  const db = getDb();
  await db.initialize(); // pastikan CREATE TABLE IF NOT EXISTS icd10_who_codes sudah jalan

  let inserted = 0;
  let failed = 0;

  await db.transaction(async (client) => {
    for (let i = 0; i < codes.length; i += BATCH_SIZE) {
      const batch = codes
        .slice(i, i + BATCH_SIZE)
        .filter(entry => String(entry.code || '').trim());
      failed += Math.min(BATCH_SIZE, codes.length - i) - batch.length;
      if (batch.length === 0) continue;

      // convertSql() di database/init.js mengganti tiap "?" jadi $1,$2,...
      // berurutan sesuai urutan kemunculan di string SQL -- jadi cukup
      // sediakan placeholder "?" polos per kolom, tidak perlu dihitung manual.
      const values = [];
      const rowPlaceholders = batch.map(entry => {
        values.push(
          String(entry.code).trim().toUpperCase(),
          entry.description_en || null,
          entry.description_id || null,
          entry.chapter || null,
          entry.chapter_number || null,
          sourceLabel,
        );
        return '(?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)';
      }).join(',\n        ');

      await client.query(`
        INSERT INTO icd10_who_codes (code, description_en, description_id, chapter, chapter_number, source, imported_at)
        VALUES
        ${rowPlaceholders}
        ON CONFLICT (code) DO UPDATE SET
          description_en = EXCLUDED.description_en,
          description_id = EXCLUDED.description_id,
          chapter = EXCLUDED.chapter,
          chapter_number = EXCLUDED.chapter_number,
          source = EXCLUDED.source,
          imported_at = CURRENT_TIMESTAMP
      `, values);

      inserted += batch.length;
      if ((i / BATCH_SIZE) % 5 === 0) {
        console.log(`  ... ${Math.min(i + BATCH_SIZE, codes.length)}/${codes.length}`);
      }
    }
  });

  console.log(`\nSelesai. Baris diproses: ${inserted}, dilewati (kode kosong): ${failed}.`);

  const countRes = await db.get('SELECT COUNT(*) as count FROM icd10_who_codes');
  console.log(`Total baris di tabel icd10_who_codes sekarang: ${countRes.count}`);

  closeDb();
}

main().catch(err => {
  console.error('Seed gagal total:', err);
  process.exit(1);
});
