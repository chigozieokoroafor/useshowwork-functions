import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import type { SocialPlatform } from "@prisma/client";
import { db } from "@/lib/db";

export type SocialConnectionInput = {
  calendarId: string;
  platform: SocialPlatform;
  platformAccountId: string;
  accountName?: string | null;
  username?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  refreshTokenExpiresAt?: Date | null;
  tokenScopes?: string | null;
};

/** Upserts a server-side normalized account row while preserving legacy callers. */
export function upsertSocialConnection(input: SocialConnectionInput, database: typeof db = db) {
  const { calendarId, platform, platformAccountId, ...values } = input;
  const definedValues = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );

  return database.$transaction(async (tx) => {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/socialReporting.ts#database.$transaction:callback@24"); } /* end-canonical-integration-boundary */

    await tx.socialConnection.updateMany({
      where: {
        calendarId,
        platform,
        status: "CONNECTED",
        platformAccountId: { not: platformAccountId },
      },
      data: {
        status: "DISCONNECTED",
        disconnectedAt: new Date(),
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        ...(platform === "TIKTOK" ? {
          tikTokMessagingAccessToken: null, tikTokMessagingRefreshToken: null,
          tikTokMessagingTokenExpiresAt: null, tikTokMessagingRefreshExpiresAt: null,
          tikTokMessagingScopes: null, tikTokMessagingConnectedAt: null,
          messagingWebhookSubscribedAt: null, messagingWebhookError: null,
        } : {}),
      },
    });
    return tx.socialConnection.upsert({
      where: { calendarId_platform_platformAccountId: { calendarId, platform, platformAccountId } },
      create: { calendarId, platform, platformAccountId, ...definedValues },
      update: {
        ...definedValues,
        status: "CONNECTED",
        disconnectedAt: null,
        lastSyncError: null,
      },
    });
  });
}

export function markSocialConnectionDisconnected(calendarId: string, platform: SocialPlatform) {
  return db.socialConnection.updateMany({
    where: { calendarId, platform },
    data: {
      status: "DISCONNECTED",
      disconnectedAt: new Date(),
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      ...(platform === "TIKTOK" ? {
        tikTokMessagingAccessToken: null, tikTokMessagingRefreshToken: null,
        tikTokMessagingTokenExpiresAt: null, tikTokMessagingRefreshExpiresAt: null,
        tikTokMessagingScopes: null, tikTokMessagingConnectedAt: null,
        messagingWebhookSubscribedAt: null, messagingWebhookError: null,
      } : {}),
      lastSyncError: null,
    },
  });
}

export async function recordPublishedSocialPost({
  calendarId,
  calendarPostId,
  platform,
  platformAccountId,
  platformPostId,
  providerReference,
  permalink,
  publishedAt,
  platformPostType,
}: {
  calendarId: string;
  calendarPostId: string;
  platform: SocialPlatform;
  platformAccountId: string;
  platformPostId?: string | null;
  providerReference?: string | null;
  permalink?: string | null;
  publishedAt: Date;
  platformPostType?: string | null;
}, database: typeof db = db) {
  const connection = await database.socialConnection.findUnique({
    where: { calendarId_platform_platformAccountId: { calendarId, platform, platformAccountId } },
    select: { id: true },
  });
  const usableConnection = connection ?? await upsertSocialConnection({
    calendarId,
    platform,
    platformAccountId,
  }, database);

  return database.publishedSocialPost.upsert({
    where: {
      calendarPostId_socialConnectionId: {
        calendarPostId,
        socialConnectionId: usableConnection.id,
      },
    },
    create: {
      calendarId,
      calendarPostId,
      socialConnectionId: usableConnection.id,
      platform,
      platformPostId: platformPostId ?? null,
      providerReference: providerReference ?? null,
      permalink: permalink ?? null,
      publishedAt,
      platformPostType: platformPostType ?? null,
      status: platformPostId || providerReference ? "PUBLISHED" : "UNAVAILABLE",
    },
    update: {
      platformPostId: platformPostId ?? undefined,
      providerReference: providerReference ?? undefined,
      permalink: permalink ?? undefined,
      publishedAt,
      platformPostType: platformPostType ?? undefined,
      status: platformPostId || providerReference ? "PUBLISHED" : "UNAVAILABLE",
    },
  });
}

export function utcSnapshotDate(at = new Date()) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
