import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "../../lib/publishing/applicationBoundary";
import { schedule } from "@netlify/functions";
import { runPublishingBatchScheduler } from "../../lib/publishing/batchScheduler";
import { db } from "../../lib/db";

// The sole publishing schedule. Provider/media work stays in background workers.
export const handler = schedule("* * * * *", async (/* canonical-host-args */ event,context /* end-canonical-host-args */) => {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { return await invokePublishingEntrypoint<never>("netlify/functions/social-publish-cron.ts#schedule:callback@6",[event,context]); } /* end-canonical-integration-boundary */

  const startedAt = Date.now();
  const site = process.env.URL || process.env.DEPLOY_URL;
  if (!site || !process.env.CRON_SECRET) {
    console.error("Publishing scheduler configuration is missing.");
    return { statusCode: 503 };
  }
  try {
    const result = await runPublishingBatchScheduler({ database: db, startedAt });
    for (const [platform, summary] of Object.entries(result.platforms)) {
      console.info("Publishing scheduler platform completed", { platform, ...summary });
    }
    const failed = Object.values(result.platforms).some(summary => summary.errors || summary.dispatchFailures);
    console.info("Publishing scheduler completed", { durationMs: result.durationMs, rounds: result.rounds, concurrency: result.concurrency, failed });
    return { statusCode: failed ? 503 : 200 };
  } catch {
    console.error("Publishing scheduler could not complete.");
    return { statusCode: 503 };
  }
});
