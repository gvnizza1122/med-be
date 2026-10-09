require('dotenv').config();

// Dipasang paling awal (sebelum modul lain sempat log apa pun) supaya
// SEMUA console.log/warn/error dan uncaught exception ikut tercatat ke file
// persisten (lihat services/logger.js) — sebelumnya log cuma ke stdout
// docker yang hilang total tiap `docker compose up --build`.
require('./services/logger').installPersistentLogging();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const { getDb, closeDb } = require('./database/init');

// Routes
const authRoutes = require('./routes/auth');
const claimFileRoutes = require('./routes/claimFiles');
const validationRuleRoutes = require('./routes/validationRules');
const dashboardRoutes = require('./routes/dashboard');
const userRoutes = require('./routes/users');
const bridgingRoutes = require('./routes/bridging');
const hospitalSettingsRoutes = require('./routes/hospitalSettings');
const prbExemptRoutes = require('./routes/prbExempt');
const bpjsPendingRoutes = require('./routes/bpjsPending');
const jawabPendingRoutes = require('./routes/jawabPending');
const auditLogRoutes = require('./routes/auditLogs');
const aiUsageRoutes = require('./routes/aiUsage');
const testingPendingRoutes = require('./routes/testingPending');
const codeDescriptionRoutes = require('./routes/codeDescriptions');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST']
  }
});

app.set('io', io);

// Middleware
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: corsOrigins,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Terlalu banyak request. Coba lagi dalam 1 menit.' }
});
app.use('/api/', limiter);

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Startup JWT secrets validation
const jwtSecret = process.env.JWT_SECRET;
const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  if (!jwtSecret || jwtSecret === 'eclaim-secret') {
    console.error('❌ FATAL: JWT_SECRET wajib dikonfigurasi secara aman di mode production!');
    process.exit(1);
  }
  if (!jwtRefreshSecret || jwtRefreshSecret === 'eclaim-refresh-secret') {
    console.error('❌ FATAL: JWT_REFRESH_SECRET wajib dikonfigurasi secara aman di mode production!');
    process.exit(1);
  }
} else {
  if (!jwtSecret || jwtSecret === 'eclaim-secret') {
    console.warn('⚠️ WARNING: Menggunakan JWT_SECRET default/tidak aman. Konfigurasikan JWT_SECRET di .env sebelum masuk production.');
  }
  if (!jwtRefreshSecret || jwtRefreshSecret === 'eclaim-refresh-secret') {
    console.warn('⚠️ WARNING: Menggunakan JWT_REFRESH_SECRET default/tidak aman. Konfigurasikan JWT_REFRESH_SECRET di .env sebelum masuk production.');
  }
}

// Startup SIMRS bridging API key validation
const simrsApiKey = process.env.SIMRS_API_KEY;
if (isProd) {
  if (!simrsApiKey || simrsApiKey === 'eclaim-simrs-secret-key-12345') {
    console.error('❌ FATAL: SIMRS_API_KEY wajib dikonfigurasi secara aman di mode production!');
    process.exit(1);
  }
} else if (!simrsApiKey || simrsApiKey === 'eclaim-simrs-secret-key-12345') {
  console.warn('⚠️ WARNING: Menggunakan SIMRS_API_KEY default/tidak aman. Konfigurasikan SIMRS_API_KEY di .env sebelum masuk production.');
}

// Initialize database with retry
async function waitForDb(retries = 10, delay = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await getDb().initialize();
      console.log('   Database connected successfully');
      return;
    } catch (err) {
      console.error(`   DB connection attempt ${i}/${retries} failed:`, err.message);
      if (i < retries) {
        console.log(`   Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error('❌ FATAL: Cannot connect to database after all retries.');
        process.exit(1);
      }
    }
  }
}

// Rate limiting khusus login (maksimal 20 request per 15 menit)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' }
});

// Routes
app.use('/api/v1/auth/login', loginLimiter);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/claim-files', claimFileRoutes);
app.use('/api/v1/validation-rules', validationRuleRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/bridging', bridgingRoutes);
app.use('/api/v1/hospital-settings', hospitalSettingsRoutes);
app.use('/api/v1/katalog-pedoman', require('./routes/katalogPedoman'));
app.use('/api/v1/kartu-persyaratan', require('./routes/kartuPersyaratan'));
app.use('/api/v1/prb-exempt', prbExemptRoutes);
app.use('/api/v1/audit-logs', auditLogRoutes);
app.use('/api/v1/ai-usage', aiUsageRoutes);
app.use('/api/v1/testing-pending', testingPendingRoutes);
app.use('/api/v1/code-descriptions', codeDescriptionRoutes);
// BUG LAMA yang ditemukan & diperbaiki di sesi ini: recordsRouter
// (rv20-confirm, audit, batch-audit) diexport tapi TIDAK PERNAH di-mount di
// entry point produksi (src/index.js) — cuma ada di src/server.js yang tidak
// dipakai (package.json "start"/"dev" keduanya jalankan src/index.js).
// Endpoint /api/v1/records/* jadi 404 di production. Ditambahkan di sini,
// plus router baru untuk fitur Jawaban Pending BPJS (item 9).
app.use('/api/v1/records', validationRuleRoutes.recordsRouter);
app.use('/api/v1/records', bpjsPendingRoutes);
// Alur Menjawab Pending BPJS (SEP, pemetaan alasan, triase 4 kotak, draf berbukti).
app.use('/api/v1/pending-jawaban', jawabPendingRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ponytail: dev-only static serve for testing PDF uploads
if (!isProd) {
  app.use('/dev/data-claim', express.static(path.resolve(__dirname, '../../data-claim')));
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Error handling middleware
app.use(require('./middleware/uploadLimitError'));
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  // Pesan penolakan tipe file dari fileFilter multer (mis. "Hanya file TXT...",
  // "Hanya file PDF yang diperbolehkan.") — selalu tampilkan apa adanya ke user,
  // ini bahasa awam yang sudah ramah, jangan jatuh ke 500 generic.
  if (err.message && /^Hanya file/i.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: 'Terjadi kesalahan internal server.' });
});

// Start server (wait for DB first)
const PORT = process.env.PORT || 5000;
// Penerimaan file besar dan analisis tidak dihentikan karena durasi.
server.requestTimeout = 0;
server.timeout = 0;
server.headersTimeout = 60000; // hanya penerimaan header, bukan isi file/analisis
if (require.main === module) {
waitForDb().then(() => {
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏥 BPJS Claim Validator API Server`);
  console.log(`   Server running on http://0.0.0.0:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   CORS: ${process.env.CORS_ORIGIN || 'http://localhost:3000'}\n`);
  // Telaah butir kartu persyaratan (ditolak tidak dipakai agen) dimuat ke memori.
  require('./services/kartuPersyaratanService').muatTelaah(getDb())
    .catch(e => console.warn('   Telaah kartu persyaratan belum dimuat:', e.message));
  // Hasil casemix tersimpan hanya sebagai pembanding kasus, bukan kalibrasi
  // severity otomatis untuk analisis atau grouper mandiri pasien lain.
  // Unggahan yang terhenti karena server dimulai ulang dilanjutkan otomatis.
  setTimeout(() => {
    claimFileRoutes.lanjutkanProsesTerputus(io)
      .then(n => { if (n) console.log(`   ${n} unggahan terputus dilanjutkan otomatis.`); })
      .catch(e => console.warn('   Gagal melanjutkan unggahan terputus:', e.message));
  }, 3000);
});
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  closeDb();
  server.close();
  process.exit(0);
});
}

module.exports = app;
