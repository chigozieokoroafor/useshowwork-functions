import type { Prisma, PrismaClient, SocialPlatform } from "@prisma/client";
import { PUBLISHING_PLATFORMS } from "./state";
import { claimPublishingBatch, failPublishingDispatchBatch, type PublishingClaim } from "./batchClaims";

export const PUBLISHING_DATABASE_CONCURRENCY = 3;
export const PUBLISHING_BATCH_SIZE = 20;
export const PUBLISHING_ADMISSION_MS = 15_000;
export const PUBLISHING_FINISH_MS = 27_000;
const MAX_ROUNDS = 15;
const MAX_CLAIMS = 300; // A bounded burst; further due work stays scheduled.
class PublishingDeadline extends Error {}

// A single shared gate also bounds failure-recovery writes. Round barriers and
// a rotating first platform ensure an earlier platform cannot monopolize it.
export class PublishingDatabaseGate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit = PUBLISHING_DATABASE_CONCURRENCY) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}

export type PublishingBatchDatabase = Pick<PrismaClient, "$transaction">;
export type PublishingBatchOptions = {
  database: PublishingBatchDatabase;
  dispatch?: (claim: PublishingClaim) => Promise<void>;
  startedAt?: number;
  concurrency?: number;
};

export async function runPublishingBatchScheduler(options: PublishingBatchOptions) {
  const startedAt = options.startedAt ?? Date.now();
  const now = new Date(startedAt);
  const database = options.database;
  const site = (process.env.URL || process.env.DEPLOY_URL || "").replace(/\/$/, "");
  if (!options.dispatch && (!site || !process.env.CRON_SECRET)) throw new Error("Publishing scheduler configuration is missing.");
  const concurrency = options.concurrency ?? PUBLISHING_DATABASE_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > PUBLISHING_DATABASE_CONCURRENCY) throw new Error("Publishing concurrency must be between one and three.");
  const gate = new PublishingDatabaseGate(concurrency);
  const admissionDeadline = startedAt + PUBLISHING_ADMISSION_MS;
  const finishDeadline = startedAt + PUBLISHING_FINISH_MS;

  async function transaction<T>(operation: (client: Prisma.TransactionClient) => Promise<T>, recovery = false) {
    return gate.run(async () => {
      const deadline = recovery ? finishDeadline : admissionDeadline;
      if (Date.now() >= deadline) throw new PublishingDeadline();
      // Leave room for connection acquisition and cleanup. Apply the finish
      // deadline even when this is the last admitted operation of the run.
      const remaining = finishDeadline - Date.now();
      if (remaining < 1000) throw new PublishingDeadline();
      const maxWait = Math.min(1500, Math.floor(remaining / 3));
      const timeout = Math.min(2500, Math.max(1, remaining - maxWait - 100));
      return database.$transaction(async client => {
        if (Date.now() >= deadline) throw new PublishingDeadline();
        await client.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
        if (Date.now() >= deadline) throw new PublishingDeadline();
        return operation(client);
      }, { maxWait, timeout });
    });
  }

  const dispatch = options.dispatch ?? (async (claim: PublishingClaim) => {
    const response = await fetch(`${site}/.netlify/functions/publish-post-background`, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ postId: claim.id, platform: claim.platform, dispatchedAt: claim.dispatchedAt.toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Publishing worker dispatch was not acknowledged.");
  });
  const summaries = Object.fromEntries(PUBLISHING_PLATFORMS.map(platform => [platform, { claimed: 0, dispatched: 0, dispatchFailures: 0, stale: 0, deferred: false, errors: 0 }])) as Record<SocialPlatform, { claimed: number; dispatched: number; dispatchFailures: number; stale: number; deferred: boolean; errors: number }>;
  const offset = Math.floor(startedAt / 60_000) % PUBLISHING_PLATFORMS.length;
  let pending = [...PUBLISHING_PLATFORMS.slice(offset), ...PUBLISHING_PLATFORMS.slice(0, offset)];
  const claimedIds = new Map<SocialPlatform, string[]>();
  let rounds = 0;
  let totalClaimed = 0;
  for (; rounds < MAX_ROUNDS && pending.length && totalClaimed < MAX_CLAIMS && Date.now() < admissionDeadline; rounds++) {
    const firstRound = rounds === 0;
    const batchSize = Math.min(PUBLISHING_BATCH_SIZE, Math.floor((MAX_CLAIMS - totalClaimed) / pending.length));
    if (!batchSize) break;
    const results = await Promise.all(pending.map(async platform => {
      const summary = summaries[platform];
      try {
        const batch = await transaction(client => claimPublishingBatch(client, platform, now, batchSize, firstRound, claimedIds.get(platform)));
        // $transaction has resolved: every dispatched ID and timestamp is committed.
        summary.claimed += batch.claims.length; summary.stale += batch.stale;
        totalClaimed += batch.claims.length;
        claimedIds.set(platform, [...(claimedIds.get(platform) ?? []), ...batch.claims.map(claim => claim.id)]);
        const sent = await Promise.allSettled(batch.claims.map(dispatch));
        const failed = batch.claims.filter((_, index) => sent[index].status === "rejected");
        summary.dispatched += batch.claims.length - failed.length;
        summary.dispatchFailures += failed.length;
        if (failed.length) {
          try { await transaction(client => failPublishingDispatchBatch(client, platform, failed), true); }
          catch { summary.errors++; } // Existing 16-minute recovery remains the fallback.
        }
        return batch.claims.length === batchSize;
      } catch (error) {
        if (error instanceof PublishingDeadline) summary.deferred = true;
        else summary.errors++;
        return false;
      }
    }));
    // All platforms finish their round before any platform gets another batch.
    pending = pending.filter((_, index) => results[index]);
  }
  for (const platform of pending) summaries[platform].deferred = true;
  return { platforms: summaries, rounds, durationMs: Date.now() - startedAt, concurrency };
}
