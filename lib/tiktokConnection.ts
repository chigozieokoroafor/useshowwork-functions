import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed, publishingRetentionRequired } from "@/lib/publishing/applicationBoundary";
import type { SocialConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { refreshTikTokAccessToken, queryTikTokCreatorInfo } from "@/lib/tiktok";
import { requireScopes } from "@/lib/socialTokens";
import { PublishingDeferred } from "@/lib/publishing/errors";

// Transaction-scoped advisory locks serialize refresh rotation across processes
// and calendars. No tokens or app credentials are returned to the client.
export async function freshTikTokConnection(connection: SocialConnection, database: typeof db = db, tryLock = false): Promise<SocialConnection> {
  /* canonical-integration-boundary */ if (publishingRetentionRequired()) { return await freshCanonicalAuxiliaryConnection(connection); } /* end-canonical-integration-boundary */

  return database.$transaction(async tx => {
    if (tryLock) {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`tiktok-refresh:${connection.platformAccountId}`})) AS locked`;
      if (!rows[0]?.locked) throw new PublishingDeferred("TikTok refresh account lock busy");
    } else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tiktok-refresh:${connection.platformAccountId}`}))`;
    const current = await tx.socialConnection.findUniqueOrThrow({ where: { id: connection.id } });
    if (current.status !== "CONNECTED" || !current.accessToken) throw new Error("Reconnect TikTok before continuing.");
    if (current.accessTokenExpiresAt && current.accessTokenExpiresAt.getTime() > Date.now() + 60_000) return current;
    if (!current.refreshToken || (current.refreshTokenExpiresAt && current.refreshTokenExpiresAt.getTime() <= Date.now())) throw new Error("TikTok's connection expired. Reconnect the account.");
    const tokens = await refreshTikTokAccessToken(current.refreshToken);
    if (tokens.open_id !== current.platformAccountId) throw new Error("TikTok's account changed. Reconnect before continuing.");
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const data = { accessToken: tokens.access_token, accessTokenExpiresAt, refreshToken: tokens.refresh_token,
      refreshTokenExpiresAt: new Date(Date.now() + tokens.refresh_expires_in * 1000), tokenScopes: tokens.scope };
    await tx.socialConnection.updateMany({ where: { platform: "TIKTOK", platformAccountId: current.platformAccountId, status: "CONNECTED", refreshToken: current.refreshToken }, data });
    await tx.socialCalendar.updateMany({ where: { tikTokOpenId: current.platformAccountId, tikTokRefreshToken: current.refreshToken }, data: {
      tikTokAccessToken: tokens.access_token, tikTokAccessTokenExpiresAt: accessTokenExpiresAt, tikTokRefreshToken: tokens.refresh_token,
    } });
    const updated = await tx.socialConnection.findUniqueOrThrow({ where: { id: current.id } });
    if (updated.status !== "CONNECTED" || !updated.accessToken) throw new Error("TikTok was disconnected while refreshing. Reconnect before continuing.");
    return updated;
  }, { maxWait: 10_000, timeout: 40_000 });
}

export class TikTokRequestBusyError extends Error {
  constructor(public retryAfter: number) {
    super("TikTok is handling several requests for this account. Please try again shortly.");
  }
}

export async function reserveTikTokRequest(accountId: string, kind: "creator" | "init" | "status", database: typeof db = db, tryLock = false) {
  const field = kind === "creator" ? "creatorNextAt" : kind === "init" ? "initNextAt" : "statusNextAt";
  const interval = kind === "creator" ? 3100 : kind === "init" ? 10_100 : 2100;
  const waitMs = await database.$transaction(async tx => {
    if (tryLock) {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`tiktok-rate:${accountId}`})) AS locked`;
      if (!rows[0]?.locked) throw new PublishingDeferred("TikTok request account lock busy");
    } else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tiktok-rate:${accountId}`}))`;
    const row = await tx.tikTokAccountRuntime.upsert({ where: { accountId }, create: { accountId }, update: {} });
    const next = row[field];
    const now = Date.now();
    const scheduledAt = Math.max(now, next?.getTime() ?? now);
    const delay = scheduledAt - now;
    if (delay > 15_000) throw new TikTokRequestBusyError(Math.ceil(delay / 1000));
    await tx.tikTokAccountRuntime.update({ where: { accountId }, data: { [field]: new Date(scheduledAt + interval) } });
    return delay;
  });
  // A duplicate mount or nearby refresh should wait its turn instead of
  // failing the settings screen. Release the DB lock before waiting.
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
}

export async function getTikTokCreator(calendarId: string) {
  const stored = await db.socialConnection.findFirst({ where: { calendarId, platform: "TIKTOK", status: "CONNECTED" } });
  if (!stored) throw new Error("Connect TikTok before configuring publishing.");
  const connection = await freshTikTokConnection(stored);
  requireScopes(connection, ["video.publish"]);
  await reserveTikTokRequest(connection.platformAccountId, "creator");
  const info = await queryTikTokCreatorInfo(connection.accessToken!);
  return { connection, info };
}
/* canonical-only-helper */
import {freshCanonicalAuxiliaryConnection} from "./publishing/auxiliaryAccountHost";
/* end-canonical-only-helper */
