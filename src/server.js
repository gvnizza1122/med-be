const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { getDb } = require('./database/init');
const authRoutes = require('./routes/auth');
const claimFilesRoutes = require('./routes/claimFiles');
const claimFilesBatchRoutes = require('./routes/claimFilesBatch');
const dashboardRoutes = require('./routes/dashboard');
const validationRulesRoutes = require('./routes/validationRules');
const simrsRoutes = require('./routes/simrs');
const { redisClient } = require('./config/queue');

const app = express();

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));

// Static files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    redis: redisClient.isOpen ? 'connected' : 'disconnected',
  });
});

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/claim-files', claimFilesRoutes);
app.use('/api/v1/claim-files', claimFilesBatchRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/validation-rules', validationRulesRoutes);
app.use('/api/v1/records', validationRulesRoutes.recordsRouter);
app.use('/api/v1/simrs', simrsRoutes);

// Error handling
app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(error.status || 500).json({
    error: error.message || 'Internal Server Error',
    request_id: req.id,
  });
});

const PORT = process.env.PORT || 5000;

// Start server
const server = app.listen(PORT, () => {
  console.log(`\n🚀 E-Claim Backend Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⚙️  API: http://localhost:${PORT}/api/v1`);
  console.log(`🏥 CORS Origin: ${process.env.CORS_ORIGIN || 'http://localhost:3000'}\n`);
});

module.exports = { app, server };
