-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'UNLIMITED');

-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "currentCycleStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "paystackCustomerCode" TEXT,
ADD COLUMN     "paystackEmailToken" TEXT,
ADD COLUMN     "paystackSubscriptionCode" TEXT,
ADD COLUMN     "subscriptionActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subscriptionRenewsAt" TIMESTAMP(3),
ADD COLUMN     "subscriptionTier" "SubscriptionTier" NOT NULL DEFAULT 'FREE';
