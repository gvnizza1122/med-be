const { Queue, Worker } = require('bullmq');
const redis = require('redis');
require('dotenv').config();

const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  enableOfflineQueue: true,
};

const redisClient = redis.createClient(redisOptions);
const redisSubscriber = redis.createClient(redisOptions);

// Connection handling
redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('✅ Redis Client connected'));

redisSubscriber.on('error', (err) => console.error('Redis Subscriber Error:', err));
redisSubscriber.on('connect', () => console.log('✅ Redis Subscriber connected'));

(async () => {
  await redisClient.connect().catch(e => console.error('Failed to connect Redis:', e));
  await redisSubscriber.connect().catch(e => console.error('Failed to connect Redis Subscriber:', e));
})();

// BullMQ Queue setup
const pdfProcessingQueue = new Queue('pdf-processing', {
  connection: redisOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600 }, // Remove after 1 hour
  },
});

pdfProcessingQueue.on('error', (err) => console.error('Queue Error:', err));
pdfProcessingQueue.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);
});

module.exports = {
  redisClient,
  redisSubscriber,
  pdfProcessingQueue,
  redisOptions,
};
