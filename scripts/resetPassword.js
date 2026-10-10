#!/usr/bin/env node
/**
 * Atur ulang password satu akun (mis. superadmin yang passwordnya tidak
 * diketahui lagi). Password diketik di terminal TANPA tampil di layar dan
 * tidak pernah lewat argumen/riwayat shell maupun chat.
 *
 * Pakai di server (harus terminal interaktif, perhatikan -t dan -it):
 *   ssh -t appx "docker exec -it eclaim_api node scripts/resetPassword.js superadmin"
 *
 * Aturan sama dengan Manajemen User: minimal 8 karakter, bcrypt cost 10.
 * Hanya kolom password_hash (dan updated_at) yang diubah.
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { getDb, closeDb } = require('../src/database/init');

function tanyaTersembunyi(pertanyaan) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let bisu = false;
    rl._writeToOutput = (teks) => { if (!bisu) rl.output.write(teks); };
    rl.question(pertanyaan, (jawaban) => { rl.close(); process.stdout.write('\n'); resolve(jawaban); });
    bisu = true;
  });
}

async function main() {
  const akun = String(process.argv[2] || '').trim();
  if (!akun) {
    console.error('Pakai: node scripts/resetPassword.js <username atau email>');
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error('Jalankan dari terminal interaktif (ssh -t ... docker exec -it ...) supaya password bisa diketik tersembunyi.');
    process.exit(1);
  }

  const db = getDb();
  const user = await db.prepare('SELECT id, username, email, role, is_active FROM users WHERE username = ? OR email = ?').get(akun, akun);
  if (!user) {
    console.error(`Akun "${akun}" tidak ditemukan.`);
    process.exit(1);
  }
  console.log(`Akun: ${user.username || user.email} · role ${user.role} · ${user.is_active ? 'aktif' : 'NONAKTIF'}`);

  const baru = await tanyaTersembunyi('Password baru (min. 8 karakter): ');
  if (baru.length < 8) {
    console.error('Password minimal 8 karakter. Tidak ada yang diubah.');
    process.exit(1);
  }
  const ulang = await tanyaTersembunyi('Ketik ulang password baru: ');
  if (ulang !== baru) {
    console.error('Kedua password tidak sama. Tidak ada yang diubah.');
    process.exit(1);
  }

  await db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(bcrypt.hashSync(baru, 10), user.id);
  console.log(`Password akun ${user.username || user.email} sudah diganti. Silakan login dengan password baru.`);
}

main()
  .catch((err) => { console.error('Gagal:', err.message); process.exitCode = 1; })
  .finally(() => closeDb && closeDb());
