#!/usr/bin/env node
/**
 * Backfill arsip historis pending BPJS (4-5 bulan sebelum eclaim dipakai) ke
 * ai_training_examples, supaya Luna (AI review klaim) punya lebih banyak
 * contoh few-shot lewat getRelevantBpjsExamples().
 *
 * Dijalankan MANUAL, SEKALI, oleh tim IT via SSH — bukan dipicu UI, bukan
 * rutinitas bulanan (data lama tidak bertambah lagi setelah ini). Untuk data
 * baru ke depannya, training sudah otomatis lewat hook di
 * routes/bpjsPending.js (generate-draft), tidak butuh script ini lagi.
 *
 * Pakai:
 *   cd ~/eclaim/be && node scripts/importTrainingData.js /path/ke/arsip.zip
 *
 * Arsip berisi PDF surat pending BPJS + jawaban klarifikasi RS (satu PDF per
 * kasus). Tiap file di-OCR (reuse worker pool ocrService.js, sama seperti
 * dipakai alur upload klaim biasa) lalu diringkas Kimi K3 jadi data
 * terstruktur, sebelum di-insert ke ai_training_examples.
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { getDb, closeDb } = require('../src/database/init');
const { ocrPdfPages, shutdownOcrPool } = require('../src/services/ocrService');
const { classifyPdfPages } = require('../src/services/pdfPageClassifier');
const { callKimi } = require('../src/services/kimiClient');

const CONCURRENCY = 5;

async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

/** Gabung teks NATIVE (ketikan) + OCR (halaman scan) per PDF, urut halaman. */
async function extractFullText(pdfPath) {
  const classified = await classifyPdfPages(pdfPath);
  if (!classified.success) throw new Error('Gagal klasifikasi halaman PDF');

  const scanPageNums = classified.pages.filter(p => p.type === 'SCAN').map(p => p.page_num);
  let ocrByPage = new Map();
  if (scanPageNums.length > 0) {
    const ocrResult = await ocrPdfPages(pdfPath, scanPageNums);
    for (const p of ocrResult.pages || []) ocrByPage.set(p.page_number, p.text);
  }

  const parts = classified.pages
    .sort((a, b) => a.page_num - b.page_num)
    .map(p => (p.type === 'SCAN' ? (ocrByPage.get(p.page_num) || '') : (p.text_full || '')));

  return parts.join('\n').trim();
}

async function processOneFile(db, pdfPath, filename) {
  const text = await extractFullText(pdfPath);
  if (text.length < 20) {
    return { filename, status: 'error', message: 'Teks hasil OCR/ekstraksi terlalu sedikit' };
  }

  const result = await callKimi(`TEKS SURAT (hasil OCR):\n${text}`);
  if (!result) {
    return { filename, status: 'error', message: 'KIMI_API_KEY belum disetel di server' };
  }

  await db.prepare(`
    INSERT INTO ai_training_examples
      (id, kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci, outcome, generated_by, confidence_score)
    VALUES (?, ?, ?, ?, ?, ?, 'kimi-k3-backfill', ?)
  `).run(
    uuidv4(),
    result.kategori_pending || 'lainnya',
    result.alasan_pending || text.slice(0, 2000),
    result.jawaban_klarifikasi || '',
    Array.isArray(result.poin_kunci) ? result.poin_kunci.join('; ') : null,
    result.outcome || 'tidak_diketahui',
    Number.isFinite(result.confidence) ? result.confidence : null,
  );

  return { filename, status: 'done', kategori: result.kategori_pending, confidence: result.confidence };
}

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('Pakai: node scripts/importTrainingData.js /path/ke/arsip.zip');
    process.exit(1);
  }
  if (!fs.existsSync(zipPath)) {
    console.error(`File tidak ditemukan: ${zipPath}`);
    process.exit(1);
  }
  if (!process.env.KIMI_API_KEY) {
    console.error('KIMI_API_KEY belum disetel di .env — set dulu sebelum jalan.');
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-import-'));
  console.log(`Mengekstrak ZIP ke ${tmpDir}...`);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(tmpDir, true);

  const pdfFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.pdf$/i.test(entry.name)) pdfFiles.push(full);
    }
  })(tmpDir);

  console.log(`Ditemukan ${pdfFiles.length} file PDF. Memproses (konkurensi ${CONCURRENCY})...`);
  const db = getDb();

  let done = 0, error = 0, i = 0;
  const total = pdfFiles.length;
  await runWithConcurrencyLimit(pdfFiles, CONCURRENCY, async (pdfPath) => {
    const idx = ++i;
    const filename = path.basename(pdfPath);
    try {
      const r = await processOneFile(db, pdfPath, filename);
      if (r.status === 'done') {
        done++;
        console.log(`[${idx}/${total}] ${filename} ... OK kategori=${r.kategori} confidence=${r.confidence}`);
      } else {
        error++;
        console.log(`[${idx}/${total}] ${filename} ... GAGAL (${r.message})`);
      }
    } catch (err) {
      error++;
      console.log(`[${idx}/${total}] ${filename} ... GAGAL (${err.message})`);
    }
  });

  console.log(`\nSelesai. Berhasil: ${done}, Gagal: ${error}, Total: ${total}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  await shutdownOcrPool();
  closeDb();
}

main().catch(err => {
  console.error('Script gagal total:', err);
  process.exit(1);
});
