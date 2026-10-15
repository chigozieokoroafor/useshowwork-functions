ALTER TABLE "SocialConnection"
ADD COLUMN "tikTokMessagingBusinessId" TEXT,
ADD COLUMN "tikTokMessagingAccessToken" TEXT,
ADD COLUMN "tikTokMessagingRefreshToken" TEXT,
ADD COLUMN "tikTokMessagingTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "tikTokMessagingRefreshExpiresAt" TIMESTAMP(3),
ADD COLUMN "tikTokMessagingScopes" TEXT,
ADD COLUMN "tikTokMessagingConnectedAt" TIMESTAMP(3);
