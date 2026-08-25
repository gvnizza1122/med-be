const { Worker } = require('bullmq');
const { getDb } = require('../database/init');
const { generateAiReview } = require('../services/aiReviewService');
const { recordKnowledge, getRelevantBpjsExamples } = require('../services/errorKnowledgeService');
const { getRelevantKnowledge } = require('../services/errorKnowledgeService');

const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};

// Background worker untuk AI review task
const worker = new Worker('ai-review', async (job) => {
  const startTime = Date.now();
  const { recordId, extractedData, validationErrors, evidencePool } = job.data;
  const db = getDb();

  try {
    console.log(`[AIReviewWorker] Starting review for record: ${recordId}`);

    // Fetch knowledge entries untuk konteks AI review
    const knowledgeEntries = await getRelevantKnowledge(db, validationErrors.map(e => e.rule_id));
    const bpjsExamples = await getRelevantBpjsExamples(db);

    // Jalankan AI review
    const aiReview = await generateAiReview(extractedData, validationErrors, evidencePool, knowledgeEntries, bpjsExamples);

    if (aiReview) {
      // Simpan hasil review ke database
      await db.prepare('UPDATE claim_records SET ai_review = ?, ai_status = ? WHERE id = ?')
        .run(JSON.stringify(aiReview), 'valid', recordId);

      // Record knowledge update untuk RAG (background, jangan block)
      recordKnowledge(db, aiReview.knowledge_updates).catch(kbErr =>
        console.warn(`[AIReviewWorker] Gagal simpan knowledge base: ${kbErr.message}`));
    }

    const duration = Date.now() - startTime;
    console.log(`✅ [AIReviewWorker] Completed review for ${recordId} (${duration}ms)`);

    return {
      success: true,
      recordId,
      duration,
      hasReview: !!aiReview,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ [AIReviewWorker] Failed for ${recordId}: ${error.message}`);

    // Mark record as review failed (tapi tetap accessible, jangan block user)
    await db.prepare('UPDATE claim_records SET ai_status = ? WHERE id = ?')
      .run('error', recordId);

    throw error; // BullMQ will retry based on config
  }
}, {
  connection: redisOptions,
  concurrency: parseInt(process.env.AI_REVIEW_WORKER_CONCURRENCY || '5'),
  maxStalledCount: 2,
  stalledInterval: 30000,
});

// Worker event handlers
worker.on('completed', (job, result) => {
  console.log(`📊 AI Review job ${job.id} completed:`, result);
});

worker.on('failed', (job, error) => {
  console.error(`❌ AI Review job ${job.id} failed (attempt ${job.attemptsMade}):`, error.message);
});

worker.on('error', (error) => {
  console.error('AI Review Worker error:', error);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down AI review worker...');
  await worker.close();
  process.exit(0);
});

module.exports = { worker };
