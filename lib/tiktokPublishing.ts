import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import type { Prisma, SocialConnection } from "@prisma/client";
import { db as defaultDb } from "@/lib/db";
import { recordPublishedSocialPost } from "@/lib/socialReporting";
import { freshTikTokConnection, reserveTikTokRequest, TikTokRequestBusyError } from "@/lib/tiktokConnection";
import { requireScopes } from "@/lib/socialTokens";
import { buildCaption, validatePublishContent } from "@/lib/publishing/state";
import { parseTikTokSettings, validateTikTokSettings, tikTokPostInfo, TIKTOK_CONSENT_VERSION } from "@/lib/tiktokSettings";
import { tikTokConsentHash } from "@/lib/tiktokConsent";
import { validateTikTokMedia } from "@/lib/tiktokMedia";
import { queryTikTokCreatorInfo, initTikTokVideoPublish, initTikTokPhotoPublish, checkTikTokPublishStatus, TikTokApiError } from "@/lib/tiktok";

/** Explicit database port for isolated/staged workers; the default export path is unchanged. */
export function createTikTokPublisher(database: typeof defaultDb, services: { freshTikTokConnection: typeof freshTikTokConnection; reserveTikTokRequest: typeof reserveTikTokRequest; recordPublishedSocialPost: typeof recordPublishedSocialPost; complete?: (operation: () => Promise<void>) => Promise<void>; claimInit?: () => Promise<boolean>; onConfirmed?: (data: Record<string, string>) => void; preloadedConnection?: SocialConnection; liveConnectionGuard?: boolean; deferAcceptance?: (reference: string) => Promise<void> }, preload?: (id: string) => Promise<Prisma.CalendarPostGetPayload<{ include: { assets: true } }>>) {
  const db = database;
  const complete = services.complete ?? ((operation: () => Promise<void>) => operation());
  const { freshTikTokConnection, reserveTikTokRequest, recordPublishedSocialPost: reportPublished } = services;
  return async function publishPostToTikTok(postId: string): Promise<void> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/tiktokPublishing.ts#publishPostToTikTok@17"); } /* end-canonical-integration-boundary */

  const post = preload ? await preload(postId) : await db.calendarPost.findUniqueOrThrow({ where: { id: postId }, include: { assets: { orderBy: { displayOrder: "asc" } } } });
  let publishId = post.tikTokPublishId;
  let attempted = !!post.tikTokInitStartedAt;
  const fail = (message: string) => db.calendarPost.update({ where: { id: postId }, data: { tikTokPublishStatus: "FAILED", tikTokPublishError: message } });
  try {
    if (!post.tikTokConsentAccountId || !post.tikTokConsentAt || !post.tikTokConsentBy || post.tikTokConsentVersion !== TIKTOK_CONSENT_VERSION) throw new Error("Review TikTok settings and authorize publishing before scheduling.");
    const stored = services.preloadedConnection ?? await db.socialConnection.findFirst({ where: { calendarId: post.calendarId, platform: "TIKTOK", platformAccountId: post.tikTokConsentAccountId, status: "CONNECTED" } });
    if (!stored) throw new Error("The authorized TikTok account was disconnected or replaced. Review the connected account and authorize again.");
    const connection = await freshTikTokConnection(stored);
    requireScopes(connection, ["video.publish"]);
    const accessToken = connection.accessToken!;
    if (!publishId) {
      if (attempted) throw new Error("The earlier TikTok submission has an uncertain result. Check TikTok before explicitly retrying.");
      const settings = parseTikTokSettings(post.tikTokSettings);
      if (post.tikTokConsentHash !== tikTokConsentHash(post, settings, connection.platformAccountId)) throw new Error("The post changed after authorization. Review and authorize publishing again.");
      await reserveTikTokRequest(connection.platformAccountId, "creator");
      const creator = await queryTikTokCreatorInfo(accessToken);
      const video = post.assets.some(a => a.mediaType === "VIDEO");
      validateTikTokSettings(settings, creator, video);
      validatePublishContent("TIKTOK", post.assets, buildCaption(post), post.postType);
      const preparedAssets = await validateTikTokMedia(post.assets, creator, { publish: true });
      await reserveTikTokRequest(connection.platformAccountId, "init");
      // Recheck both the connection and the post immediately before transfer.
      if (!services.liveConnectionGuard) {
        const current = await db.socialConnection.findUniqueOrThrow({ where: { id: connection.id } });
        if (current.status !== "CONNECTED" || current.platformAccountId !== post.tikTokConsentAccountId) throw new Error("The TikTok account was disconnected. Review authorization again.");
      }
      const claimed = services.claimInit ? { count: await services.claimInit() ? 1 : 0 } : await db.calendarPost.updateMany({ where: { id: postId, updatedAt: post.updatedAt, approvalStatus: "APPROVED", tikTokPublishStatus: "PUBLISHING", tikTokInitStartedAt: null }, data: { tikTokInitStartedAt: new Date() } });
      if (!claimed.count) return;
      attempted = true;
      const info = tikTokPostInfo(settings, creator, video);
      let result;
      try {
        result = video
          ? await initTikTokVideoPublish({ accessToken, videoUrl: preparedAssets[0].url, caption: buildCaption(post), privacyLevel: settings.privacyLevel!, disableComment: info.disable_comment, postInfo: info })
          : await initTikTokPhotoPublish({ accessToken, photoUrls: preparedAssets.map(a => a.url), caption: buildCaption(post), photoTitle: settings.photoTitle, privacyLevel: settings.privacyLevel!, disableComment: info.disable_comment, postInfo: info, isAigc: settings.isAigc });
      } catch (error) {
        // A definite API rejection is safe to retry. Network/5xx ambiguity is not.
        if (error instanceof TikTokApiError && error.status < 500) {
          attempted = false;
          await db.calendarPost.update({ where: { id: postId }, data: { tikTokInitStartedAt: null } });
        }
        throw error;
      }
      if (!result.publish_id) throw new Error("TikTok did not confirm a publish reference. Check TikTok before retrying.");
      publishId = result.publish_id;
      if (services.deferAcceptance) { await services.deferAcceptance(publishId); return; }
      await db.calendarPost.update({ where: { id: postId }, data: { tikTokPublishId: publishId } });
    }
    await reserveTikTokRequest(connection.platformAccountId, "status");
    const result = await checkTikTokPublishStatus(accessToken, publishId);
    if (result.status === "FAILED") { await fail(`TikTok could not publish this post (${result.fail_reason || "unknown_error"}). Correct the content and create a new post.`); return; }
    if (result.status !== "PUBLISH_COMPLETE") {
      // Persist the provider operation; minute-based reconciliation polls it later.
      await db.calendarPost.update({ where: { id: postId }, data: { tikTokPublishStatus: "PUBLISHING", publishWorkerStartedAt: null, tikTokPublishError: null } });
      return;
    }
    const publishedAt = new Date();
    const platformPostId = result.publicaly_available_post_id?.[0] != null ? String(result.publicaly_available_post_id[0]) : null;
    services.onConfirmed?.({ tikTokPublishStatus: "PUBLISHED", tikTokPublishedAt: publishedAt.toISOString(), tikTokPublishId: publishId });
    await complete(async () => {
    await db.calendarPost.update({ where: { id: postId }, data: { tikTokPublishStatus: "PUBLISHED", tikTokPublishedAt: publishedAt, tikTokPublishError: null } });
    try { await reportPublished({ calendarId: post.calendarId, calendarPostId: postId, platform: "TIKTOK", platformAccountId: connection.platformAccountId, platformPostId, providerReference: publishId, publishedAt, platformPostType: post.postType }); }
    catch { console.error(`Could not link TikTok post ${postId} to reporting.`); }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TikTok publishing failed. Please try again.";
    if (publishId) {
      // Status/network errors cannot turn an accepted post into another init.
      await db.calendarPost.update({ where: { id: postId }, data: { tikTokPublishStatus: "PUBLISHING", publishWorkerStartedAt: null, tikTokPublishError: `Waiting for TikTok confirmation. ${message}` } });
    } else if (!attempted && (error instanceof TikTokRequestBusyError || (error instanceof TikTokApiError && error.code === "rate_limit_exceeded"))) {
      await db.calendarPost.update({ where: { id: postId }, data: { tikTokPublishStatus: "SCHEDULED", publishWorkerStartedAt: null, tikTokPublishError: message } });
    } else await fail(attempted ? `${message} The submission result is uncertain. Check TikTok before retrying.` : message);
  }
  };
}

export async function publishPostToTikTok(postId: string): Promise<void> {
  return createTikTokPublisher(defaultDb, { freshTikTokConnection, reserveTikTokRequest, recordPublishedSocialPost })(postId);
}
