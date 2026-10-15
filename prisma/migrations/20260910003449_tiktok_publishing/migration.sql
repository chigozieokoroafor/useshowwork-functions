-- CreateEnum
CREATE TYPE "TikTokPublishStatus" AS ENUM ('NOT_SCHEDULED', 'SCHEDULED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "TikTokPrivacyLevel" AS ENUM ('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY');

-- AlterTable
ALTER TABLE "CalendarPost" ADD COLUMN     "tikTokPrivacyLevel" "TikTokPrivacyLevel",
ADD COLUMN     "tikTokPublishError" TEXT,
ADD COLUMN     "tikTokPublishId" TEXT,
ADD COLUMN     "tikTokPublishStatus" "TikTokPublishStatus" NOT NULL DEFAULT 'NOT_SCHEDULED',
ADD COLUMN     "tikTokPublishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SocialCalendar" ADD COLUMN     "tikTokAccessToken" TEXT,
ADD COLUMN     "tikTokAccessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "tikTokConnectedAt" TIMESTAMP(3),
ADD COLUMN     "tikTokOpenId" TEXT,
ADD COLUMN     "tikTokRefreshToken" TEXT,
ADD COLUMN     "tikTokUsername" TEXT;
