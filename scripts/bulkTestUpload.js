#!/usr/bin/env node
/**
 * Upload massal PDF klaim untuk testing skala besar (mis. 10.000 file di
 * RS) — mem-bypass batas 100 file/klik di UI dengan otomatis membagi folder
 * jadi chunk 100 file dan mengirim tiap chunk ke
 * POST /api/v1/claim-files/upload-pdf-batch berturut-turut.
 *
 * Menulis daftar file_id yang berhasil diupload ke
 * bulk-upload-log-<timestamp>.json — dipakai scripts/bulkTestCleanup.js
 * supaya cleanup HANYA menghapus file yang diupload run ini, tidak pernah
 * menyentuh data staf RS lain yang mungkin aktif bersamaan.
 *
 * Pakai:
 *   TEST_API_BASE=https://api.medaudit.my.id \
 *   TEST_USER=admin@rslestari.id TEST_PASSWORD=xxx \
 *   node scripts/bulkTestUpload.js /path/folder-bulan-1 --jenis rajal,ranap,igd
 *
 * (TEST_API_BASE default https://api.medaudit.my.id kalau tidak diset)
 */

const fs = require('fs');
const path = require('path');

const CHUNK_SIZE = 100;
const JENIS_MAP = { rajal: 'RAWAT_JALAN', ranap: 'RAWAT_INAP', igd: 'GAWAT_DARURAT' };

function parseArgs(argv) {
  const folder = argv[2];
  const jenisArg = argv.find(a => a.startsWith('--jenis'));
  const jenisRaw = jenisArg ? (jenisArg.split('=')[1] || argv[argv.indexOf(jenisArg) + 1]) : 'rajal,ranap,igd';
  const jenis = jenisRaw.split(',').map(s => JENIS_MAP[s.trim()]).filter(Boolean);
  return { folder, jenis };
}

async function login(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login gagal: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshToken(baseUrl, refresh_token) {
  const res = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token }),
  });
  if (!res.ok) throw new Error(`Refresh token gagal: HTTP ${res.status}`);
  return res.json();
}

async function uploadChunk(baseUrl, accessToken, files, jenis) {
  const form = new FormData();
  for (const filePath of files) {
    const buf = fs.readFileSync(filePath);
    form.append('files', new Blob([buf]), path.basename(filePath));
  }
  form.append('allowed_jenis_klaim', JSON.stringify(jenis));

  const res = await fetch(`${baseUrl}/api/v1/claim-files/upload-pdf-batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Upload batch gagal: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const { folder, jenis } = parseArgs(process.argv);
  if (!folder) {
    console.error('Pakai: node scripts/bulkTestUpload.js /path/folder --jenis rajal,ranap,igd');
    process.exit(1);
  }
  if (jenis.length === 0) {
    console.error('--jenis wajib diisi minimal satu dari: rajal, ranap, igd');
    process.exit(1);
  }
  const baseUrl = process.env.TEST_API_BASE || 'https://api.medaudit.my.id';
  const username = process.env.TEST_USER;
  const password = process.env.TEST_PASSWORD;
  if (!username || !password) {
    console.error('Set env var TEST_USER dan TEST_PASSWORD dulu (jangan hardcode di script).');
    process.exit(1);
  }

  const allFiles = fs.readdirSync(folder)
    .filter(f => /\.pdf$/i.test(f))
    .map(f => path.join(folder, f));
  if (allFiles.length === 0) {
    console.error(`Tidak ada file .pdf ditemukan di ${folder}`);
    process.exit(1);
  }
  console.log(`Ditemukan ${allFiles.length} file PDF di ${folder}. Kategori: ${jenis.join(', ')}`);

  let session = await login(baseUrl, username, password);
  let tokenObtainedAt = Date.now();
  console.log(`Login berhasil sebagai ${session.user.email} (${session.user.role}).`);

  const chunks = [];
  for (let i = 0; i < allFiles.length; i += CHUNK_SIZE) chunks.push(allFiles.slice(i, i + CHUNK_SIZE));

  const uploadedFileIds = [];
  let totalSuccess = 0, totalFailed = 0;

  for (let i = 0; i < chunks.length; i++) {
    // Refresh token kalau sudah lewat ~50 menit (exp default 1 jam)
    if (Date.now() - tokenObtainedAt > 50 * 60 * 1000) {
      session = await refreshToken(baseUrl, session.refresh_token);
      tokenObtainedAt = Date.now();
      console.log('Token di-refresh.');
    }

    const chunk = chunks[i];
    try {
      const result = await uploadChunk(baseUrl, session.access_token, chunk, jenis);
      totalSuccess += result.successful || 0;
      totalFailed += result.failed || 0;
      for (const r of result.results || []) {
        if (r.success && r.file_id) uploadedFileIds.push(r.file_id);
      }
      console.log(`[batch ${i + 1}/${chunks.length}] ${result.successful} berhasil, ${result.failed} gagal (total sejauh ini: ${totalSuccess} berhasil, ${totalFailed} gagal)`);
    } catch (err) {
      console.error(`[batch ${i + 1}/${chunks.length}] GAGAL total: ${err.message}`);
    }
  }

  const logPath = path.join(process.cwd(), `bulk-upload-log-${Date.now()}.json`);
  fs.writeFileSync(logPath, JSON.stringify({ folder, jenis, uploadedFileIds, totalSuccess, totalFailed }, null, 2));

  console.log(`\nSelesai. Total berhasil: ${totalSuccess}, gagal: ${totalFailed}.`);
  console.log(`Log file_id tersimpan di: ${logPath}`);
  console.log(`Untuk cleanup nanti: node scripts/bulkTestCleanup.js ${path.basename(logPath)} --yes`);
}

main().catch(err => {
  console.error('Script gagal total:', err);
  process.exit(1);
});
