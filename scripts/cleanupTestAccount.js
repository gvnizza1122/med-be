#!/usr/bin/env node
/**
 * Hapus SEMUA claim_files + bpjs_pending_files (beserta isinya) yang
 * diupload oleh 1 akun tertentu — dipakai untuk cleanup akhir sesi testing
 * multi-bulan di RS, di mana data diupload manual lewat web UI (bukan lewat
 * bulkTestUpload.js), jadi tidak ada log file_id untuk dipakai
 * bulkTestCleanup.js. Presisi berdasarkan uploaded_by, jadi TIDAK PERNAH
 * menyentuh data yang diupload akun lain (staf RS lain yang mungkin aktif
 * bersamaan).
 *
 * TIDAK menyentuh ai_training_examples sama sekali — hasil training Kimi
 * dari bulan-bulan sebelumnya tetap tersimpan meski data claim/pending
 * dihapus dan diulang dari bulan 1.
 *
 * Pakai (login sebagai admin, target akun test yang dipakai upload):
 *   TEST_API_BASE=https://api.medaudit.my.id \
 *   TEST_USER=admin@rslestari.id TEST_PASSWORD=xxx \
 *   node scripts/cleanupTestAccount.js <user_id_akun_test> --yes
 *
 * Tanpa --yes, script cuma menampilkan peringatan (dry-run) tanpa menghapus apapun.
 */

async function login(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login gagal: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteClaimFilesByUser(baseUrl, accessToken, userId) {
  const res = await fetch(`${baseUrl}/api/v1/claim-files/bulk-delete-by-user/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Hapus claim_files gagal: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function deletePendingFilesByUser(baseUrl, accessToken, userId) {
  const res = await fetch(`${baseUrl}/api/v1/records/pending-files/bulk-delete-by-user/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Hapus pending-files gagal: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const userId = process.argv[2];
  const confirmed = process.argv.includes('--yes');

  if (!userId) {
    console.error('Pakai: node scripts/cleanupTestAccount.js <user_id_akun_test> --yes');
    process.exit(1);
  }

  console.log(`Target: SEMUA claim_files + bpjs_pending_files milik user_id = ${userId}`);
  console.log('ai_training_examples TIDAK akan disentuh (hasil training Kimi tetap aman).');

  if (!confirmed) {
    console.log('\nDRY-RUN — tidak ada yang dihapus. Tambahkan --yes untuk benar-benar menghapus.');
    return;
  }

  const baseUrl = process.env.TEST_API_BASE || 'https://api.medaudit.my.id';
  const username = process.env.TEST_USER;
  const password = process.env.TEST_PASSWORD;
  if (!username || !password) {
    console.error('Set env var TEST_USER dan TEST_PASSWORD dulu (akun admin/supervisor).');
    process.exit(1);
  }
  const session = await login(baseUrl, username, password);
  console.log(`Login berhasil sebagai ${session.user.email} (${session.user.role}).`);

  const pendingResult = await deletePendingFilesByUser(baseUrl, session.access_token, userId);
  console.log(`Pending: ${pendingResult.deletedFiles} file pending + ${pendingResult.deletedResponses} baris dihapus.`);

  const claimResult = await deleteClaimFilesByUser(baseUrl, session.access_token, userId);
  console.log(`Claim: ${claimResult.deleted} claim_files dihapus (cascade ke claim_records & validation_errors).`);

  console.log('\nSelesai. Data test bulan ini sudah bersih — siap upload ulang dari bulan 1.');
}

main().catch(err => {
  console.error('Script gagal total:', err);
  process.exit(1);
});
