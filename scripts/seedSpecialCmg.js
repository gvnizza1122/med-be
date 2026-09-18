#!/usr/bin/env node
/**
 * Seed tabel special_cmg_kriteria + special_cmg_penjaminan dari
 * src/data/special_cmg_kriteria.json dan
 * src/data/special_cmg_penjaminan_kelas_rs.json.
 *
 * WAJIB diseed BERSAMAAN (satu tanpa yang lain bisa bikin sistem
 * menyarankan top-up yang sebenarnya TIDAK BOLEH diklaim RS ini -- lihat
 * src/services/specialCmgDetector.js) -- script ini SENGAJA seed kedua
 * tabel dalam satu proses, tidak dipisah per tabel.
 *
 * CAKUPAN: Lampiran I.A (Kriteria Special CMG: special procedure/drugs/
 * investigation/prosthesis, Pasal 27 ayat 2 huruf a-d) + Lampiran Bagian II
 * (Ketentuan Penjaminan per kelas RS, Pasal 34). TIDAK termasuk Lampiran
 * I.B (Besaran/tarif top-up per kelas RS -- tabel terpisah jauh lebih
 * besar, tidak diminta) maupun subacute/chronic cases (Pasal 27 ayat 2
 * huruf e/f -- tidak punya tabel kriteria kode-per-kode di dokumen sumber).
 *
 * SUMBER DATA & METODE EKSTRAKSI: lihat field "meta" di kedua file JSON di
 * atas (metode ekstraksi, verifikasi visual, cross-check antar tabel).
 *
 * PENTING: script ini hanya DISIAPKAN, belum pernah dijalankan ke database
 * manapun. Jalankan manual setelah data ini direview:
 *   cd ~/eclaim/be && node scripts/seedSpecialCmg.js
 *
 * Idempoten -- tabel di-TRUNCATE lalu diisi ulang tiap dijalankan (bukan
 * ON CONFLICT DO UPDATE seperti seed lain) krn special_cmg_kriteria adalah
 * tabel HASIL EKSPLODE (banyak baris per kode_special_cmg, tanpa primary
 * key alami) -- re-seed penuh lebih aman & lebih sederhana daripada upsert
 * parsial yang bisa menyisakan baris lama kalau data sumber berubah jumlah
 * barisnya.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb, closeDb } = require('../src/database/init');

const KRITERIA_PATH = path.join(__dirname, '..', 'src', 'data', 'special_cmg_kriteria.json');
const PENJAMINAN_PATH = path.join(__dirname, '..', 'src', 'data', 'special_cmg_penjaminan_kelas_rs.json');

async function main() {
  for (const p of [KRITERIA_PATH, PENJAMINAN_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(`File data tidak ditemukan: ${p}`);
      process.exit(1);
    }
  }

  const kriteriaRaw = JSON.parse(fs.readFileSync(KRITERIA_PATH, 'utf8'));
  const penjaminanRaw = JSON.parse(fs.readFileSync(PENJAMINAN_PATH, 'utf8'));

  const kriteriaRows = Array.isArray(kriteriaRaw.kriteria_exploded) ? kriteriaRaw.kriteria_exploded : [];
  const penjaminanRows = Array.isArray(penjaminanRaw.penjaminan) ? penjaminanRaw.penjaminan : [];

  if (kriteriaRows.length === 0 || penjaminanRows.length === 0) {
    console.error('Salah satu/kedua file data kosong (kriteria_exploded / penjaminan). Berhenti -- lihat catatan WAJIB bareng di komentar file ini.');
    process.exit(1);
  }

  console.log(`Memuat ${kriteriaRows.length} baris kriteria (exploded) dari ${KRITERIA_PATH}`);
  console.log(`Memuat ${penjaminanRows.length} baris penjaminan dari ${PENJAMINAN_PATH}`);
  if (kriteriaRaw.meta) {
    console.log(`Sumber kriteria: ${kriteriaRaw.meta.source_name} (${kriteriaRaw.meta.source_pages})`);
  }
  if (penjaminanRaw.meta) {
    console.log(`Sumber penjaminan: ${penjaminanRaw.meta.source_name} (${penjaminanRaw.meta.source_pages})`);
    console.log(`Cross-check Tugas 1: ${penjaminanRaw.meta.cross_check_task1 || '(tidak ada catatan)'}`);
  }

  const db = getDb();
  await db.initialize(); // pastikan CREATE TABLE IF NOT EXISTS kedua tabel sudah jalan

  await db.transaction(async (client) => {
    await client.query('TRUNCATE TABLE special_cmg_kriteria');
    await client.query('TRUNCATE TABLE special_cmg_penjaminan');

    for (const r of kriteriaRows) {
      await client.query(`
        INSERT INTO special_cmg_kriteria (id, no_asal, kode_special_cmg, deskripsi, jenis, kode_group_inacbg, kode_diagnosis, kode_prosedur)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        uuidv4(), r.no_asal, r.kode_special_cmg, r.deskripsi, r.jenis,
        r.kode_group_inacbg || null, r.kode_diagnosis || null, r.kode_prosedur || null,
      ]);
    }

    for (const r of penjaminanRows) {
      await client.query(`
        INSERT INTO special_cmg_penjaminan (
          id, no_asal, kode_special_cmg, jenis_layanan, kode_group_inacbg,
          kode_diagnosis, kode_prosedur, allowed_kelas_rs, excluded_kelas_rs,
          boleh_kelas_d, catatan_kelas_rs, catatan_lengkap, sumber_halaman
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        uuidv4(), r.no, r.kode_special_cmg || null, r.jenis_layanan,
        r.kode_group_inacbg || null, r.kode_diagnosis || null, r.kode_prosedur || null,
        Array.isArray(r.allowed_kelas_rs) ? r.allowed_kelas_rs.join(',') : null,
        Array.isArray(r.excluded_kelas_rs) ? r.excluded_kelas_rs.join(',') : null,
        r.boleh_kelas_d,
        r.catatan_kelas_rs || null,
        r.catatan_lengkap || null,
        Array.isArray(r.sumber_halaman) ? r.sumber_halaman.join(',') : String(r.sumber_halaman || ''),
      ]);
    }
  });

  const kCount = await db.get('SELECT COUNT(*) as count FROM special_cmg_kriteria');
  const pCount = await db.get('SELECT COUNT(*) as count FROM special_cmg_penjaminan');
  console.log(`\nSelesai. special_cmg_kriteria: ${kCount.count} baris. special_cmg_penjaminan: ${pCount.count} baris.`);

  // Cross-check pasca-seed: setiap kode_special_cmg di special_cmg_penjaminan
  // (yang tidak NULL) HARUS ada di special_cmg_kriteria -- kalau tidak,
  // detektor bisa salah acu (kriteria top-up ditemukan tapi ketentuan
  // penjaminannya "menggantung", atau sebaliknya).
  const orphans = await db.all(`
    SELECT DISTINCT p.kode_special_cmg
    FROM special_cmg_penjaminan p
    WHERE p.kode_special_cmg IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM special_cmg_kriteria k WHERE k.kode_special_cmg = p.kode_special_cmg)
  `);
  if (orphans.length > 0) {
    console.error(`PERINGATAN -- ${orphans.length} kode_special_cmg di special_cmg_penjaminan TIDAK ditemukan di special_cmg_kriteria: ${orphans.map(o => o.kode_special_cmg).join(', ')}. Data JANGAN dipakai sampai ditelusuri ulang.`);
  } else {
    console.log('Cross-check special_cmg_penjaminan <-> special_cmg_kriteria: OK (semua kode_special_cmg cocok).');
  }

  closeDb();
}

main().catch(err => {
  console.error('Seed gagal total:', err);
  closeDb();
  process.exit(1);
});
