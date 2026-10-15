CREATE TABLE "SocialAccountPost" (
  "id" TEXT NOT NULL,
  "socialConnectionId" TEXT NOT NULL,
  "platformPostId" TEXT NOT NULL,
  "caption" TEXT,
  "postType" TEXT,
  "publishedAt" TIMESTAMP(3) NOT NULL,
  "permalink" TEXT,
  "views" DOUBLE PRECISION,
  "reach" DOUBLE PRECISION,
  "impressions" DOUBLE PRECISION,
  "engagement" DOUBLE PRECISION,
  "likes" DOUBLE PRECISION,
  "comments" DOUBLE PRECISION,
  "shares" DOUBLE PRECISION,
  "saves" DOUBLE PRECISION,
  "metricsUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialAccountPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialAccountPost_socialConnectionId_platformPostId_key"
  ON "SocialAccountPost"("socialConnectionId", "platformPostId");
CREATE INDEX "SocialAccountPost_socialConnectionId_publishedAt_idx"
  ON "SocialAccountPost"("socialConnectionId", "publishedAt");

ALTER TABLE "SocialAccountPost"
  ADD CONSTRAINT "SocialAccountPost_socialConnectionId_fkey"
  FOREIGN KEY ("socialConnectionId") REFERENCES "SocialConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
