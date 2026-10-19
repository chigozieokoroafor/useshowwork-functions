import dotenv from 'dotenv';
dotenv.config();

import { Worker } from 'bullmq';
import { getRedisConnection, getSharedRedisClient } from '../../lib/redis';
import { PUBLISHING_QUEUE_NAME, type PublishJobData } from '../../lib/queues/publishingQueue';
import { BACKGROUND_QUEUE_NAME, type BackgroundJobData, registerRepeatableBackgroundJobs } from '../../lib/queues/backgroundQueue';
import { CONTENT_GENERATION_QUEUE_NAME, type ContentGenerationJobData, enqueueContentGenerationJob } from '../../lib/queues/contentGenerationQueue';
import { processPublishJob } from './publishingProcessor';
import { processBackgroundJob } from './backgroundProcessor';
import { processContentGenerationJob } from './contentGenerationProcessor';
import { claimNextPendingAiGenerationJob, ensureAiGenerationJobTable } from '../../lib/aiGenerationJob';
import { db } from '../../lib/db';

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== 22 && nodeMajor !== 25) {
    console.warn(`[BullMQ Worker] Warning: running on Node ${process.versions.node}. Supported versions: 22, 25.`);
  }

  const args = process.argv.slice(2);
  const command = args[0] || '--run';

  if (!['--run', '--check', '--reconcile'].includes(command)) {
    console.error('Invalid command. Usage: node run-bullmq.cjs [--run | --check | --reconcile]');
    process.exit(1);
  }

  // Check health mode
  if (command === '--check') {
    let redisOk = false;
    let dbOk = false;

    try {
      const redis = getSharedRedisClient();
      const pong = await redis.ping();
      redisOk = pong === 'PONG';
    } catch (err) {
      console.error('[BullMQ Health] Redis check failed:', err);
    }

    try {
      await db.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch (err) {
      console.error('[BullMQ Health] Database check failed:', err);
    }

    const health = {
      system: 'bullmq-worker',
      status: redisOk && dbOk ? 'healthy' : 'unhealthy',
      redis: redisOk ? 'connected' : 'disconnected',
      database: dbOk ? 'connected' : 'disconnected',
      nodeVersion: process.versions.node,
      timestamp: new Date().toISOString(),
    };

    console.log(JSON.stringify(health, null, 2));
    process.exit(redisOk && dbOk ? 0 : 1);
  }

  // Reconcile mode: single scan for due posts
  if (command === '--reconcile') {
    console.log('[BullMQ] Running one-off scheduled posts reconciliation...');
    const result = await processBackgroundJob({
      id: 'manual-reconcile',
      name: 'scheduled-publishing-scanner',
      data: { jobType: 'scheduled-publishing-scanner' },
    } as any);
    console.log('[BullMQ] Reconciliation complete:', result);
    process.exit(0);
  }

  // --run mode
  console.log('====================================================');
  console.log('       SHOWWORK BULLMQ WORKER SERVICE               ');
  console.log('====================================================');
  console.log(`Node: ${process.versions.node} | Time: ${new Date().toISOString()}`);

  const concurrency = process.env.PUBLISHING_WORKER_CONCURRENCY
    ? parseInt(process.env.PUBLISHING_WORKER_CONCURRENCY, 10)
    : 3;

  console.log(`Starting Publishing Worker (Concurrency: ${concurrency})...`);
  const publishingWorker = new Worker<PublishJobData>(
    PUBLISHING_QUEUE_NAME,
    processPublishJob,
    {
      connection: getRedisConnection(),
      concurrency,
    }
  );

  console.log('Starting Background Tasks Worker (Concurrency: 2)...');
  const backgroundWorker = new Worker<BackgroundJobData>(
    BACKGROUND_QUEUE_NAME,
    processBackgroundJob,
    {
      connection: getRedisConnection(),
      concurrency: 2,
    }
  );

  console.log('Starting Content Generation Worker (Concurrency: 2)...');
  const contentGenerationWorker = new Worker<ContentGenerationJobData>(
    CONTENT_GENERATION_QUEUE_NAME,
    processContentGenerationJob,
    {
      connection: getRedisConnection(),
      concurrency: 2,
    }
  );

  publishingWorker.on('completed', (job) => {
    console.log(`[BullMQ Publishing] Job ${job.id} completed! (Post: ${job.data.postId}, Platform: ${job.data.platform})`);
  });

  publishingWorker.on('failed', (job, err) => {
    console.error(`[BullMQ Publishing] Job ${job?.id} failed: ${err.message}`);
  });

  publishingWorker.on('error', (err) => {
    console.error('[BullMQ Publishing] Worker error:', err);
  });

  backgroundWorker.on('completed', (job) => {
    console.log(`[BullMQ Background] Task ${job.name} (ID: ${job.id}) finished.`);
  });

  backgroundWorker.on('failed', (job, err) => {
    console.error(`[BullMQ Background] Task ${job?.name} failed: ${err.message}`);
  });

  backgroundWorker.on('error', (err) => {
    console.error('[BullMQ Background] Worker error:', err);
  });

  contentGenerationWorker.on('completed', (job) => {
    console.log(`[BullMQ AI Gen] Job ${job.id} finished for calendar ${job.data.calendarId}.`);
  });

  contentGenerationWorker.on('failed', (job, err) => {
    console.error(`[BullMQ AI Gen] Job ${job?.id} failed: ${err.message}`);
  });

  contentGenerationWorker.on('error', (err) => {
    console.error('[BullMQ AI Gen] Worker error:', err);
  });

  // Ensure AiGenerationJob table exists in PostgreSQL
  try {
    await ensureAiGenerationJobTable();
  } catch (err) {
    console.error('[BullMQ] Warning: Failed to bootstrap AiGenerationJob table:', err);
  }

  // Register repeatable background cron jobs in Redis
  try {
    await registerRepeatableBackgroundJobs();
  } catch (err) {
    console.error('[BullMQ] Warning: Failed to register repeatable crons:', err);
  }

  // Active polling scanner to pick up pending AI generation jobs from PostgreSQL
  const aiJobInterval = setInterval(async () => {
    if (isShuttingDown) return;
    try {
      const pendingJob = await claimNextPendingAiGenerationJob();
      if (pendingJob) {
        console.log(`[BullMQ] Discovered pending AI generation job ${pendingJob.id} in DB, queueing...`);
        await enqueueContentGenerationJob(pendingJob.id, {
          jobId: pendingJob.id,
          calendarId: pendingJob.calendarId,
          creatorId: pendingJob.creatorId,
          payload: pendingJob.payload,
        });
      }
    } catch (err) {
      console.error('[BullMQ] Pending AI job scanner error:', err);
    }
  }, 3000);

  console.log('[BullMQ] All workers active and listening for jobs in Redis.');

  // Graceful shutdown handling
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[BullMQ] Received ${signal}. Shutting down gracefully...`);

    try {
      clearInterval(aiJobInterval);
      await publishingWorker.close();
      await backgroundWorker.close();
      await contentGenerationWorker.close();
      const redis = getSharedRedisClient();
      await redis.quit();
      await db.$disconnect();
      console.log('[BullMQ] Clean shutdown finished. Exiting.');
      process.exit(0);
    } catch (err) {
      console.error('[BullMQ] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[BullMQ] Fatal startup error:', err);
  process.exit(1);
});
