import type { createPortablePublishingRuntime } from "./portableRuntime";

/** Reviewable adapter configuration only. This module is outside Netlify's
 * function discovery directory and must not be deployed without approval. */
export const stagingScheduledConfig = { schedule: "* * * * *" };
export const stagingConsumerConfig = { background: true };
export function createStagingNetlifyAdapters(input: {
  environment: "isolated-staging";
  enabled: () => boolean;
  authenticate: (request: Request) => Promise<boolean>;
  runtime: ReturnType<typeof createPortablePublishingRuntime>;
  durationMs?: number;
}) {
  if (input.environment !== "isolated-staging") throw new Error("Isolated staging only");
  return {
    scheduled: async () => {
      if (!input.enabled()) throw new Error("Publishing adapter disabled");
      return input.runtime.tick();
    },
    consumer: async (request: Request) => {
      if (!input.enabled()) return new Response(null, { status: 503 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (!await input.authenticate(request)) return new Response(null, { status: 401 });
      const reader = request.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      if (reader) for (;;) {
        const value = await reader.read(); if (value.done) break;
        bytes += value.value.length;
        if (bytes > 512) { await reader.cancel(); return new Response(null, { status: 413 }); }
        chunks.push(value.value);
      }
      let hint: unknown;
      try { hint = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return new Response(null, { status: 400 }); }
      if (!hint || typeof hint !== "object" || Object.keys(hint).join() !== "generation" || typeof (hint as { generation?: unknown }).generation !== "string" || !/^\d{1,18}$/.test((hint as { generation: string }).generation)) return new Response(null, { status: 400 });
      const result = await input.runtime.consume((hint as { generation: string }).generation, input.durationMs);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    },
    close: () => input.runtime.close(),
  };
}
