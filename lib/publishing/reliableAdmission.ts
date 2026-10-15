import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PUBLISHING_PLATFORMS } from "./state";
import { PublishingDatabaseGate } from "./batchScheduler";
import { PublishingDeferred, type ReliablePublishingStore } from "./reliableStore";

/** Candidate only: atomic claim+outbox; no HTTP worker call or provider side effect
 * occurs in admission. Both Netlify and a VPS can call this same bounded cycle. */
export async function runReliableAdmission(store: ReliablePublishingStore) {
  const begin = performance.now(), now = new Date(), owner = randomUUID();
  const summary = Object.fromEntries(PUBLISHING_PLATFORMS.map(p => [p, { claimed: 0, errors: 0, deferred: false, recoveredCommits: 0 }]));
  const output = { leader: false, skipped: false, rounds: 0, durationMs: 0, controlErrors: 0, platforms: summary };
  if (typeof store.scheduledWorkExists === "function") {
    try {
      if (!await store.scheduledWorkExists()) { output.skipped = true; output.durationMs = performance.now() - begin; return output; }
    } catch { output.controlErrors++; output.skipped = true; output.durationMs = performance.now() - begin; return output; }
  }
  let leader;
  try { leader = await store.leader(owner); }
  catch { output.controlErrors++; try { leader = await store.recoverLeader(owner); } catch { /* fail closed */ } }
  if (!leader) { output.skipped = true; output.durationMs = performance.now() - begin; return output; }
  output.leader = true;
  const offset = Number((leader.epoch - BigInt(1)) % BigInt(5));
  let pending = [...PUBLISHING_PLATFORMS.slice(offset), ...PUBLISHING_PLATFORMS.slice(0, offset)];
  const gate = new PublishingDatabaseGate(2);
  let total = 0;
  try {
    while (pending.length && output.rounds++ < 15 && total < 300 && performance.now() - begin < 15000) {
      const size = Math.min(20, Math.floor((300 - total) / pending.length));
      if (!size) break;
      const again = await Promise.all(pending.map(platform => gate.run(async () => {
        const state = summary[platform];
        if (performance.now() - begin >= 15000) { state.deferred = true; return true; }
        const operation = randomUUID();
        try {
          const jobs = await store.admit(leader!, platform, operation, now, size);
          state.claimed += jobs.length; total += jobs.length;
          return jobs.length === size;
        } catch (error) {
          state.errors++; state.deferred = true;
          // This is a read of durable facts, not a publishing retry. If storage
          // remains unavailable, leave records/outbox untouched for the next tick.
          try {
            const jobs = await store.recoverAdmission(operation);
            if (jobs.length) { state.recoveredCommits++; state.claimed += jobs.length; total += jobs.length; return jobs.length === size; }
          } catch { /* outage is observable through errors/deferred */ }
          const code = (error as { code?: string }).code;
          return (error instanceof PublishingDeferred && code !== "PUBLISHING_FENCED") || !!code && ["PUBLISHING_DEFERRED","P1001","P1002","P1008","P1017","P2024","P2028"].includes(code);
        }
      })));
      pending = pending.filter((_, i) => again[i]);
    }
    for (const p of pending) summary[p].deferred = true;
  } finally {
    try { await store.releaseLeader(leader); } catch { output.controlErrors++; }
    output.durationMs = performance.now() - begin;
  }
  return output;
}
