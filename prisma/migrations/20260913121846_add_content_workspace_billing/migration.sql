/*
  Warnings:

  - A unique constraint covering the columns `[contentWorkspacePendingSubscriptionRef]` on the table `Creator` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ContentWorkspacePlan" AS ENUM ('CREATOR', 'STUDIO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentType" ADD VALUE 'CONTENT_WORKSPACE_SUBSCRIPTION_INITIAL';
ALTER TYPE "PaymentType" ADD VALUE 'CONTENT_WORKSPACE_SUBSCRIPTION_RENEWAL';

-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "contentWorkspaceBillingCycle" "BillingCycle",
ADD COLUMN     "contentWorkspaceBillingStatus" "CalendarBillingStatus" NOT NULL DEFAULT 'PENDING_SETUP',
ADD COLUMN     "contentWorkspacePaystackCustomerCode" TEXT,
ADD COLUMN     "contentWorkspacePaystackEmailToken" TEXT,
ADD COLUMN     "contentWorkspacePaystackSubscriptionCode" TEXT,
ADD COLUMN     "contentWorkspacePendingSubscriptionRef" TEXT,
ADD COLUMN     "contentWorkspacePlan" "ContentWorkspacePlan",
ADD COLUMN     "contentWorkspaceSubscriptionRenewsAt" TIMESTAMP(3),
ADD COLUMN     "contentWorkspaceTrialEndsAt" TIMESTAMP(3),
ADD COLUMN     "contentWorkspaceTrialUsedAt" TIMESTAMP(3),
ADD COLUMN     "contentWorkspaceWentOfflineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PaymentRecord" ADD COLUMN     "contentWorkspacePlan" "ContentWorkspacePlan";

-- CreateTable
CREATE TABLE "ContentWorkspaceUsage" (
    "creatorId" TEXT NOT NULL,
    "cycleStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "aiGenerationsUsed" INTEGER NOT NULL DEFAULT 0,
    "aiRegenerationsUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentWorkspaceUsage_pkey" PRIMARY KEY ("creatorId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Creator_contentWorkspacePendingSubscriptionRef_key" ON "Creator"("contentWorkspacePendingSubscriptionRef");

-- AddForeignKey
ALTER TABLE "ContentWorkspaceUsage" ADD CONSTRAINT "ContentWorkspaceUsage_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
