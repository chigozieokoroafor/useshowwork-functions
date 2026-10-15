ALTER TABLE "CalendarPost"
 ADD COLUMN "tikTokSettings" JSONB,
 ADD COLUMN "tikTokConsentAt" TIMESTAMP(3),
 ADD COLUMN "tikTokConsentBy" TEXT,
 ADD COLUMN "tikTokConsentAccountId" TEXT,
 ADD COLUMN "tikTokConsentHash" TEXT,
 ADD COLUMN "tikTokConsentVersion" TEXT,
 ADD COLUMN "tikTokInitStartedAt" TIMESTAMP(3);
CREATE TABLE "TikTokAccountRuntime" (
 "accountId" TEXT NOT NULL PRIMARY KEY,
 "creatorNextAt" TIMESTAMP(3), "initNextAt" TIMESTAMP(3), "statusNextAt" TIMESTAMP(3)
);
-- Historical approval must never be treated as TikTok publishing consent.
UPDATE "CalendarPost" SET "tikTokPublishStatus" = 'NOT_SCHEDULED',
 "tikTokPublishError" = 'Review TikTok settings and authorize publishing before scheduling.'
 WHERE "platform" = 'TIKTOK' AND "tikTokPublishStatus" = 'SCHEDULED';
