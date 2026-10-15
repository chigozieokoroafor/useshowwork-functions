import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed, assertLegacyFactoryNotRetired } from "@/lib/publishing/applicationBoundary";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DurableJob, ReliablePublishingStore, PublicationProof } from "./reliableStore";
import { PublishingDatabaseGate } from "./batchScheduler";

/** Future integration hooks must preserve paid access, approval, consent, media
 * validation and all existing provider behavior. No production worker imports this. */
export type PublishingProviderResult = string | { state: "published"; reference: string; reportingComplete: boolean } | { state: "finalization-pending"; reference: string } | { state: "accepted"; durable?: boolean; reference: string } | { state: "rejected"; reason: string; resetTikTokInit?: boolean } | { state: "retryable"; reason: string; resetTikTokInit?: boolean };
export function createReliableWorker(store: ReliablePublishingStore, external: (job: DurableJob, signal: AbortSignal) => Promise<PublishingProviderResult>, options: { externalTimeoutMs?: number; shutdownGraceMs?: number; concurrency?: number; lateBoundary?: boolean; accountAware?: boolean; preflightMany?: (jobs: DurableJob[]) => Promise<void>; preflight?: (job: DurableJob, signal: AbortSignal) => Promise<void | { accountId: string }>; afterJob?: (job: DurableJob) => void; abortOutcome?: (job: DurableJob) => PublishingProviderResult | undefined; knownProof?: (job: DurableJob) => PublicationProof | undefined; knownReference?: (job: DurableJob) => string | undefined } = {}) {
/* canonical-only-helper */
  assertLegacyFactoryNotRetired("lib/publishing/reliableWorker.ts#createReliableWorker");
/* end-canonical-only-helper */
  let stopping = false;
  const active = new Set<Promise<unknown>>();
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error("Invalid worker concurrency");
  const gate = new PublishingDatabaseGate(concurrency);
  const platforms = new Set<string>();
  const jobsInFlight = new Set<string>();
  const controllers = new Set<AbortController>();
  const externalTimeoutMs = options.externalTimeoutMs ?? 12 * 60_000;
  const shutdownGraceMs = options.shutdownGraceMs ?? 5000;
  if (!Number.isInteger(externalTimeoutMs) || externalTimeoutMs < 1 || externalTimeoutMs > 12 * 60_000 || !Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 1 || shutdownGraceMs > 10_000) throw new Error("Invalid worker deadline");
  async function execute(job: DurableJob, ownedToken?: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableWorker.ts#execute@21"); } /* end-canonical-integration-boundary */

    // An owned token is created privately by runBatch in this live worker. Queue
    // retries never resume a database token; they must claim with a new UUID.
    const token = ownedToken ?? randomUUID();
    let prepared = !!ownedToken;
    if (!ownedToken) {
      try { prepared = (await store.prepare(job, token)).length === 1; }
      catch { const saved = await store.findJob(job.id).catch(() => null); prepared = saved?.phase === "PREPARED" && saved.workerToken === token; }
    }
    if (!prepared) return { state: "deferred" };
    if (stopping) return { state: "prepared-for-recovery" };
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), externalTimeoutMs);
    const interrupted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Publishing operation aborted")), { once: true }));
    let accountId: string | undefined;
    let accountOwned = false;
    let accountSafeToRelease = false;
    try {
    if (options.preflight) {
      try { accountId = (await Promise.race([options.preflight(job, controller.signal), interrupted]))?.accountId; }
      catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (code === "PUBLISHING_UNCERTAIN") {
          await store.unknown(job, token, (error as { reference?: string | null }).reference).catch(() => {});
          return { state: "outcome-unknown" };
        }
        const retry = controller.signal.aborted || /^P\d{4}$/.test(code) || code === "PUBLISHING_DEFERRED";
        await store.reject(job, token, error instanceof Error ? error.message : "Validation failed", retry).catch(() => {});
        return { state: retry ? "deferred" : "rejected" };
      }
    }
    if (options.accountAware) {
      if (!accountId) return { state: "deferred" };
      // Same-token acquisition is idempotent and precedes all provider IO; a
      // lost reply can safely be verified by repeating this conditional claim.
      for (let attempt=0; attempt<2 && !accountOwned; attempt++) {
        try { accountOwned = await store.acquireAccount(job,token,accountId); if (!accountOwned) break; } catch { /* no SDK has run */ }
      }
      if (!accountOwned) return { state: "deferred" };
    }
    let begun = !!options.lateBoundary;
    const beginDeadline = performance.now() + 10_000;
    while (!begun && !stopping && performance.now() < beginDeadline) {
      try { begun = (await store.beginExternal(job, token, undefined, accountId)).length === 1; if (!begun) break; }
      catch (error) {
      if ((error as { code?: string }).code === "PUBLISHING_DEFERRED") { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
      // Only this live attempt knows it has not yet called external(). An expired
      // process never resumes EXTERNAL_PENDING as a new publish attempt.
      const saved = await store.findJob(job.id).catch(() => null);
      begun = saved?.phase === "EXTERNAL_PENDING" && saved.workerToken === token;
      if (begun) break;
      // A busy slot must not strand an otherwise valid prepared job for 30s.
      // Retry this storage boundary only while the same token still owns it.
      if (saved?.phase !== "PREPARED" || saved.workerToken !== token || (error as { code?: string }).code !== "PUBLISHING_DEFERRED") break;
      await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    if (!begun) return { state: "deferred" };
    let providerResult: PublishingProviderResult;
    try {
      providerResult = await Promise.race([external({ ...job, workerToken: token }, controller.signal), interrupted]);
      accountSafeToRelease = true; // The provider task has settled.
    } catch (error) {
      const stoppedBeforeSend = controller.signal.aborted ? options.abortOutcome?.(job) : undefined;
      if (stoppedBeforeSend) { providerResult = stoppedBeforeSend; accountSafeToRelease = true; }
      else {
        const proof = (error as { proof?: PublicationProof })?.proof ?? options.knownProof?.(job);
        const reference = (error as { reference?: string | null })?.reference ?? proof?.reference ?? options.knownReference?.(job);
        await store.unknown(job, token, reference, proof).catch(() => {}); return { state: "outcome-unknown" };
      }
    }
    if (typeof providerResult !== "string") {
      if (providerResult.state === "rejected" || providerResult.state === "retryable") {
        await store.reject(job, token, providerResult.reason, providerResult.state === "retryable", providerResult.resetTikTokInit).catch(() => {});
        return { state: providerResult.state };
      }
      if (providerResult.state === "finalization-pending") return { state: "finalization-pending" };
      if (providerResult.state === "accepted") {
      if (providerResult.durable) return { state: "provider-pending" };
      // Accepted asynchronous operations are not published posts. Persist the
      // operation reference and let a read-only provider lookup reconcile it.
      try { await store.accept(job, token, providerResult.reference); }
      catch { /* a lost ACK must be verified, never turned into a new init */ }
      const saved = await store.findJob(job.id).catch(() => null);
      if (saved?.phase === "PROVIDER_PENDING" && saved.remoteId === providerResult.reference) return { state: "provider-pending" };
      await store.unknown(job, token, providerResult.reference).catch(() => {});
      return { state: "outcome-unknown" };
      }
    }
    const remoteId = typeof providerResult === "string" ? providerResult : providerResult.reference;
    const reportingComplete = typeof providerResult !== "string" && providerResult.state === "published" && providerResult.reportingComplete;
    // These are DB-only confirmation retries; the external publish is called once.
    const confirmationDeadline = performance.now() + 10_000;
    for (let attempt = 0; attempt < 20 && performance.now() < confirmationDeadline; attempt++) {
      let busy = false;
      try {
        const confirmed = await store.finish(job, token, remoteId, reportingComplete);
        // A returned guarded post update is proof of this committed confirmation.
        // Read-back remains necessary after an ambiguous commit or a lost guard.
        if (Array.isArray(confirmed) && confirmed.length === 1) return { state: "confirmed" };
      } catch (error) { busy = (error as { code?: string }).code === "PUBLISHING_DEFERRED"; /* storage recovery never calls external again */ }
      if (busy) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
      try {
        const saved = await store.findJob(job.id);
        if (saved?.phase === "CONFIRMED" && saved.remoteId === remoteId) return { state: "confirmed" };
      } catch { /* retain the known result for another DB-only confirmation attempt */ }
      if (attempt >= 1) break;
    }
    await store.unknown(job, token, remoteId, options.knownProof?.(job)).catch(() => {});
    return { state: "outcome-unknown" };
    } finally {
      clearTimeout(timer);
      const interruptedSdk = controller.signal.aborted;
      controller.abort(); // Fence any SDK task still unwinding before yielding ownership.
      controllers.delete(controller);
      await store.releasePrepared?.(job.id, token).catch(() => {});
      // Keep the account lease after an interrupted SDK: its request may still
      // be unwinding. Expiry and the job/consumer fence protect the next actor.
      if (accountOwned && (!interruptedSdk || accountSafeToRelease)) await store.releaseAccount(job, token, accountId!).catch(() => {});
    }
  }
  async function run(job: DurableJob) {
    if (stopping) return { state: "stopping" };
    if (typeof job.id !== "string" || !job.id) throw new Error("Invalid durable job ID");
    const task = (async () => {
      // The queue carries an ID, not authority to choose a post/platform/lease.
      const canonical = await store.findJob(job.id);
      if (!canonical) return { state: "deferred" };
      if (canonical.phase === "CONFIRMED") return { state: "confirmed" };
      // A busy platform leaves its next job durable instead of occupying a
      // lifecycle slot. Provider IO never holds a DB slot.
      if (options.accountAware ? jobsInFlight.has(canonical.id) : platforms.has(canonical.platform)) return { state: "deferred" };
      platforms.add(canonical.platform); jobsInFlight.add(canonical.id);
      try { return await gate.run(() => stopping ? Promise.resolve({ state: "stopping" }) : execute(canonical)); }
      finally { platforms.delete(canonical.platform); jobsInFlight.delete(canonical.id); options.afterJob?.(canonical); }
    })();
    active.add(task);
    try { return await task; } finally { active.delete(task); }
  }
  async function close() {
    stopping = true;
    const timer = setTimeout(() => { for (const controller of controllers) controller.abort(); }, shutdownGraceMs);
    try { await Promise.allSettled([...active]); } finally { clearTimeout(timer); }
  }
  async function startBatch(hints: DurableJob[]) {
    if (stopping) return [];
    if (!hints.length || hints.length > 5 || hints.some(j => typeof j.id !== "string" || !j.id)) throw new Error("Invalid job batch");
    const setup = (async () => {
      const found = await store.findJobs([...new Set(hints.map(j => j.id))]);
      const canonical = hints.map(h=>found.find(j=>j.id===h.id)).filter((j): j is DurableJob => !!j);
      const selected = canonical.filter((job, i) => (options.accountAware ? !jobsInFlight.has(job.id) : !platforms.has(job.platform) && canonical.findIndex(j => j.platform === job.platform) === i) && ["READY", "PREPARED"].includes(job.phase));
      if (!selected.length) return [];
      for (const job of selected) { platforms.add(job.platform); jobsInFlight.add(job.id); }
      const requests = selected.map(j => ({ id: j.id, token: randomUUID() }));
      let claimed: DurableJob[];
      try { claimed = await store.prepareMany(requests); }
      catch { claimed = await store.recoverPrepared(requests.map(r => r.token)).catch(() => []); }
      for (const job of selected) if (!claimed.some(j => j.id === job.id)) { platforms.delete(job.platform); jobsInFlight.delete(job.id); options.afterJob?.(job); }
      // A bounded shared snapshot is advisory; execute still performs live
      // authorization and the exact database publication fence.
      if (claimed.length && options.preflightMany) await options.preflightMany(claimed).catch(() => {});
      return claimed.map(job => {
        const result = gate.run(() => stopping ? Promise.resolve({ state: "prepared-for-recovery" }) : execute(job, job.workerToken!));
        const settled = result.finally(() => { platforms.delete(job.platform); jobsInFlight.delete(job.id); options.afterJob?.(job); active.delete(settled); });
        active.add(settled);
        return { id: job.id, platform: job.platform, result: settled };
      });
    })();
    active.add(setup); try { return await setup; } finally { active.delete(setup); }
  }
  async function runBatch(hints: DurableJob[]) { return Promise.all((await startBatch(hints)).map(job => job.result)); }

  const supportsBatch = typeof store.prepareMany === "function" && typeof store.findJobs === "function";
  return { run, runBatch: supportsBatch ? runBatch : undefined, startBatch: supportsBatch ? startBatch : undefined, close, accountAware: !!options.accountAware, available: () => Math.max(0, concurrency - jobsInFlight.size) };
}

/** Reconciliation may read an existing provider operation/result, never create a
 * post. Unknown/no-result stays quarantined rather than being reset for publishing. */
export async function reconcileReliableJob(store: ReliablePublishingStore, id: string, lookupExisting: (job: DurableJob) => Promise<string | { reference: string; reportingComplete: boolean } | { state: "failed"; reference: string; reason: string } | null>) {
  const owner = randomUUID(), leasing = typeof store.claimReconciliation === "function";
  const job = leasing ? await store.claimReconciliation(id, owner) : await store.findJob(id);
  if (!job || !["OUTCOME_UNKNOWN", "PROVIDER_PENDING"].includes(job.phase) || !job.workerToken) return false;
  let resolved = false;
  try {
    const result = await lookupExisting(job);
    if (!result) return false;
    if (typeof result !== "string" && "state" in result && result.state === "failed") {
      await store.failProvider(job,result.reference,result.reason);
      resolved = true; return false; // Resolved failure is never a publication confirmation.
    }
    const remoteId = typeof result === "string" ? result : result.reference;
    const reportingComplete = typeof result !== "string" && "reportingComplete" in result && result.reportingComplete;
    const deadline = performance.now() + 10_000;
    for (let attempt = 0; attempt < 20 && performance.now() < deadline; attempt++) {
      try { await store.finish(job, job.workerToken, remoteId, reportingComplete); }
      catch (error) {
        const saved = await store.findJob(id).catch(() => null);
        if (saved?.phase === "CONFIRMED" && saved.remoteId === remoteId) { resolved = true; break; }
        if ((error as { code?: string }).code !== "PUBLISHING_DEFERRED") throw error;
        await new Promise(resolve => setTimeout(resolve, 250)); continue;
      }
      resolved = (await store.findJob(id))?.phase === "CONFIRMED";
      break;
    }
    return resolved;
  } finally { if (leasing) await store.releaseReconciliation(id, owner, resolved).catch(() => {}); }
}
