import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed, assertLegacyFactoryNotRetired } from "@/lib/publishing/applicationBoundary";
import { runPublishingBatchScheduler, type PublishingBatchDatabase } from "./batchScheduler";
import type { PublishingClaim } from "./batchClaims";

/** A hosting adapter must acknowledge dispatch only after durable acceptance.
 * Worker execution still uses the existing exact database lease guard. */
export interface PublishingTransport {
  dispatch(claim: PublishingClaim): Promise<void>;
  close(): Promise<void>;
}

export interface PublishingLeadership {
  /** Host-local or distributed leadership; database claims remain authoritative.
   * Hold ownership through the complete cycle, including failure cleanup. */
  acquire(minute: number): Promise<null | (() => Promise<void>)>;
}

type RuntimeOptions = {
  database: PublishingBatchDatabase;
  transport: PublishingTransport;
  leadership: PublishingLeadership;
  concurrency?: number;
  clock?: () => number;
};

/** Adds service lifecycle around the same one-minute admission core without
 * changing the deployed Netlify handler. No timer starts on import. */
export function createPublishingRuntime(options: RuntimeOptions) {
/* canonical-only-helper */
  assertLegacyFactoryNotRetired("lib/publishing/runtime.ts#createPublishingRuntime");
/* end-canonical-only-helper */
  const clock = options.clock ?? Date.now;
  let stopping = false;
  let active: Promise<unknown> | undefined;
  let lastMinute: number | undefined;
  let closing: Promise<void> | undefined;

  async function tick() {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/runtime.ts#tick@34"); } /* end-canonical-integration-boundary */

    if (stopping) return { skipped: "stopping" as const };
    if (active) return { skipped: "busy" as const };
    const startedAt = clock();
    const minute = Math.floor(startedAt / 60_000);
    if (lastMinute !== undefined && minute <= lastMinute) return { skipped: "already-run" as const };

    const cycle = (async () => {
      const release = await options.leadership.acquire(minute);
      if (!release) return { skipped: "not-leader" as const };
      try {
        // A shutdown requested during leadership acquisition must not admit jobs.
        if (stopping) return { skipped: "stopping" as const };
        lastMinute = minute;
        return await runPublishingBatchScheduler({
          database: options.database,
          dispatch: claim => options.transport.dispatch(claim),
          concurrency: options.concurrency,
          startedAt,
        });
      } finally { await release(); }
    })();
    active = cycle;
    try { return await cycle; }
    finally { if (active === cycle) active = undefined; }
  }

  async function close() {
    stopping = true;
    closing ??= (async () => {
      // Drain committed dispatch and cleanup before closing its transport.
      if (active) await active.catch(() => {});
      await options.transport.close();
    })();
    return closing;
  }

  return { tick, close, get stopping() { return stopping; } };
}

/** Host supervisor supplies sleep and cancellation. Due-job selection catches up
 * after missed minutes; do not replay historical leases or queue missed ticks. */
export async function runPublishingMinuteLoop(
  runtime: ReturnType<typeof createPublishingRuntime>,
  options: { signal: AbortSignal; sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>; clock?: () => number; onError: (error: unknown) => void },
) {
  const clock = options.clock ?? Date.now;
  try {
    while (!options.signal.aborted) {
      try { await runtime.tick(); }
      catch (error) { options.onError(error); }
      const now = clock();
      const wait = 60_000 - ((now % 60_000 + 60_000) % 60_000);
      try { await options.sleep(wait, options.signal); }
      catch (error) { if (!options.signal.aborted) throw error; }
    }
  } finally { await runtime.close(); }
}
