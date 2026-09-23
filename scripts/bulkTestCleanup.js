#!/usr/bin/env node
/**
 * Hapus semua file_id yang tercatat di log hasil scripts/bulkTestUpload.js —
 * dipakai untuk cleanup cepat setelah testing skala besar. HANYA menghapus
 * file yang ada di log (tidak pernah pakai rentang tanggal/kriteria luas),
 * supaya tidak pernah menyentuh data staf RS lain yang mungkin aktif
 * bersamaan dengan sesi testing.
 *
 * Pakai:
 *   TEST_API_BASE=https://api.medaudit.my.id \
 *   TEST_USER=admin@rslestari.id TEST_PASSWORD=xxx \
 *   node scripts/bulkTestCleanup.js bulk-upload-log-xxx.json --yes [--pending-file-id <id>]
 *
 * Tanpa --yes, script cuma menampilkan ringkasan (dry-run) tanpa menghapus apapun.
 */

const fs = require('fs');

const CHUNK_SIZE = 200;

async function login(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login gagal: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function bulkDelete(baseUrl, accessToken, ids) {
  const res = await fetch(`${baseUrl}/api/v1/claim-files/bulk-delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, konfirmasi: true, alasan: "cleanup setelah testing batch besar" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Bulk-delete gagal: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function deletePendingFile(baseUrl, accessToken, pendingFileId) {
  const res = await fetch(`${baseUrl}/api/v1/records/pending-files/${pendingFileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Hapus pending-file gagal: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const logFile = process.argv[2];
  const confirmed = process.argv.includes('--yes');
  const pfIdx = process.argv.indexOf('--pending-file-id');
  const pendingFileId = pfIdx !== -1 ? process.argv[pfIdx + 1] : null;

  if (!logFile) {
    console.error('Pakai: node scripts/bulkTestCleanup.js <log.json> --yes [--pending-file-id <id>]');
    process.exit(1);
  }
  const log = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
  const ids = log.uploadedFileIds || [];

  console.log(`Log: ${logFile}`);
  console.log(`Akan menghapus ${ids.length} claim_files` + (pendingFileId ? ` + 1 file pending (${pendingFileId})` : '') + '.');

  if (!confirmed) {
    console.log('\nDRY-RUN — tidak ada yang dihapus. Tambahkan --yes untuk benar-benar menghapus.');
    return;
  }
  if (ids.length === 0 && !pendingFileId) {
    console.log('Tidak ada yang perlu dihapus.');
    return;
  }

  const baseUrl = process.env.TEST_API_BASE || 'https://api.medaudit.my.id';
  const username = process.env.TEST_USER;
  const password = process.env.TEST_PASSWORD;
  if (!username || !password) {
    console.error('Set env var TEST_USER dan TEST_PASSWORD dulu.');
    process.exit(1);
  }
  const session = await login(baseUrl, username, password);
  console.log(`Login berhasil sebagai ${session.user.email} (${session.user.role}).`);

  let totalDeleted = 0;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const result = await bulkDelete(baseUrl, session.access_token, chunk);
    totalDeleted += result.deleted || 0;
    console.log(`[chunk ${Math.floor(i / CHUNK_SIZE) + 1}] ${result.deleted} file dihapus (total: ${totalDeleted}/${ids.length})`);
  }

  if (pendingFileId) {
    await deletePendingFile(baseUrl, session.access_token, pendingFileId);
    console.log(`File pending ${pendingFileId} dihapus.`);
  }

  console.log(`\nSelesai. Total claim_files dihapus: ${totalDeleted}.`);
}

main().catch(err => {
  console.error('Script gagal total:', err);
  process.exit(1);
});
