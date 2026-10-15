import { createHash } from "node:crypto";
import type { PublishingClaim } from "./batchClaims";
import type { PublishingTransport } from "./runtime";
import { PUBLISHING_PLATFORMS } from "./state";

export type PublishingEnvelope = Readonly<{ version: 1; postId: string; platform: PublishingClaim["platform"]; dispatchedAt: string }>;

export function publishingEnvelope(claim: PublishingClaim): PublishingEnvelope {
  if (!claim.id || !PUBLISHING_PLATFORMS.includes(claim.platform) || !Number.isFinite(claim.dispatchedAt.getTime())) throw new Error("Invalid committed publishing lease.");
  return Object.freeze({ version: 1, postId: claim.id, platform: claim.platform, dispatchedAt: claim.dispatchedAt.toISOString() });
}

export interface DurablePublishingQueue {
  /** Resolve only after durable persistence; repeated key+payload must resolve to
   * the same committed job. Ambiguous acknowledgement must throw, never retry here. */
  enqueue(envelope: PublishingEnvelope, idempotencyKey: string): Promise<{ durable: true; idempotencyKey: string }>;
  close(): Promise<void>;
}

export function createDurablePublishingTransport(queue: DurablePublishingQueue): PublishingTransport {
  return {
    async dispatch(claim) {
      const envelope = publishingEnvelope(claim);
      const key = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
      const receipt = await queue.enqueue(envelope, key);
      if (receipt?.durable !== true || receipt.idempotencyKey !== key) throw new Error("Durable publishing acceptance was not confirmed.");
    },
    close: () => queue.close(),
  };
}

/** Explicit adapter for a future hosting-independent caller. The current handler
 * continues using its existing dispatch behavior until a separately approved change. */
export function createNetlifyPublishingTransport(options: { site: string; token: string; fetch?: typeof fetch }): PublishingTransport {
  const site = new URL(options.site);
  if (site.protocol !== "https:" || site.username || site.password || site.search || site.hash || site.pathname !== "/" || !options.token) throw new Error("Invalid publishing transport configuration.");
  const send = options.fetch ?? fetch;
  return {
    async dispatch(claim) {
      const envelope = publishingEnvelope(claim);
      const response = await send(new URL("/.netlify/functions/publish-post-background", site), {
        method: "POST", headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ postId: envelope.postId, platform: envelope.platform, dispatchedAt: envelope.dispatchedAt }),
        signal: AbortSignal.timeout(5000), redirect: "error",
      });
      if (!response.ok) throw new Error("Publishing worker dispatch was not acknowledged.");
    },
    async close() {},
  };
}

/** Queue visibility/ack/retry policy belongs to the selected durable queue.
 * Redelivery passes the exact committed lease to the unchanged worker guard. */
export async function executePublishingEnvelope(
  envelope: unknown,
  runJob: (postId: string, platform: PublishingClaim["platform"], dispatchedAt: Date) => Promise<void>,
) {
  if (!envelope || typeof envelope !== "object" || Object.keys(envelope).sort().join(",") !== "dispatchedAt,platform,postId,version") throw new Error("Invalid publishing envelope.");
  const job = envelope as PublishingEnvelope;
  const date = new Date(job.dispatchedAt);
  if (job.version !== 1 || typeof job.postId !== "string" || !job.postId || !PUBLISHING_PLATFORMS.includes(job.platform) || typeof job.dispatchedAt !== "string" || !Number.isFinite(date.getTime()) || date.toISOString() !== job.dispatchedAt) throw new Error("Invalid publishing lease.");
  await runJob(job.postId, job.platform, date);
}
