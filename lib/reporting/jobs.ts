import { randomUUID } from "node:crypto";
import { db } from "../db";
import { canAccessCalendarById } from "../calendarPermissions";
import { SYNC_REPORTING_PLATFORMS, REPORTING_STALE_MS, REPORTING_SCHEDULE_MS, REPORTING_MANUAL_COOLDOWN_MS } from "./capabilities";

const leaseMs = 10 * 60_000;

/** Enqueue only stale accounts. The unique connection row and CAS prevent overlap. */
export async function enqueueReportingSync(calendarId: string, mode: "automatic" | "manual" | "connected" = "automatic") {
  if (!(await canAccessCalendarById(calendarId))) return { queued: false, pending: 0, eligible: 0 };
  const now = new Date();
  const age = mode === "connected" ? 0 : mode === "manual" ? REPORTING_MANUAL_COOLDOWN_MS : REPORTING_STALE_MS;
  const connections = await db.socialConnection.findMany({
    where: { calendarId, platform: { in: [...SYNC_REPORTING_PLATFORMS] }, status: "CONNECTED" },
    select: { id: true, lastSyncAt: true, lastSyncAttemptAt: true },
  });
  for (const connection of connections) {
    if (connection.lastSyncAt && now.getTime() - connection.lastSyncAt.getTime() < age) continue;
    // Cool down failures too; reopening a report must not hammer a provider.
    if (mode !== "connected" && connection.lastSyncAttemptAt && now.getTime() - connection.lastSyncAttemptAt.getTime() < REPORTING_MANUAL_COOLDOWN_MS) continue;
    await (db as any).reportingSyncJob.upsert({
      where: { connectionId: connection.id },
      create: { connectionId: connection.id, calendarId }, update: {},
    });
    await (db as any).reportingSyncJob.updateMany({
      where: { connectionId: connection.id, status: { in: ["COMPLETE", "FAILED"] }, nextAttemptAt: { lte: now } },
      data: { status: "PENDING", attempts: 0, leaseToken: null, leaseUntil: null, nextAttemptAt: now },
    });
  }
  const pending = await (db as any).reportingSyncJob.count({ where: { calendarId, connection: { status: "CONNECTED" }, status: { in: ["PENDING", "RUNNING"] } } });
  return { queued: pending > 0, pending, eligible: connections.length };
}

/** Safe for multiple cron/worker processes. A crashed process leaves recoverable work. */
export async function runNextReportingJob(calendarId?: string) {
  const now = new Date();
  const claimable = {
    ...(calendarId ? { calendarId } : {}),
    OR: [
      { status: "PENDING", nextAttemptAt: { lte: now } },
      { status: "RUNNING", leaseUntil: { lt: now } },
    ],
  };
  const job = await (db as any).reportingSyncJob.findFirst({ where: claimable, orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }] });
  if (!job) return false;
  if (job.attempts >= 3) {
    await (db as any).reportingSyncJob.updateMany({ where: { id: job.id, ...claimable }, data: { status: "FAILED", leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + REPORTING_SCHEDULE_MS) } });
    return true;
  }
  const token = randomUUID();
  const claimed = await (db as any).reportingSyncJob.updateMany({
    where: { id: job.id, ...claimable },
    data: { status: "RUNNING", leaseToken: token, leaseUntil: new Date(Date.now() + leaseMs), attempts: { increment: 1 } },
  });
  if (!claimed.count) return false;
  const ownership = { id: job.id, status: "RUNNING", leaseToken: token };
  const heartbeat = setInterval(() => {
    void (db as any).reportingSyncJob.updateMany({ where: ownership, data: { leaseUntil: new Date(Date.now() + leaseMs) } }).catch(() => {});
  }, 30_000);
  heartbeat.unref();
  try {
    const { syncReportingConnection } = await import("./sync");
    const result = await syncReportingConnection(job.connectionId);
    if (result.status === "FAILED") throw new Error("REPORTING_PROVIDER_FAILED");
    await (db as any).reportingSyncJob.updateMany({ where: ownership, data: { status: "COMPLETE", leaseToken: null, leaseUntil: null, nextAttemptAt: new Date() } });
  } catch {
    const attempts = job.attempts + 1;
    await (db as any).reportingSyncJob.updateMany({ where: ownership, data: {
      status: attempts >= 3 ? "FAILED" : "PENDING", leaseToken: null, leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + (attempts >= 3 ? REPORTING_SCHEDULE_MS : attempts * 60_000)),
    } });
    // Never log access tokens or raw provider payloads.
    console.warn("REPORTING_JOB_RETRY", { jobId: job.id, attempt: attempts });
  } finally { clearInterval(heartbeat); }
  return true;
}

/** Bounded scan, oldest first; recent attempts naturally rotate behind stale accounts. */
export async function scheduleReportingSync() {
  const cutoff = new Date(Date.now() - REPORTING_SCHEDULE_MS);
  const connections = await (db as any).socialConnection.findMany({
    where: { status: "CONNECTED", platform: { in: [...SYNC_REPORTING_PLATFORMS] },
      AND: [{ OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: cutoff } }] },
        { OR: [{ lastSyncAttemptAt: null }, { lastSyncAttemptAt: { lt: cutoff } }] },
        { OR: [{ lastReportingCheckAt: null }, { lastReportingCheckAt: { lt: cutoff } }] }] },
    select: { id: true, calendarId: true }, orderBy: [{ lastReportingCheckAt: { sort: "asc", nulls: "first" } }, { id: "asc" }], take: 100,
  });
  let queued = 0;
  for (const calendarId of new Set(connections.map((connection: any) => connection.calendarId))) {
    const result = await enqueueReportingSync(calendarId as string);
    queued += result.pending;
    // Advance scan coverage only after enqueue/access checking succeeds.
    await (db as any).socialConnection.updateMany({
      where: { id: { in: connections.filter((connection: any) => connection.calendarId === calendarId).map((connection: any) => connection.id) } },
      data: { lastReportingCheckAt: new Date() },
    });
  }
  return queued;
}

