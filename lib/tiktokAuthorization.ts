import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { runScheduledPublishing } from "@/lib/publishing/scheduler";
import { NextResponse } from "next/server";
import type { CalendarPost, CalendarPostAsset, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getTikTokCreator } from "@/lib/tiktokConnection";
import { parseTikTokSettings, validateTikTokSettings, TIKTOK_CONSENT_VERSION } from "@/lib/tiktokSettings";
import { tikTokConsentHash } from "@/lib/tiktokConsent";
import { validateTikTokMedia } from "@/lib/tiktokMedia";
import { buildCaption, validatePublishContent } from "@/lib/publishing/state";

export async function authorizeTikTokPost(post: CalendarPost & { assets: CalendarPostAsset[] }, actorId: string, body: Record<string, unknown>) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/tiktokAuthorization.ts#authorizeTikTokPost@11"); } /* end-canonical-integration-boundary */

  try {
    const action = body.action;
    if (!["save", "schedule", "publish", "cancel", "retry"].includes(String(action))) throw new Error("Choose a TikTok publishing action.");
    if (["PUBLISHING", "PUBLISHED"].includes(post.tikTokPublishStatus)) throw new Error("This post is already processing or published. Wait for TikTok's result.");
    if (post.tikTokPublishId) throw new Error("This post already has a TikTok operation. Wait for its reconciled result; create a new post to submit different content.");
    const data: Prisma.CalendarPostUpdateManyMutationInput = {
      tikTokConsentAt: null, tikTokConsentBy: null, tikTokConsentAccountId: null,
      tikTokConsentHash: null, tikTokConsentVersion: null, publishWorkerStartedAt: null,
      tikTokPublishStatus: "NOT_SCHEDULED", tikTokPublishError: null,
    };
    if (action === "cancel") {
      if (post.tikTokPublishStatus !== "SCHEDULED") throw new Error("This post is not scheduled.");
    } else {
      if (post.tikTokPublishStatus === "SCHEDULED") throw new Error("Cancel scheduling before changing TikTok settings.");
      if (post.tikTokInitStartedAt && (action !== "retry" || body.confirmedNotPublished !== true)) throw new Error("The previous request has an uncertain result. Check TikTok and confirm it has not published before retrying.");
      const settings = parseTikTokSettings(body.settings);
      const { connection, info } = await getTikTokCreator(post.calendarId);
      if (body.accountId !== connection.platformAccountId) throw new Error("The connected TikTok account changed. Refresh and review the account again.");
      const video = post.assets.some(a => a.mediaType === "VIDEO");
      validateTikTokSettings(settings, info, video);
      data.tikTokSettings = settings;
      data.tikTokPrivacyLevel = settings.privacyLevel as NonNullable<CalendarPost["tikTokPrivacyLevel"]>;
      if (action !== "save") {
        if (post.approvalStatus !== "APPROVED" || post.isAiDraft) throw new Error("Client approval is required before publishing.");
        if (post.tikTokPublishStatus === "FAILED" && (action !== "retry" || body.confirmedNotPublished !== true)) throw new Error("Check TikTok and confirm this post has not published before retrying.");
        if (body.consent !== true) throw new Error("Review the declaration and explicitly authorize TikTok publishing.");
        validatePublishContent("TIKTOK", post.assets, buildCaption(post), post.postType);
        await validateTikTokMedia(post.assets, info);
        data.tikTokConsentAt = new Date(); data.tikTokConsentBy = actorId;
        data.tikTokConsentAccountId = connection.platformAccountId;
        data.tikTokConsentHash = tikTokConsentHash(post, settings, connection.platformAccountId);
        data.tikTokConsentVersion = TIKTOK_CONSENT_VERSION;
        data.tikTokPublishStatus = "SCHEDULED";
        data.tikTokInitStartedAt = null;
        if (action === "publish") data.postDate = new Date();
      }
    }
    const count = await db.calendarPost.updateMany({ where: { id: post.id, updatedAt: post.updatedAt, tikTokPublishStatus: post.tikTokPublishStatus }, data });
    if (!count.count) return NextResponse.json({ error: "The post changed. Refresh and review again." }, { status: 409 });
    if (action === "publish") {
      const result = await runScheduledPublishing(["TIKTOK"], [post.id]);
      return NextResponse.json({ ok: true, status: result.dispatched ? "PUBLISHING" : "SCHEDULED" });
    }
    return NextResponse.json({ ok: true, status: data.tikTokPublishStatus });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not authorize TikTok publishing." }, { status: 400 });
  }
}
