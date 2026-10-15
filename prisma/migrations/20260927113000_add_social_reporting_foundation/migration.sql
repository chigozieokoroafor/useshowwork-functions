CREATE TYPE "SocialConnectionStatus" AS ENUM ('CONNECTED', 'NEEDS_REAUTH', 'DISCONNECTED');
CREATE TYPE "PublishedSocialPostStatus" AS ENUM ('PUBLISHED', 'UNAVAILABLE', 'FAILED');
CREATE TYPE "ReportingInsightType" AS ENUM ('WHAT_WORKED', 'UNDERPERFORMED', 'TREND', 'RECOMMENDATION');

CREATE TABLE "SocialConnection" (
  "id" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "platform" "SocialPlatform" NOT NULL,
  "platformAccountId" TEXT NOT NULL,
  "accountName" TEXT,
  "username" TEXT,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMP(3),
  "refreshTokenExpiresAt" TIMESTAMP(3),
  "tokenScopes" TEXT,
  "status" "SocialConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disconnectedAt" TIMESTAMP(3),
  "lastSyncAttemptAt" TIMESTAMP(3),
  "lastSyncAt" TIMESTAMP(3),
  "lastSyncError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SocialConnection_calendarId_platform_platformAccountId_key" ON "SocialConnection"("calendarId", "platform", "platformAccountId");
CREATE INDEX "SocialConnection_calendarId_platform_status_idx" ON "SocialConnection"("calendarId", "platform", "status");
CREATE INDEX "SocialConnection_platform_status_idx" ON "SocialConnection"("platform", "status");
ALTER TABLE "SocialConnection" ADD CONSTRAINT "SocialConnection_calendarId_fkey"
  FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PublishedSocialPost" (
  "id" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "calendarPostId" TEXT NOT NULL,
  "socialConnectionId" TEXT NOT NULL,
  "platform" "SocialPlatform" NOT NULL,
  "platformPostId" TEXT,
  "providerReference" TEXT,
  "permalink" TEXT,
  "status" "PublishedSocialPostStatus" NOT NULL DEFAULT 'PUBLISHED',
  "publishedAt" TIMESTAMP(3),
  "platformPostType" TEXT,
  "platformMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublishedSocialPost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PublishedSocialPost_calendarPostId_socialConnectionId_key" ON "PublishedSocialPost"("calendarPostId", "socialConnectionId");
CREATE INDEX "PublishedSocialPost_calendarId_publishedAt_idx" ON "PublishedSocialPost"("calendarId", "publishedAt");
CREATE INDEX "PublishedSocialPost_platform_platformPostId_idx" ON "PublishedSocialPost"("platform", "platformPostId");
ALTER TABLE "PublishedSocialPost" ADD CONSTRAINT "PublishedSocialPost_calendarId_fkey"
  FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishedSocialPost" ADD CONSTRAINT "PublishedSocialPost_calendarPostId_fkey"
  FOREIGN KEY ("calendarPostId") REFERENCES "CalendarPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishedSocialPost" ADD CONSTRAINT "PublishedSocialPost_socialConnectionId_fkey"
  FOREIGN KEY ("socialConnectionId") REFERENCES "SocialConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SocialPostMetricSnapshot" (
  "id" TEXT NOT NULL,
  "publishedSocialPostId" TEXT NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "reach" DOUBLE PRECISION,
  "impressions" DOUBLE PRECISION,
  "views" DOUBLE PRECISION,
  "engagement" DOUBLE PRECISION,
  "engagementRate" DOUBLE PRECISION,
  "engagementRateBasis" TEXT,
  "likes" DOUBLE PRECISION,
  "comments" DOUBLE PRECISION,
  "shares" DOUBLE PRECISION,
  "saves" DOUBLE PRECISION,
  "clicks" DOUBLE PRECISION,
  "additionalMetrics" JSONB,
  "sourceUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialPostMetricSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SocialPostMetricSnapshot_publishedSocialPostId_snapshotDate_key" ON "SocialPostMetricSnapshot"("publishedSocialPostId", "snapshotDate");
CREATE INDEX "SocialPostMetricSnapshot_snapshotDate_idx" ON "SocialPostMetricSnapshot"("snapshotDate");
ALTER TABLE "SocialPostMetricSnapshot" ADD CONSTRAINT "SocialPostMetricSnapshot_publishedSocialPostId_fkey"
  FOREIGN KEY ("publishedSocialPostId") REFERENCES "PublishedSocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SocialAccountMetricSnapshot" (
  "id" TEXT NOT NULL,
  "socialConnectionId" TEXT NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "followers" DOUBLE PRECISION,
  "followerGrowth" DOUBLE PRECISION,
  "reach" DOUBLE PRECISION,
  "impressions" DOUBLE PRECISION,
  "views" DOUBLE PRECISION,
  "engagement" DOUBLE PRECISION,
  "additionalMetrics" JSONB,
  "sourceUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialAccountMetricSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SocialAccountMetricSnapshot_socialConnectionId_snapshotDate_key" ON "SocialAccountMetricSnapshot"("socialConnectionId", "snapshotDate");
CREATE INDEX "SocialAccountMetricSnapshot_snapshotDate_idx" ON "SocialAccountMetricSnapshot"("snapshotDate");
ALTER TABLE "SocialAccountMetricSnapshot" ADD CONSTRAINT "SocialAccountMetricSnapshot_socialConnectionId_fkey"
  FOREIGN KEY ("socialConnectionId") REFERENCES "SocialConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CalendarReportingPermission" (
  "id" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "grantedById" TEXT,
  "grantedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalendarReportingPermission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CalendarReportingPermission_calendarId_key" ON "CalendarReportingPermission"("calendarId");
ALTER TABLE "CalendarReportingPermission" ADD CONSTRAINT "CalendarReportingPermission_calendarId_fkey"
  FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarReportingPermission" ADD CONSTRAINT "CalendarReportingPermission_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "Creator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReportingInsight" (
  "id" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "platform" "SocialPlatform",
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "type" "ReportingInsightType" NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "recommendation" TEXT,
  "supportingData" JSONB NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReportingInsight_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReportingInsight_calendarId_periodStart_periodEnd_idx" ON "ReportingInsight"("calendarId", "periodStart", "periodEnd");
CREATE INDEX "ReportingInsight_calendarId_platform_type_idx" ON "ReportingInsight"("calendarId", "platform", "type");
ALTER TABLE "ReportingInsight" ADD CONSTRAINT "ReportingInsight_calendarId_fkey"
  FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate the live credentials to one normalized record per connected
-- platform. Keep the old columns temporarily for compatibility with
-- existing admin UI and publishing code during the phased rollout.
INSERT INTO "SocialConnection" (
  "id", "calendarId", "platform", "platformAccountId", "accountName", "username",
  "accessToken", "refreshToken", "accessTokenExpiresAt", "connectedAt", "status", "updatedAt"
)
SELECT gen_random_uuid()::text, c."id", 'INSTAGRAM', c."instagramAccountId", c."instagramUsername", c."instagramUsername",
       c."instagramAccessToken", NULL, c."instagramTokenExpiresAt", COALESCE(c."instagramConnectedAt", CURRENT_TIMESTAMP), 'CONNECTED', CURRENT_TIMESTAMP
FROM "SocialCalendar" c WHERE c."instagramAccountId" IS NOT NULL
ON CONFLICT ("calendarId", "platform", "platformAccountId") DO NOTHING;

INSERT INTO "SocialConnection" (
  "id", "calendarId", "platform", "platformAccountId", "accountName", "username",
  "accessToken", "refreshToken", "accessTokenExpiresAt", "connectedAt", "status", "updatedAt"
)
SELECT gen_random_uuid()::text, c."id", 'TIKTOK', c."tikTokOpenId", c."tikTokUsername", c."tikTokUsername",
       c."tikTokAccessToken", c."tikTokRefreshToken", c."tikTokAccessTokenExpiresAt", COALESCE(c."tikTokConnectedAt", CURRENT_TIMESTAMP), 'CONNECTED', CURRENT_TIMESTAMP
FROM "SocialCalendar" c WHERE c."tikTokOpenId" IS NOT NULL
ON CONFLICT ("calendarId", "platform", "platformAccountId") DO NOTHING;

INSERT INTO "SocialConnection" (
  "id", "calendarId", "platform", "platformAccountId", "accountName", "username",
  "accessToken", "refreshToken", "accessTokenExpiresAt", "connectedAt", "status", "updatedAt"
)
SELECT gen_random_uuid()::text, c."id", 'FACEBOOK', c."facebookPageId", c."facebookPageName", NULL,
       c."facebookAccessToken", NULL, c."facebookTokenExpiresAt", COALESCE(c."facebookConnectedAt", CURRENT_TIMESTAMP), 'CONNECTED', CURRENT_TIMESTAMP
FROM "SocialCalendar" c WHERE c."facebookPageId" IS NOT NULL
ON CONFLICT ("calendarId", "platform", "platformAccountId") DO NOTHING;

INSERT INTO "SocialConnection" (
  "id", "calendarId", "platform", "platformAccountId", "accountName", "username",
  "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "connectedAt", "status", "updatedAt"
)
SELECT gen_random_uuid()::text, c."id", 'LINKEDIN', c."linkedinMemberId", c."linkedinName", NULL,
       c."linkedinAccessToken", c."linkedinRefreshToken", c."linkedinAccessTokenExpiresAt", c."linkedinRefreshTokenExpiresAt", COALESCE(c."linkedinConnectedAt", CURRENT_TIMESTAMP), 'CONNECTED', CURRENT_TIMESTAMP
FROM "SocialCalendar" c WHERE c."linkedinMemberId" IS NOT NULL
ON CONFLICT ("calendarId", "platform", "platformAccountId") DO NOTHING;

INSERT INTO "SocialConnection" (
  "id", "calendarId", "platform", "platformAccountId", "accountName", "username",
  "accessToken", "refreshToken", "accessTokenExpiresAt", "connectedAt", "status", "updatedAt"
)
SELECT gen_random_uuid()::text, c."id", 'X', c."xUserId", c."xUsername", c."xUsername",
       c."xAccessToken", c."xRefreshToken", c."xAccessTokenExpiresAt", COALESCE(c."xConnectedAt", CURRENT_TIMESTAMP), 'CONNECTED', CURRENT_TIMESTAMP
FROM "SocialCalendar" c WHERE c."xUserId" IS NOT NULL
ON CONFLICT ("calendarId", "platform", "platformAccountId") DO NOTHING;

-- Preserve the published Instagram links already present in CalendarPost.
INSERT INTO "PublishedSocialPost" (
  "id", "calendarId", "calendarPostId", "socialConnectionId", "platform", "platformPostId",
  "permalink", "status", "publishedAt", "updatedAt"
)
SELECT gen_random_uuid()::text, p."calendarId", p."id", sc."id", 'INSTAGRAM', p."instagramMediaId",
       p."instagramPermalink", 'PUBLISHED', p."instagramPublishedAt", CURRENT_TIMESTAMP
FROM "CalendarPost" p
JOIN "SocialConnection" sc ON sc."calendarId" = p."calendarId" AND sc."platform" = 'INSTAGRAM'
WHERE p."instagramPublishStatus" = 'PUBLISHED'
ON CONFLICT ("calendarPostId", "socialConnectionId") DO NOTHING;

-- TikTok's stored value is a publish job reference, not always a public
-- post ID. Keep it as providerReference and leave platformPostId null.
INSERT INTO "PublishedSocialPost" (
  "id", "calendarId", "calendarPostId", "socialConnectionId", "platform", "providerReference",
  "status", "publishedAt", "updatedAt"
)
SELECT gen_random_uuid()::text, p."calendarId", p."id", sc."id", 'TIKTOK', p."tikTokPublishId",
       'PUBLISHED', p."tikTokPublishedAt", CURRENT_TIMESTAMP
FROM "CalendarPost" p
JOIN "SocialConnection" sc ON sc."calendarId" = p."calendarId" AND sc."platform" = 'TIKTOK'
WHERE p."tikTokPublishStatus" = 'PUBLISHED'
ON CONFLICT ("calendarPostId", "socialConnectionId") DO NOTHING;
