/*
  Warnings:

  - A unique constraint covering the columns `[aiAssistantPendingSubscriptionRef]` on the table `Creator` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "aiAssistantBillingStatus" "CalendarBillingStatus" NOT NULL DEFAULT 'PENDING_SETUP',
ADD COLUMN     "aiAssistantPaystackCustomerCode" TEXT,
ADD COLUMN     "aiAssistantPaystackEmailToken" TEXT,
ADD COLUMN     "aiAssistantPaystackSubscriptionCode" TEXT,
ADD COLUMN     "aiAssistantPendingSubscriptionRef" TEXT,
ADD COLUMN     "aiAssistantSubscriptionRenewsAt" TIMESTAMP(3),
ADD COLUMN     "aiAssistantTrialEndsAt" TIMESTAMP(3),
ADD COLUMN     "aiAssistantTrialUsedAt" TIMESTAMP(3),
ADD COLUMN     "aiAssistantWentOfflineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SocialCalendar" ADD COLUMN     "aiBusinessSummary" TEXT,
ADD COLUMN     "aiBusinessSummaryUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "aiLastResearchedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CalendarBusinessDocument" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "extractedText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarBusinessDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarBusinessDocument_calendarId_idx" ON "CalendarBusinessDocument"("calendarId");

-- CreateIndex
CREATE UNIQUE INDEX "Creator_aiAssistantPendingSubscriptionRef_key" ON "Creator"("aiAssistantPendingSubscriptionRef");

-- AddForeignKey
ALTER TABLE "CalendarBusinessDocument" ADD CONSTRAINT "CalendarBusinessDocument_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
