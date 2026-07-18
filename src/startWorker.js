/**
 * Background Worker Process
 * Run separately from main server: node src/startWorker.js
 * Processes PDF files from Redis queue with concurrent workers
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDb } = require('./database/init');
const { worker } = require('./workers/pdfProcessingWorker');

console.log('\n' + '='.repeat(60));
console.log('🔄 E-Claim PDF Processing Worker');
console.log('='.repeat(60));

// Initialize database
const db = getDb();
db.initialize()
  .then(() => {
    console.log('✅ Database initialized');
    console.log(`⏱️  Concurrency: ${process.env.WORKER_CONCURRENCY || '5'} workers`);
    console.log('🎯 Queue: pdf-processing');
    console.log('📍 Status: LISTENING\n');
  })
  .catch(err => {
    console.error('❌ Failed to initialize database:', err);
    process.exit(1);
  });

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  console.log('\n\n⏹️  SIGINT received, shutting down gracefully...');
  await worker.close();
  await db.close?.();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n\n⏹️  SIGTERM received, shutting down gracefully...');
  await worker.close();
  await db.close?.();
  process.exit(0);
});

// Worker running message
setTimeout(() => {
  if (worker) {
    console.log('✅ Worker is active and listening for jobs...\n');
  }
}, 1000);

module.exports = { worker };
