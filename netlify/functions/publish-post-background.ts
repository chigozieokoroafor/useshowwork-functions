import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "../../lib/publishing/applicationBoundary";
import type { Handler } from "@netlify/functions";
import type { SocialPlatform } from "@prisma/client";
import { PUBLISHING_PLATFORMS } from "../../lib/publishing/state";
import { runPublishJob } from "../../lib/publishing/worker";

export const handler: Handler = async event => {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { return await invokePublishingEntrypoint<never>("netlify/functions/publish-post-background.ts#handler@6",[event]); } /* end-canonical-integration-boundary */

  if (!process.env.CRON_SECRET || event.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return { statusCode: 401, body: "Unauthorized" };
  let body: { postId?: unknown; platform?: unknown; dispatchedAt?: unknown };
  try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid request" }; }
  if (typeof body?.postId !== "string" || !PUBLISHING_PLATFORMS.includes(body.platform as SocialPlatform)) return { statusCode: 400, body: "Invalid publish job" };
  const dispatchedAt = typeof body.dispatchedAt === "string" ? new Date(body.dispatchedAt) : new Date(NaN);
  if (!Number.isFinite(dispatchedAt.getTime())) return { statusCode: 400, body: "Missing publish lease" };
  await runPublishJob(body.postId, body.platform as SocialPlatform, dispatchedAt);
  return { statusCode: 200, body: "Publish job finished" };
};
