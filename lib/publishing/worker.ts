import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { db } from "@/lib/db";
import { canAccessCalendarById } from "@/lib/calendarPermissions";
import { publishPostToInstagram } from "@/lib/instagramPublishing";
import { publishPostToTikTok } from "@/lib/tiktokPublishing";
import { recordPublishedSocialPost } from "@/lib/socialReporting";
import { freshConnection } from "@/lib/socialTokens";
import { publishFacebook, publishLinkedIn, publishX } from "./providers";
import { buildCaption, validatePublishContent, PUBLISHING_PLATFORMS, publishingStatus, statusUpdate, statusWhere } from "./state";
import type { SocialPlatform } from "@prisma/client";

export async function runPublishJob(postId: string, platform: SocialPlatform, dispatchedAt: Date) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/worker.ts#runPublishJob@11"); } /* end-canonical-integration-boundary */

  if (!PUBLISHING_PLATFORMS.includes(platform)) throw new Error("Unsupported publishing channel.");
  const claimed = await db.calendarPost.updateMany({ where: {
    id: postId, ...statusWhere(platform, "PUBLISHING"), approvalStatus: "APPROVED", isAiDraft: false, publishWorkerStartedAt: null, updatedAt: dispatchedAt,
  }, data: { publishWorkerStartedAt: new Date() } });
  if (claimed.count !== 1) return;
  try {
    const post = await db.calendarPost.findUniqueOrThrow({ where: { id: postId }, include: { assets: { orderBy: { displayOrder: "asc" } } } });
    validatePublishContent(platform, post.assets, buildCaption(post), post.postType);
    if (!(await canAccessCalendarById(post.calendarId))) throw new Error("This workspace is no longer active. Renew access before publishing.");
    if (platform === "INSTAGRAM") await publishPostToInstagram(postId);
    else if (platform === "TIKTOK") { await publishPostToTikTok(postId); return; }
    else {
      const stored = await db.socialConnection.findFirst({ where: { calendarId: post.calendarId, platform, status: "CONNECTED" } });
      if (!stored) throw new Error("Connect this channel before publishing.");
      const connection = await freshConnection(stored);
      const publish = platform === "FACEBOOK" ? publishFacebook : platform === "LINKEDIN" ? publishLinkedIn : publishX;
      const result = await publish(post, connection, async id => { await db.calendarPost.update({ where: { id: postId }, data: { platformPostId: id } }); });
      const publishedAt = new Date();
      await db.calendarPost.update({ where: { id: postId }, data: { publishStatus: "PUBLISHED", publishedAt, platformPostId: result.id, publishPermalink: result.permalink, publishError: null } });
      // Reporting failure must never turn a successful publish into a retry.
      try {
        await recordPublishedSocialPost({ calendarId: post.calendarId, calendarPostId: postId, platform, platformAccountId: connection.platformAccountId, platformPostId: result.id, permalink: result.permalink, publishedAt, platformPostType: post.postType });
      } catch { console.error(`Could not link published ${platform} post ${postId} to reporting.`); }
    }
    const final = await db.calendarPost.findUniqueOrThrow({ where: { id: postId } });
    if (publishingStatus(final) === "PUBLISHING") throw new Error("Publishing ended without a confirmed result. Check the platform before retrying.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publishing failed. Check the platform before retrying.";
    await db.calendarPost.updateMany({ where: { id: postId, ...statusWhere(platform, "PUBLISHING") }, data: statusUpdate(platform, "FAILED", message) });
  }
}
