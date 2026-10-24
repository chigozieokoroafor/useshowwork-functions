import { setTimeout as delay } from "node:timers/promises";
import { db } from "../../lib/db";
import { runAiGenerationJob } from "../../lib/aiGenerationJobs";

/** Dedicated VPS AI worker. No HTTP listener or publishing tasks. */
export async function runAiWorker(signal?: AbortSignal) {
  for (const name of ["DATABASE_URL", "OPENAI_API_KEY"]) {
    if (!process.env[name]) throw new Error(`Missing required AI worker variable: ${name}`);
  }
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  signal?.addEventListener("abort", shutdown, { once: true });
  if (signal?.aborted) shutdown();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log("AI_WORKER_STARTED");
  try {
    while (!stop.signal.aborted) {
      try {
        // Expired queued work must not start after the UI has reported failure.
        // RUNNING jobs are never replayed: their outcome can be uncertain.
        const cutoff = new Date(Date.now() - 15 * 60_000);
        await db.aiGenerationJob.updateMany({
          where: { status: "PENDING", createdAt: { lt: cutoff } },
          data: { status: "FAILED", httpStatus: 503, result: { error: "AI generation could not start in time. Please try again." } },
        });
        const job = await db.aiGenerationJob.findFirst({
          where: { status: "PENDING", createdAt: { gte: cutoff } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true },
        });
        if (job) {
          await runAiGenerationJob(job.id);
          console.log(JSON.stringify({ event: "AI_JOB_FINISHED", jobId: job.id }));
          continue;
        }
      } catch {
        // Keep credentials, content and raw database/provider errors out of logs.
        console.error("AI_WORKER_ITERATION_FAILED");
      }
      await delay(2000, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    signal?.removeEventListener("abort", shutdown);
    await db.$disconnect();
    console.log("AI_WORKER_STOPPED");
  }
}
