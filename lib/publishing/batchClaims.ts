import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { Prisma, type SocialPlatform } from "@prisma/client";
import { PUBLISHING_PLATFORMS } from "./state";

export type PublishingClaim = {
  id: string;
  platform: SocialPlatform;
  dispatchedAt: Date;
  recoveringTikTok: boolean;
};
type ClaimRow = { id: string | null; platform: SocialPlatform | null; dispatchedAt: Date | null; previousStatus: string | null; stale: bigint };

function identifiers(platform: SocialPlatform) {
  if (!PUBLISHING_PLATFORMS.includes(platform)) throw new Error("Unsupported publishing platform.");
  return {
    status: Prisma.raw(platform === "INSTAGRAM" ? '"instagramPublishStatus"' : platform === "TIKTOK" ? '"tikTokPublishStatus"' : '"publishStatus"'),
    error: Prisma.raw(platform === "INSTAGRAM" ? '"instagramPublishError"' : platform === "TIKTOK" ? '"tikTokPublishError"' : '"publishError"'),
    statusType: Prisma.raw(platform === "TIKTOK" ? '"TikTokPublishStatus"' : '"InstagramPublishStatus"'),
  };
}

/** One atomic statement per platform. Locks are skipped rather than waited on.
 * Only returned, committed rows are eligible for worker dispatch. */
export async function claimPublishingBatch(transaction: Prisma.TransactionClient, platform: SocialPlatform, now: Date, limit: number, recoverStale: boolean, excludedIds: string[] = []) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/batchClaims.ts#claimPublishingBatch@23"); } /* end-canonical-integration-boundary */

  const { status, error } = identifiers(platform);
  const staleBefore = new Date(now.getTime() - 16 * 60_000);
  const acceptedTikTok = platform === "TIKTOK"
    ? Prisma.sql`OR (p.${status} = 'PUBLISHING' AND p."tikTokPublishId" IS NOT NULL AND (p."publishWorkerStartedAt" IS NULL OR p."updatedAt" <= (${staleBefore}::timestamptz AT TIME ZONE 'UTC')))`
    : Prisma.empty;
  const excludeAccepted = platform === "TIKTOK" ? Prisma.sql`AND p."tikTokPublishId" IS NULL` : Prisma.empty;
  const excludeClaimed = excludedIds.length ? Prisma.sql`AND p."id" NOT IN (${Prisma.join(excludedIds)})` : Prisma.empty;
  const rows = await transaction.$queryRaw<ClaimRow[]>(Prisma.sql`
    WITH stale_candidates AS (
      SELECT p."id", p."updatedAt" FROM "CalendarPost" p
      WHERE ${recoverStale} AND p."platform" = ${platform}::"SocialPlatform"
        AND p.${status} = 'PUBLISHING' AND p."updatedAt" <= (${staleBefore}::timestamptz AT TIME ZONE 'UTC') ${excludeAccepted}
      ORDER BY p."updatedAt", p."id" LIMIT 100 FOR UPDATE OF p SKIP LOCKED
    ), stale_rows AS (
      UPDATE "CalendarPost" p SET ${status} = 'FAILED',
        ${error} = 'The worker stopped before confirming the result. Check the platform before retrying to avoid duplicates.',
        "updatedAt" = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
      FROM stale_candidates s WHERE p."id" = s."id" AND p."updatedAt" = s."updatedAt"
      RETURNING p."id"
    ), candidates AS (
      SELECT p."id", p."updatedAt", p.${status}::text AS previous_status
      FROM "CalendarPost" p
      WHERE p."platform" = ${platform}::"SocialPlatform"
        AND (p.${status} = 'SCHEDULED' ${acceptedTikTok})
        AND p."approvalStatus" = 'APPROVED' AND NOT p."isAiDraft" AND p."postDate" <= (${now}::timestamptz AT TIME ZONE 'UTC') ${excludeClaimed}
      ORDER BY p."postDate", p."id" LIMIT ${limit} FOR UPDATE OF p SKIP LOCKED
    ), claimed AS (
      UPDATE "CalendarPost" p SET ${status} = 'PUBLISHING', ${error} = NULL,
        "publishWorkerStartedAt" = NULL,
        "updatedAt" = GREATEST(date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'), p."updatedAt" + interval '1 millisecond')
      FROM candidates c WHERE p."id" = c."id" AND p."updatedAt" = c."updatedAt"
        AND p.${status}::text = c.previous_status
        AND p."approvalStatus" = 'APPROVED' AND NOT p."isAiDraft"
      RETURNING p."id", p."platform", p."updatedAt", c.previous_status
    )
    SELECT c."id", c."platform", c."updatedAt" AS "dispatchedAt", c.previous_status AS "previousStatus",
      (SELECT COUNT(*) FROM stale_rows) AS stale FROM claimed c
    UNION ALL SELECT NULL::text, NULL::"SocialPlatform", NULL::timestamp, NULL::text,
      (SELECT COUNT(*) FROM stale_rows) WHERE NOT EXISTS (SELECT 1 FROM claimed)
  `);
  const claims: PublishingClaim[] = rows.filter(row => row.id !== null).map(row => ({
    id: row.id!, platform: row.platform!, dispatchedAt: row.dispatchedAt!,
    recoveringTikTok: platform === "TIKTOK" && row.previousStatus === "PUBLISHING",
  }));
  return { claims, stale: Number(rows[0]?.stale ?? 0) };
}

/** Compare the exact dispatch lease; never overwrite a newer claim or a worker
 * that already started, including when an HTTP acknowledgement was lost. */
export async function failPublishingDispatchBatch(transaction: Prisma.TransactionClient, platform: SocialPlatform, claims: PublishingClaim[]) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/batchClaims.ts#failPublishingDispatchBatch@73"); } /* end-canonical-integration-boundary */

  if (!claims.length) return 0;
  const { status, error, statusType } = identifiers(platform);
  const values = Prisma.join(claims.map(claim => Prisma.sql`(${claim.id}, (${claim.dispatchedAt}::timestamptz AT TIME ZONE 'UTC'), ${claim.recoveringTikTok})`));
  return transaction.$executeRaw(Prisma.sql`
    UPDATE "CalendarPost" p SET ${status} = (CASE WHEN failed.recovering THEN 'PUBLISHING' ELSE 'FAILED' END)::${statusType},
      ${error} = 'Could not confirm worker dispatch. Check the platform before retrying.',
      "updatedAt" = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
    FROM (VALUES ${values}) AS failed(id, lease, recovering)
    WHERE p."id" = failed.id AND p."platform" = ${platform}::"SocialPlatform"
      AND p.${status} = 'PUBLISHING' AND p."updatedAt" = failed.lease AND p."publishWorkerStartedAt" IS NULL
  `);
}
