require('dotenv').config();

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

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

app.set('io', io);

// Middleware
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
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
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    // Batas beda-beda per endpoint (upload-pdf 20MB, upload-batch 50MB, lainnya 10MB) —
    // jangan hardcode satu angka, salah untuk endpoint lain (dulu selalu bilang "10MB").
    const path = req.originalUrl || req.path || '';
    let maxMb = 10;
    if (path.includes('/upload-pdf')) maxMb = 20;
    else if (path.includes('/upload-batch')) maxMb = 50;
    return res.status(400).json({ error: `File terlalu besar. Maksimum ${maxMb}MB.` });
  }

  // Pesan penolakan tipe file dari fileFilter multer (mis. "Hanya file TXT...",
  // "Hanya file PDF yang diperbolehkan.") — selalu tampilkan apa adanya ke user,
  // ini bahasa awam yang sudah ramah, jangan jatuh ke 500 generic.
  if (err.message && /^Hanya file/i.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Jumlah berkas melebihi batas maksimum. Kirim maksimal 10 berkas per permintaan.' });
  }

  res.status(500).json({ error: 'Terjadi kesalahan internal server.' });
});

// Start server (wait for DB first)
const PORT = process.env.PORT || 5000;
waitForDb().then(() => {
server.listen(PORT, () => {
  console.log(`\n🏥 BPJS Claim Validator API Server`);
  console.log(`   Server running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   CORS: ${process.env.CORS_ORIGIN || 'http://localhost:3000'}\n`);
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

module.exports = app;
