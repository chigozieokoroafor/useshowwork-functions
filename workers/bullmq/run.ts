import "dotenv/config";

import { Worker } from "bullmq";
import { getRedisConnection, getSharedRedisClient } from "../../lib/redis";
import { PUBLISHING_QUEUE_NAME, type PublishJobData } from "../../lib/queues/publishingQueue";
import { BACKGROUND_QUEUE_NAME, type BackgroundJobData, registerRepeatableBackgroundJobs } from "../../lib/queues/backgroundQueue";
import { CONTENT_GENERATION_QUEUE_NAME, type ContentGenerationJobData, enqueueContentGenerationJob } from "../../lib/queues/contentGenerationQueue";
import { processPublishJob } from "./publishingProcessor";
import { processBackgroundJob } from "./backgroundProcessor";
import { processContentGenerationJob } from "./contentGenerationProcessor";
import { claimNextPendingAiGenerationJob, ensureAiGenerationJobTable } from "../../lib/aiGenerationJob";
import { db } from "../../lib/db";

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor !== 22 && nodeMajor !== 25) {
    console.warn(`[Showwork Workers] Warning: running on Node ${process.versions.node}. Supported versions: 22, 25.`);
  }

  const args = process.argv.slice(2);
  const command = args[0] || "--run";

  if (!["--run", "--check", "--reconcile"].includes(command)) {
    console.error("Invalid command. Usage: node run-workers.mjs [--run | --check | --reconcile]");
    process.exit(1);
  }

  // Health check mode
  if (command === "--check") {
    let redisOk = false;
    let dbOk = false;
    const openaiOk = Boolean(process.env.OPENAI_API_KEY);

    try {
      const redis = getSharedRedisClient();
      const pong = await redis.ping();
      redisOk = pong === "PONG";
    } catch (err) {
      console.error("[Health] Redis check failed:", err);
    }

    try {
      await db.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch (err) {
      console.error("[Health] Database check failed:", err);
    }

    const health = {
      system: "all-workers",
      status: redisOk && dbOk ? "healthy" : "unhealthy",
      redis: redisOk ? "connected" : "disconnected",
      database: dbOk ? "connected" : "disconnected",
      openai: openaiOk ? "configured" : "missing",
      workers: ["publishing", "background", "content-generation", "ai-polling"],
      nodeVersion: process.versions.node,
      timestamp: new Date().toISOString(),
    };

    console.log(JSON.stringify(health, null, 2));
    process.exit(redisOk && dbOk ? 0 : 1);
  }

  // Reconcile mode: single scan for due posts
  if (command === "--reconcile") {
    console.log("[Workers] Running one-off scheduled posts reconciliation...");
    const result = await processBackgroundJob({
      id: "manual-reconcile",
      name: "scheduled-publishing-scanner",
      data: { jobType: "scheduled-publishing-scanner" },
    } as any);
    console.log("[Workers] Reconciliation complete:", result);
    process.exit(0);
  }

  // --run mode (Unified All-Workers Service)
  console.log("====================================================");
  console.log("       SHOWWORK UNIFIED WORKER SERVICE              ");
  console.log("  (Publishing, Background Crons & AI Content Gen)   ");
  console.log("====================================================");
  console.log(`Node: ${process.versions.node} | Time: ${new Date().toISOString()}`);

  if (!process.env.OPENAI_API_KEY) {
    console.warn("[Workers] Warning: OPENAI_API_KEY is not configured. AI content generation jobs will fail.");
  }

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

  console.log("Starting Background Tasks Worker (Concurrency: 2)...");
  const backgroundWorker = new Worker<BackgroundJobData>(
    BACKGROUND_QUEUE_NAME,
    processBackgroundJob,
    {
      connection: getRedisConnection(),
      concurrency: 2,
    }
  );

  console.log("Starting Content Generation Worker (Concurrency: 2)...");
  const contentGenerationWorker = new Worker<ContentGenerationJobData>(
    CONTENT_GENERATION_QUEUE_NAME,
    processContentGenerationJob,
    {
      connection: getRedisConnection(),
      concurrency: 2,
    }
  );

  publishingWorker.on("completed", (job) => {
    console.log(`[Publishing Worker] Job ${job.id} completed! (Post: ${job.data.postId}, Platform: ${job.data.platform})`);
  });

  publishingWorker.on("failed", (job, err) => {
    console.error(`[Publishing Worker] Job ${job?.id} failed: ${err.message}`);
  });

  publishingWorker.on("error", (err) => {
    console.error("[Publishing Worker] Worker error:", err);
  });

  backgroundWorker.on("completed", (job) => {
    console.log(`[Background Worker] Task ${job.name} (ID: ${job.id}) finished.`);
  });

  backgroundWorker.on("failed", (job, err) => {
    console.error(`[Background Worker] Task ${job?.name} failed: ${err.message}`);
  });

  backgroundWorker.on("error", (err) => {
    console.error("[Background Worker] Worker error:", err);
  });

  contentGenerationWorker.on("completed", (job) => {
    console.log(`[AI Content Gen] Job ${job.id} finished for calendar ${job.data.calendarId}.`);
  });

  contentGenerationWorker.on("failed", (job, err) => {
    console.error(`[AI Content Gen] Job ${job?.id} failed: ${err.message}`);
  });

  contentGenerationWorker.on("error", (err) => {
    console.error("[AI Content Gen] Worker error:", err);
  });

  // Ensure table schema
  try {
    await ensureAiGenerationJobTable();
  } catch (err) {
    console.error("[Workers] Table schema check note:", err);
  }

  // Register repeatable background cron jobs in Redis
  try {
    await registerRepeatableBackgroundJobs();
  } catch (err) {
    console.error("[Workers] Warning: Failed to register repeatable crons:", err);
  }

  // Expire stale jobs older than 15 minutes (from dedicated AI worker logic)
  const expireStaleJobs = async () => {
    try {
      const cutoff = new Date(Date.now() - 15 * 60_000);
      const expired = await db.aiGenerationJob.updateMany({
        where: { status: "PENDING", createdAt: { lt: cutoff } },
        data: {
          status: "FAILED",
          httpStatus: 503,
          result: { error: "AI generation could not start in time. Please try again." },
        },
      });
      if (expired.count > 0) {
        console.log(`[AI Worker] Expired ${expired.count} stale pending job(s) older than 15 minutes.`);
      }
    } catch {
      // Non-intrusive cleanup
    }
  };

  // Active polling scanner to pick up pending AI generation jobs from PostgreSQL
  const aiJobInterval = setInterval(async () => {
    if (isShuttingDown) return;
    try {
      await expireStaleJobs();
      const pendingJob = await claimNextPendingAiGenerationJob();
      if (pendingJob) {
        const payload = pendingJob.payload ?? (pendingJob as any).request ?? {};
        console.log(`[AI Worker] Claimed pending AI generation job ${pendingJob.id} from DB, queueing to BullMQ...`);
        await enqueueContentGenerationJob(pendingJob.id, {
          jobId: pendingJob.id,
          calendarId: pendingJob.calendarId,
          creatorId: pendingJob.creatorId,
          payload,
          request: payload,
        });
      }
    } catch (err) {
      console.error("[AI Worker] Job scanner error:", err);
    }
  }, 2500);

  console.log("[Workers] All workers active (Publishing, Background Crons, Content Generation & AI Polling).");

  // Graceful shutdown handling
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Workers] Received ${signal}. Shutting down all workers gracefully...`);

    try {
      clearInterval(aiJobInterval);
      await publishingWorker.close();
      await backgroundWorker.close();
      await contentGenerationWorker.close();
      const redis = getSharedRedisClient();
      await redis.quit();
      await db.$disconnect();
      console.log("[Workers] Clean shutdown finished. Exiting.");
      process.exit(0);
    } catch (err) {
      console.error("[Workers] Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[Workers] Fatal startup error:", err);
  process.exit(1);
});
