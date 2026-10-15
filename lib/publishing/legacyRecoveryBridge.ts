import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { Prisma, type SocialPlatform } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PUBLISHING_PLATFORMS, statusField } from "./state";
import type { ReliablePublishingStore, DurableJob } from "./reliableStore";

/** Explicit staging-tested handoff helper, never called by a live handler.
 * Existing accepted TikTok IDs are polled only. Stale started legacy workers
 * become uncertain; unstarted claims get a new exact lease that fences delayed
 * old background envelopes. Recent started workers are left to finish. */
export async function importLegacyPublishingRecovery(store: ReliablePublishingStore) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/legacyRecoveryBridge.ts#importLegacyPublishingRecovery@10"); } /* end-canonical-integration-boundary */

  const imported: DurableJob[] = [];
  for (const platform of PUBLISHING_PLATFORMS) {
    const operation = randomUUID(), token = randomUUID(), status = Prisma.raw('"'+statusField(platform)+'"');
    const rows = await store.budget("worker", tx => tx.$queryRaw<DurableJob[]>(Prisma.sql`WITH selected AS (
      SELECT p.id,p.platform,p."updatedAt",p."publishWorkerStartedAt",p."tikTokPublishId",p."tikTokInitStartedAt",p."tikTokConsentAccountId",
        p."instagramMediaId",p."platformPostId",c."instagramAccountId",
        (SELECT s."platformAccountId" FROM "SocialConnection" s WHERE s."calendarId"=p."calendarId" AND s.platform=p.platform AND s.status='CONNECTED' LIMIT 1) AS account
      FROM "CalendarPost" p JOIN "SocialCalendar" c ON c.id=p."calendarId" WHERE p.platform=${platform}::"SocialPlatform" AND p.${status}='PUBLISHING'
        AND NOT EXISTS(SELECT 1 FROM "PublishingJob" j WHERE j."postId"=p.id AND j.platform=p.platform)
        AND (p.platform='TIKTOK' AND p."tikTokPublishId" IS NOT NULL OR p."updatedAt"<(clock_timestamp() AT TIME ZONE 'UTC')-interval '16 minutes')
      ORDER BY p."postDate",p.id LIMIT 20 FOR UPDATE OF p SKIP LOCKED),
      operation AS (INSERT INTO "PublishingAdmission"(id,platform) SELECT ${operation},${platform}::"SocialPlatform" WHERE EXISTS(SELECT 1 FROM selected) RETURNING id),
      bumped AS (UPDATE "CalendarPost" p SET "updatedAt"=GREATEST(date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC'),p."updatedAt"+interval '1 millisecond')
        FROM selected s WHERE p.id=s.id AND s."publishWorkerStartedAt" IS NULL AND s."tikTokPublishId" IS NULL AND s."tikTokInitStartedAt" IS NULL RETURNING p.id,p."updatedAt"),
      jobs AS (INSERT INTO "PublishingJob"(id,"admissionId","postId",platform,lease,phase,"workerToken","startedAt","remoteId","accountId")
        SELECT ${operation}||':'||s.id,${operation},s.id,s.platform,COALESCE(b."updatedAt",s."updatedAt"),
          CASE WHEN s.platform='TIKTOK' AND s."tikTokPublishId" IS NOT NULL THEN 'PROVIDER_PENDING' WHEN b.id IS NOT NULL THEN 'READY' ELSE 'OUTCOME_UNKNOWN' END,
          ${token},s."publishWorkerStartedAt",CASE WHEN s.platform='TIKTOK' THEN s."tikTokPublishId" WHEN s.platform='INSTAGRAM' THEN s."instagramMediaId" ELSE s."platformPostId" END,
          CASE WHEN s.platform='TIKTOK' THEN s."tikTokConsentAccountId" ELSE COALESCE(s.account,s."instagramAccountId") END
        FROM selected s LEFT JOIN bumped b ON b.id=s.id WHERE EXISTS(SELECT 1 FROM operation)
        RETURNING id,"postId",platform,lease,phase,"workerToken") SELECT * FROM jobs`));
    imported.push(...rows);
  }
  return imported;
}
