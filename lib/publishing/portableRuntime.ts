import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed, assertLegacyFactoryNotRetired } from "@/lib/publishing/applicationBoundary";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { runReliableAdmission } from "./reliableAdmission";
import { drainReliablePublishing } from "./reliableConsumer";
import { reconcileReliableJob, type createReliableWorker } from "./reliableWorker";
import type { ReliablePublishingStore, DurableJob } from "./reliableStore";

/** No deployment registration. Netlify minute/background adapters and a VPS
 * supervisor can use the same lifecycle. All transport destinations are supplied
 * by trusted composition, never by a request or durable job payload. */
export function createPortablePublishingRuntime(input: {
  store: ReliablePublishingStore;
  wake: (hint: { generation: string }) => Promise<void>;
  buildConsumer: (store: ReliablePublishingStore, verify: (job: DurableJob, account: string) => Promise<void>) => {
    worker: ReturnType<typeof createReliableWorker>;
    reconcile: (job: DurableJob) => Promise<string | { reference: string; reportingComplete: boolean } | { state: "failed"; reference: string; reason: string } | null>;
    prepareReconciliation?: (jobs: DurableJob[]) => Promise<void>;
    repairReporting?: (job: DurableJob) => Promise<boolean>;
    close: () => void;
  };
}) {
/* canonical-only-helper */
  assertLegacyFactoryNotRetired("lib/publishing/portableRuntime.ts#createPortablePublishingRuntime");
/* end-canonical-only-helper */
  const active = new Set<Promise<unknown>>(), stop = new AbortController();
  async function deliver() {
    const owner = randomUUID(), wake = await input.store.takeWake(owner);
    if (!wake) return false;
    try { await input.wake({ generation: String(wake.generation) }); return true; }
    finally { await input.store.dispatchedWake(owner); }
  }
  async function tick() {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/portableRuntime.ts#tick@29"); } /* end-canonical-integration-boundary */

    if (stop.signal.aborted) throw new Error("Runtime stopping");
    const admission = await runReliableAdmission(input.store);
    await input.store.recoverExpired();
    if (await input.store.wakeNeeded()) await input.store.requestWake();
    await deliver();
    return admission;
  }
  async function consume(generation: string, durationMs = 10 * 60_000) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/portableRuntime.ts#consume@37"); } /* end-canonical-integration-boundary */

    if (!/^\d{1,18}$/.test(generation) || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 10 * 60_000) throw new Error("Invalid bounded consumer hint");
    if (stop.signal.aborted) return { state: "stopping" };
    const task = (async () => {
      const lease = await input.store.acquireConsumer(randomUUID());
      if (!lease) return { state: "busy" };
      const fenced = { ...input.store,
        prepare: (job: DurableJob, token: string) => input.store.prepare(job, token, lease),
        prepareMany: (requests: { id: string; token: string }[]) => input.store.prepareMany(requests, lease),
        beginExternal: (job: DurableJob, token: string, _consumer?: unknown, account?: string, tikTokInit?: boolean) => input.store.beginExternal(job, token, lease, account, tikTokInit),
      };
      let requireAccountLease = false;
      const consumer = input.buildConsumer(fenced, (job, account) => input.store.assertPublication(job, account, lease, requireAccountLease));
      requireAccountLease = consumer.worker.accountAware;
      let renewing = false, fencedOut = false;
      const heartbeat = setInterval(async () => {
        if (renewing) return; renewing = true;
        try { if (!await input.store.renewConsumer(lease)) { fencedOut = true; await consumer.worker.close(); } }
        catch { fencedOut = true; await consumer.worker.close(); }
        finally { renewing = false; }
      }, 15_000);
      const onStop = () => { void consumer.worker.close(); };
      stop.signal.addEventListener("abort", onStop, { once: true });
      const deadline = setTimeout(onStop, durationMs), started = performance.now();
      let reconciliationStopping = false, reconciliationErrors = 0;
      const reconcile = async () => {
        while (!reconciliationStopping && !stop.signal.aborted && !fencedOut && performance.now() - started < durationMs) {
          try {
          const jobs = await input.store.reconciliationJobs(consumer.prepareReconciliation ? 5 : 2);
          if(jobs.length && consumer.prepareReconciliation) await consumer.prepareReconciliation(jobs);
          await Promise.all(jobs.map(job => reconcileReliableJob(fenced, job.id, consumer.reconcile).catch(() => false)));
          if (consumer.repairReporting) for (const job of await input.store.reportingJobs(2)) {
            if (await consumer.repairReporting(job).catch(() => false)) await input.store.markReported(job.id);
            else await input.store.deferReporting(job.id);
          }
          } catch { reconciliationErrors++; } // Durable jobs remain eligible after a storage outage.
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      };
      let recovery: Promise<void> | undefined;
      try {
        await input.store.acknowledgeWake(BigInt(generation));
        await input.store.recoverExpired();
        recovery = reconcile();
        const summaries = [];
        while (!stop.signal.aborted && !fencedOut && performance.now() - started < durationMs) {
          const round = await drainReliablePublishing(fenced, consumer.worker, { durationMs: Math.max(1, Math.min(60_000, Math.floor(durationMs - (performance.now() - started)))), rotation: lease.id, signal: stop.signal });
          summaries.push(round);
          if (!await input.store.wakeNeeded()) {
            const delay = await input.store.nextWorkDelay(60_000);
            if (delay >= 60_000) break;
            await new Promise(resolve=>setTimeout(resolve,Math.min(delay,5000)));
          }
          if (!round.rounds) {
            // Keep this already-running consumer for a nearby durable retry;
            // do not manufacture another function invocation for each poll.
            const wait = await input.store.nextWorkDelay(5000);
            await new Promise(resolve => setTimeout(resolve,Math.min(wait,Math.max(1,durationMs-(performance.now()-started)))));
          }
        }
        return { state: fencedOut ? "fenced" : "drained", summaries, reconciliationErrors };
      } finally {
        reconciliationStopping = true;
        clearInterval(heartbeat); clearTimeout(deadline); stop.signal.removeEventListener("abort", onStop);
        await consumer.worker.close(); await recovery?.catch(() => {}); consumer.close();
        await input.store.releaseConsumer(lease).catch(() => {});
        // Remaining work gets a durable hint even after timeout/shutdown. A
        // later tick retries delivery; a failed HTTP wake cannot erase the jobs.
        if (await input.store.wakeNeeded().catch(() => true)) await input.store.requestWake().catch(() => {});
      }
    })();
    active.add(task); try { return await task; } finally { active.delete(task); }
  }
  async function close() { stop.abort(); await Promise.allSettled([...active]); }
  return { tick, consume, deliver, close };
}
