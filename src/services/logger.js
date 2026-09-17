const fs = require('fs');
const path = require('path');

/**
 * Logging persisten — sebelumnya SEMUA log (termasuk error/exception) cuma
 * ke stdout, ditangkap docker secara ephemeral. Setiap `docker compose up
 * --build` (yang berarti SETIAP deploy) menghapus total riwayat log lama —
 * ditemukan langsung selama audit teknis 8 Sep 2026 saat riwayat error
 * sebelum jam itu sudah tidak bisa dilihat lagi gara-gara rebuild berkali-
 * kali di hari yang sama.
 *
 * Solusi minimal: tulis ulang console.log/warn/error supaya SELAIN ke stdout
 * (perilaku asli tetap ada, tidak diubah) juga menulis baris JSON ke file
 * harian di LOG_DIR (default /usr/src/app/logs, di-mount sebagai volume di
 * docker-compose.yml supaya bertahan lintas rebuild/redeploy). File dirotasi
 * per hari (nama file mengandung tanggal) dan otomatis dihapus kalau lebih
 * tua dari LOG_RETENTION_DAYS supaya tidak numpuk tanpa batas.
 */

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '30', 10);

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    // Kalau direktori gagal dibuat, logging ke file dilewati diam-diam —
    // stdout asli tetap jalan, jadi aplikasi tidak boleh crash gara-gara ini.
  }
}

function currentLogFile() {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `app-${d}.log`);
}

function writeLine(level, args) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' '),
    });
    fs.appendFile(currentLogFile(), line + '\n', () => {});
  } catch (e) {
    // diam-diam dilewati — logging tidak boleh pernah menjatuhkan aplikasi.
  }
}

function cleanOldLogs() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const full = path.join(LOG_DIR, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch (e) {
    // best-effort, tidak fatal kalau gagal.
  }
}

let installed = false;

function installPersistentLogging() {
  if (installed) return; // idempoten — jangan pasang dua kali kalau dipanggil ulang
  installed = true;
  ensureLogDir();
  cleanOldLogs();

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args) => { originalLog(...args); writeLine('info', args); };
  console.warn = (...args) => { originalWarn(...args); writeLine('warn', args); };
  console.error = (...args) => { originalError(...args); writeLine('error', args); };

  // Uncaught exception & unhandled promise rejection — sebelumnya HANYA
  // crash proses tanpa jejak persisten (kalau container auto-restart,
  // penyebabnya hilang begitu saja). Sekarang dicatat dulu sebelum proses
  // exit (uncaughtException tetap harus exit setelah dicatat — proses dalam
  // state tidak terdefinisi, jangan dilanjutkan).
  process.on('uncaughtException', (err) => {
    writeLine('fatal', [`UNCAUGHT EXCEPTION: ${err.stack || err.message}`]);
    console.error('[FATAL] Uncaught exception:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    writeLine('error', [`UNHANDLED REJECTION: ${reason instanceof Error ? (reason.stack || reason.message) : String(reason)}`]);
    console.error('[ERROR] Unhandled promise rejection:', reason);
  });
}

module.exports = { installPersistentLogging };
