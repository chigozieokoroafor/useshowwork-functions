import { drainReliablePublishing } from "./reliableConsumer";
import type { ReliablePublishingStore } from "./reliableStore";
import type { createReliableWorker } from "./reliableWorker";

/** Offline factory, deliberately outside netlify/functions. No credentials,
 * route, function registration or production provider are created by this file.
 * The caller supplies an authenticated staging wake-up and synthetic store. */
export function createStagingConsumerAdapter(input: {
  environment: "isolated-staging";
  authenticate: (request: Request) => Promise<boolean>;
  store: ReliablePublishingStore;
  worker: ReturnType<typeof createReliableWorker>;
  durationMs?: number;
}) {
  if (input.environment !== "isolated-staging") throw new Error("Staging only");
  return async (request: Request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (!await input.authenticate(request)) return new Response(null, { status: 401 });
    // No caller-controlled SQL, job payload, platform, URL or DB destination.
    const reader = request.body?.getReader();
    if (reader) {
      const chunk = await reader.read(); await reader.cancel();
      if (!chunk.done) return new Response(null, { status: 400 });
    }
    const durationMs = input.durationMs ?? 10 * 60_000;
    const timer = setTimeout(() => { void input.worker.close(); }, durationMs);
    try {
      const result = await drainReliablePublishing(input.store, input.worker, { durationMs });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } finally { clearTimeout(timer); await input.worker.close(); }
  };
}
