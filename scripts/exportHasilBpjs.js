#!/usr/bin/env node
/**
 * Ekspor pembanding hasil BPJS dengan hasil audit aplikasi.
 *
 * Data sumber hanya dibaca. Baris positif berasal dari rekap pending BPJS;
 * tabel itu tidak memuat populasi klaim yang dinyatakan lolos. Karena itu
 * alarm palsu dan recall untuk populasi penuh tidak dikarang: ringkasan akan
 * menandainya belum dapat dihitung sampai data negatif terverifikasi tersedia.
 * Kolom outcome di tabel ini adalah hasil klarifikasi atas klaim pending,
 * bukan putusan awal BPJS pending/lolos, sehingga sengaja tidak dipakai.
 *
 * Pakai:
 *   node scripts/exportHasilBpjs.js --pending-file-id ID --out hasil-bpjs.xlsx
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { getDb, closeDb } = require('../src/database/init');

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--pending-file-id') out.pendingFileId = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--help') out.help = true;
    else throw new Error(`Argumen tidak dikenal: ${argv[i]}`);
  }
  return out;
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function formatReasons(row) {
  const review = parseJson(row.ai_review);
  const putusan = review.putusan_pending || {};
  const alasan = Array.isArray(putusan.alasan) ? putusan.alasan : [];
  const ruleReasons = (row.validation_errors || []).map((e) => {
    const err = typeof e === 'string' ? parseJson(e) : e;
    return [err.kode || err.rule_id, err.ringkas || err.error_message || err.field_name]
      .filter(Boolean).join(': ');
  }).filter(Boolean);
  const aiReasons = alasan.map((a) => [a.kode, a.ringkas || a.penjelasan]
    .filter(Boolean).join(': ')).filter(Boolean);
  return [...new Set([...aiReasons, ...ruleReasons])].join('; ');
}

function applicationDecision(row) {
  const review = parseJson(row.ai_review);
  const statusAi = review.putusan_pending && review.putusan_pending.status;
  const ditandai = row.validation_status !== 'valid' || statusAi === 'berisiko_pending';
  return { ditandai, alasan: formatReasons(row) };
}

function klasifikasi(row) {
  const app = applicationDecision(row);
  if (!app.ditandai) return 'terlewat';
  if (!app.alasan) return 'pending tapi alasan beda';
  const bpjs = String(row.alasan_raw || '').trim().toLocaleLowerCase('id-ID');
  const alasanApp = app.alasan.trim().toLocaleLowerCase('id-ID');
  return bpjs && bpjs === alasanApp ? 'cocok penuh' : 'pending tapi alasan beda';
}

function buildWorkbook(rows, metadata = {}) {
  const wb = XLSX.utils.book_new();
  const mapped = rows.map((row) => {
    const app = applicationDecision(row);
    const alasanCocok = Boolean(row.alasan_raw && app.alasan
      && String(row.alasan_raw).trim().toLocaleLowerCase('id-ID') === app.alasan.trim().toLocaleLowerCase('id-ID'));
    const record = { ...row, alasan_cocok: alasanCocok };
    return { row: record, app, label: klasifikasi(record) };
  });
  const counts = Object.fromEntries(['cocok penuh', 'pending tapi alasan beda', 'terlewat', 'alarm palsu']
    .map((k) => [k, mapped.filter((x) => x.label === k).length]));
  const ringkasan = [
    ['Pembanding Hasil BPJS dan medaudit'],
    ['Sumber rekap', metadata.fileName || ''],
    ['ID rekap', metadata.pendingFileId || ''],
    ['Tanggal ekspor', new Date().toISOString()],
    ['Jumlah baris pending BPJS', rows.length],
    ['Kelompok klaim BPJS lolos terverifikasi', 'Tidak tersedia dari tabel rekap pending; alarm palsu belum dapat dihitung'],
    ['Cocok penuh', counts['cocok penuh']],
    ['Pending tapi alasan beda', counts['pending tapi alasan beda']],
    ['Terlewat', counts.terlewat],
    ['Alarm palsu', 'Belum dapat dihitung (tidak ada label BPJS lolos yang terverifikasi)'],
    ['Tertangkap', `${counts['cocok penuh'] + counts['pending tapi alasan beda']} dari ${rows.length} baris positif dalam rekap ini; bukan recall populasi`],
    ['Alasan cocok', `${counts['cocok penuh']} dari ${rows.length} baris; pencocokan kata kunci awal, wajib tinjau manual`],
    ['Terlewat yang mustahil dari berkas', 'Belum dinilai; perlu pemeriksa membaca bukti PDF'],
    ['Aturan tanggal pelayanan', 'Tanggal masuk/keluar diekspor untuk tinjauan; snapshot alasan aplikasi tidak dihitung ulang terhadap rule_versi historis'],
    ['Catatan metodologi', 'Hanya klaim positif (pending) dari rekap terpilih. outcome pada bpjs_pending_responses adalah hasil klarifikasi, bukan status awal pending/lolos.'],
    ['Peringatan', 'Label alasan cocok adalah pencocokan kata kunci kasar, bukan adjudikasi klinis/koder. Jangan gunakan sebagai angka akurasi final.'],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(ringkasan);
  wsSummary['!cols'] = [{ wch: 48 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Ringkasan');

  const headers = ['SEP', 'Tanggal Pelayanan', 'Rawat', 'Alasan Pending BPJS', 'Ditandai Aplikasi?', 'Alasan Aplikasi', 'Alasan Sama?', 'Klasifikasi', 'Status Aplikasi', 'Status Putusan AI'];
  const data = [headers, ...mapped.map(({ row, app, label }) => [
    row.sep || '', row.admission_date || row.discharge_date || '', row.jenis_klaim || '',
    row.alasan_raw || '', app.ditandai ? 'Ya' : 'Tidak', app.alasan,
    row.alasan_cocok ? 'Ya (teks persis)' : 'Tidak / belum cocok', label,
    row.validation_status || '', parseJson(row.ai_review).putusan_pending?.status || '',
  ])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 16 }, { wch: 55 }, { wch: 18 }, { wch: 65 }, { wch: 28 }, { wch: 28 }, { wch: 18 }, { wch: 22 }];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!autofilter'] = { ref: `A1:J${Math.max(1, data.length)}` };
  for (let r = 2; r <= data.length; r += 1) ws[`A${r}`] = { t: 's', v: String(data[r - 1][0] || '') };
  XLSX.utils.book_append_sheet(wb, ws, 'Per Klaim');
  return { workbook: wb, counts };
}

async function ambilRows(db, pendingFileId) {
  return db.prepare(`
    SELECT bpr.id AS pending_id, bpr.sep, bpr.alasan_raw, bpr.jenis_klaim AS jenis_bpjs,
           bpr.pending_file_id, bpr.outcome AS outcome_klarifikasi,
           bpf.file_name, cr.id AS claim_record_id, cr.admission_date, cr.discharge_date,
           cr.jenis_klaim, cr.validation_status, cr.ai_review,
           COALESCE((SELECT json_agg(json_build_object(
             'rule_id', ve.rule_id, 'field_name', ve.field_name, 'error_message', ve.error_message
           )) FROM validation_errors ve WHERE ve.record_id = cr.id), '[]'::json) AS validation_errors
    FROM bpjs_pending_responses bpr
    LEFT JOIN bpjs_pending_files bpf ON bpf.id = bpr.pending_file_id
    LEFT JOIN claim_records cr ON cr.id = bpr.claim_record_id
    WHERE bpr.pending_file_id = ?
    ORDER BY bpr.sep, bpr.id
  `).all(pendingFileId);
}

async function main() {
  const options = args(process.argv);
  if (options.help) {
    console.log('Pakai: node scripts/exportHasilBpjs.js --pending-file-id ID --out hasil-bpjs.xlsx');
    return;
  }
  if (!options.pendingFileId || !options.out) throw new Error('--pending-file-id dan --out wajib diisi');
  const outPath = path.resolve(options.out);
  if (path.extname(outPath).toLowerCase() !== '.xlsx') throw new Error('--out harus berakhiran .xlsx');
  const db = getDb();
  try {
    await db.initialize();
    const rows = await ambilRows(db, options.pendingFileId);
    if (!rows.length) throw new Error('Tidak ada baris rekap untuk pending-file-id tersebut');
    const metadata = { pendingFileId: options.pendingFileId, fileName: rows[0].file_name };
    const { workbook, counts } = buildWorkbook(rows, metadata);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    XLSX.writeFile(workbook, outPath);
    console.log(`Ekspor dibuat: ${outPath}`);
    console.log(`Baris pending BPJS: ${rows.length}; cocok penuh: ${counts['cocok penuh']}; alasan beda: ${counts['pending tapi alasan beda']}; terlewat: ${counts.terlewat}`);
    console.log('Alarm palsu dan recall populasi: belum dapat dihitung tanpa kelompok BPJS lolos terverifikasi.');
  } finally {
    closeDb();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(`GAGAL: ${error.message}`); process.exitCode = 1; });
}

module.exports = { args, applicationDecision, buildWorkbook, klasifikasi };
