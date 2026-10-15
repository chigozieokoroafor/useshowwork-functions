import dotenv from 'dotenv';
dotenv.config();

import { Worker } from 'bullmq';
import { getRedisConnection, getSharedRedisClient } from '../../lib/redis';
import { PUBLISHING_QUEUE_NAME, type PublishJobData } from '../../lib/queues/publishingQueue';
import { BACKGROUND_QUEUE_NAME, type BackgroundJobData, registerRepeatableBackgroundJobs } from '../../lib/queues/backgroundQueue';
import { processPublishJob } from './publishingProcessor';
import { processBackgroundJob } from './backgroundProcessor';
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

  publishingWorker.on('completed', job => {
    console.log(`[BullMQ Publishing] Job ${job.id} completed! (Post: ${job.data.postId}, Platform: ${job.data.platform})`);
  });

  publishingWorker.on('failed', (job, err) => {
    console.error(`[BullMQ Publishing] Job ${job?.id} failed: ${err.message}`);
  });

  publishingWorker.on('error', err => {
    console.error('[BullMQ Publishing] Worker error:', err);
  });

  backgroundWorker.on('completed', job => {
    console.log(`[BullMQ Background] Task ${job.name} (ID: ${job.id}) finished.`);
  });

  backgroundWorker.on('failed', (job, err) => {
    console.error(`[BullMQ Background] Task ${job?.name} failed: ${err.message}`);
  });

  backgroundWorker.on('error', err => {
    console.error('[BullMQ Background] Worker error:', err);
  });

  // Register repeatable background cron jobs in Redis
  try {
    await registerRepeatableBackgroundJobs();
  } catch (err) {
    console.error('[BullMQ] Warning: Failed to register repeatable crons:', err);
  }

  console.log('[BullMQ] All workers active and listening for jobs in Redis.');

  // Graceful shutdown handling
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[BullMQ] Received ${signal}. Shutting down gracefully...`);

    try {
      await publishingWorker.close();
      await backgroundWorker.close();
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

main().catch(err => {
  console.error('[BullMQ] Fatal startup error:', err);
  process.exit(1);
});
