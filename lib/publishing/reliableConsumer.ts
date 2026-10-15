import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { performance } from "node:perf_hooks";
import { PUBLISHING_PLATFORMS } from "./state";
import type { ReliablePublishingStore } from "./reliableStore";
import type { createReliableWorker } from "./reliableWorker";

/** Host independent, bounded durable consumer. A Netlify background invocation
 * supplies a deadline; a VPS supervisor repeatedly calls this same core.
 * Wake messages are hints only: PostgreSQL remains the source of job authority.
 * Not imported by any deployed handler. */
export async function drainReliablePublishing(
  store: ReliablePublishingStore,
  worker: ReturnType<typeof createReliableWorker>,
  options: { durationMs: number; rotation?: number; signal?: AbortSignal; idleMs?: number },
) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableConsumer.ts#drainReliablePublishing@10"); } /* end-canonical-integration-boundary */

  if (!Number.isInteger(options.durationMs) || options.durationMs < 1 || options.durationMs > 12 * 60_000) throw new Error("Invalid consumer deadline");
  const start = performance.now();
  const outcomes: Record<string, number> = {};
  const opportunities = Object.fromEntries(PUBLISHING_PLATFORMS.map(p => [p, 0]));
  let cursor = options.rotation ?? 0, errors = 0, rounds = 0;
  await store.recoverExpired();
  if (worker.accountAware) await store.recoverAccountLeases();
  if (worker.startBatch) {
    const active = new Map<string, Promise<void>>();
    while (!options.signal?.aborted && performance.now() - start < options.durationMs) {
      try {
        const candidates = worker.accountAware ? await store.readyFairAccounts(cursor) : await store.readyFair(cursor);
        const jobs = candidates.filter(job => !active.has(worker.accountAware ? job.id : job.platform)).slice(0, Math.min(5, worker.available?.() ?? 5));
        cursor = (cursor + 1) % PUBLISHING_PLATFORMS.length;
        if (jobs.length) {
          rounds++;
          for (const job of jobs) opportunities[job.platform]++;
          for (const task of await worker.startBatch(jobs)) {
            const done = task.result.then(result => { outcomes[result.state] = (outcomes[result.state] ?? 0) + 1; }, () => { errors++; }).finally(() => { active.delete(worker.accountAware ? task.id : task.platform); });
            active.set(worker.accountAware ? task.id : task.platform, done);
          }
        }
        if (!jobs.length && !active.size) break;
        // A slow upload blocks only its platform. Poll periodically so new
        // arrivals on idle platforms get opportunities while that upload runs.
        await Promise.race([...active.values(), new Promise<void>(resolve => setTimeout(resolve, options.idleMs ?? 1000))]);
      } catch { errors++; await new Promise(resolve => setTimeout(resolve, options.idleMs ?? 250)); }
    }
    // Stop admitting at the deadline; existing work completes or is aborted by
    // the host's bounded shutdown. Never count admission as publication.
    await Promise.allSettled([...active.values()]);
    return { durationMs: performance.now() - start, rounds, outcomes, opportunities, errors };
  }
  while (!options.signal?.aborted && performance.now() - start < options.durationMs) {
    const order = PUBLISHING_PLATFORMS.map((_, i) => PUBLISHING_PLATFORMS[(cursor + i) % PUBLISHING_PLATFORMS.length]);
    cursor = (cursor + 1) % PUBLISHING_PLATFORMS.length;
    // Only one oldest eligible job per platform per round. A hot platform
    // cannot fill all lifecycle slots or push another platform behind its backlog.
    const jobs = [];
    if (store.readyFair) {
      try { jobs.push(...await store.readyFair((cursor + PUBLISHING_PLATFORMS.length - 1) % PUBLISHING_PLATFORMS.length)); }
      catch { errors++; await new Promise(resolve => setTimeout(resolve, options.idleMs ?? 100)); continue; }
    } else for (const platform of order) {
      if (options.signal?.aborted || performance.now() - start >= options.durationMs) break;
      try { const ready = await store.ready(platform, 1); if (ready[0]) jobs.push(ready[0]); }
      catch { errors++; }
    }
    if (!jobs.length) break;
    rounds++;
    for (const job of jobs) opportunities[job.platform]++;
    const results = worker.runBatch
      ? await worker.runBatch(jobs).then(values => values.map(value => ({ status: "fulfilled" as const, value }))).catch(() => [{ status: "rejected" as const }])
      : await Promise.allSettled(jobs.map(job => worker.run(job)));
    for (const result of results) {
      if (result.status === "rejected") { errors++; continue; }
      const state = result.value.state;
      outcomes[state] = (outcomes[state] ?? 0) + 1;
    }
    // Avoid a tight retry loop on an outage or globally busy budget. No per-job
    // heartbeat write: preparation and external boundaries are durable leases.
    if (results.every(r => r.status === "rejected" || r.value.state === "deferred")) {
      await new Promise(resolve => setTimeout(resolve, options.idleMs ?? 100));
    }
  }
  return { durationMs: performance.now() - start, rounds, outcomes, opportunities, errors };
}
