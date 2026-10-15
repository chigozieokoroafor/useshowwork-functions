import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import type { SocialPlatform } from "@prisma/client";
import { db } from "@/lib/db";
import { statusUpdate, statusWhere } from "./state";

export async function runScheduledPublishing(platforms: SocialPlatform[], postIds?: string[]) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/scheduler.ts#runScheduledPublishing@5"); } /* end-canonical-integration-boundary */

  const now = new Date();
  let stale = 0;
  for (const platform of postIds ? [] : platforms) {
    const result = await db.calendarPost.updateMany({ where: { ...statusWhere(platform, "PUBLISHING"), ...(platform === "TIKTOK" ? { tikTokPublishId: null } : {}), updatedAt: { lte: new Date(now.getTime() - 16 * 60_000) } }, data: statusUpdate(platform, "FAILED", "The worker stopped before confirming the result. Check the platform before retrying to avoid duplicates.") });
    stale += result.count;
  }
  const due = await db.calendarPost.findMany({ where: { ...(postIds ? { id: { in: postIds } } : {}), OR: [...platforms.map(platform => statusWhere(platform, "SCHEDULED")), ...(platforms.includes("TIKTOK") ? [{ platform: "TIKTOK" as const, tikTokPublishStatus: "PUBLISHING" as const, tikTokPublishId: { not: null }, OR: [{ publishWorkerStartedAt: null }, { updatedAt: { lte: new Date(now.getTime() - 16 * 60_000) } }] }] : [])], approvalStatus: "APPROVED", isAiDraft: false, postDate: { lte: now } }, orderBy: { postDate: "asc" }, take: 20, select: { id: true, platform: true, tikTokPublishStatus: true, updatedAt: true } });
  const site = (process.env.URL || process.env.DEPLOY_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  let dispatched = 0;
  await Promise.all(due.map(async post => {
    if (!site || !process.env.CRON_SECRET) return;
    const dispatchedAt = new Date();
    const claim = await db.calendarPost.updateMany({ where: { id: post.id, ...statusWhere(post.platform, post.platform === "TIKTOK" && post.tikTokPublishStatus === "PUBLISHING" ? "PUBLISHING" : "SCHEDULED"), updatedAt: post.updatedAt, approvalStatus: "APPROVED", isAiDraft: false }, data: { ...statusUpdate(post.platform, "PUBLISHING"), publishWorkerStartedAt: null, updatedAt: dispatchedAt } });
    if (!claim.count) return;
    try {
      const response = await fetch(`${site}/.netlify/functions/publish-post-background`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify({ postId: post.id, platform: post.platform, dispatchedAt: dispatchedAt.toISOString() }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Publishing dispatch failed (${response.status}).`);
      dispatched++;
    } catch {
      // A timed-out dispatch may already have reached Netlify. Never reset
      // its lease or automatically resend an ambiguous publish request.
      await db.calendarPost.updateMany({ where: { id: post.id, ...statusWhere(post.platform, "PUBLISHING"), publishWorkerStartedAt: null }, data: statusUpdate(post.platform, post.platform === "TIKTOK" && post.tikTokPublishStatus === "PUBLISHING" ? "PUBLISHING" : postIds ? "SCHEDULED" : "FAILED", "Could not confirm worker dispatch. Check the platform before retrying.") });
    }
  }));
  return { checked: due.length, dispatched, stale, configured: Boolean(site && process.env.CRON_SECRET) };
}
