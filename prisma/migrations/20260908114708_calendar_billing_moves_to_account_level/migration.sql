/*
  Warnings:

  - You are about to drop the column `billingStatus` on the `SocialCalendar` table. All the data in the column will be lost.
  - You are about to drop the column `lastFreeMonthGrantedAt` on the `SocialCalendar` table. All the data in the column will be lost.
  - You are about to drop the column `lastPaymentReminderSentAt` on the `SocialCalendar` table. All the data in the column will be lost.
  - You are about to drop the column `paystackCustomerCode` on the `SocialCalendar` table. All the data in the column will be lost.
  - You are about to drop the column `paystackEmailToken` on the `SocialCalendar` table. All the data in the column will be lost.
  - You are about to drop the column `paystackSubscriptionCode` on the `SocialCalendar` table. All the data in the column will be lost.
  - You are about to drop the column `pendingSubscriptionRef` on the `SocialCalendar` table. All the data in the column will be lost.
  - You are about to drop the column `subscriptionRenewsAt` on the `SocialCalendar` table. All the data in the column will be lost.
  - You are about to drop the column `trialEndsAt` on the `SocialCalendar` table. All the data in the column will be lost.
  - You are about to drop the column `wentOfflineAt` on the `SocialCalendar` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[calendarPendingSubscriptionRef]` on the table `Creator` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "CalendarAccountType" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- DropIndex
DROP INDEX "SocialCalendar_pendingSubscriptionRef_key";

-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "calendarAccountType" "CalendarAccountType",
ADD COLUMN     "calendarBillingStatus" "CalendarBillingStatus" NOT NULL DEFAULT 'PENDING_SETUP',
ADD COLUMN     "calendarLastFreeMonthGrantedAt" TIMESTAMP(3),
ADD COLUMN     "calendarLastPaymentReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "calendarPaystackCustomerCode" TEXT,
ADD COLUMN     "calendarPaystackEmailToken" TEXT,
ADD COLUMN     "calendarPaystackSubscriptionCode" TEXT,
ADD COLUMN     "calendarPendingSubscriptionRef" TEXT,
ADD COLUMN     "calendarSubscriptionRenewsAt" TIMESTAMP(3),
ADD COLUMN     "calendarTrial2DaysLeftEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "calendarTrialEndedEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "calendarTrialEndsAt" TIMESTAMP(3),
ADD COLUMN     "calendarTrialEndsTodayEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "calendarTrialFollowUpEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "calendarTrialUsedAt" TIMESTAMP(3),
ADD COLUMN     "calendarWentOfflineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SocialCalendar" DROP COLUMN "billingStatus",
DROP COLUMN "lastFreeMonthGrantedAt",
DROP COLUMN "lastPaymentReminderSentAt",
DROP COLUMN "paystackCustomerCode",
DROP COLUMN "paystackEmailToken",
DROP COLUMN "paystackSubscriptionCode",
DROP COLUMN "pendingSubscriptionRef",
DROP COLUMN "subscriptionRenewsAt",
DROP COLUMN "trialEndsAt",
DROP COLUMN "wentOfflineAt";

-- CreateIndex
CREATE UNIQUE INDEX "Creator_calendarPendingSubscriptionRef_key" ON "Creator"("calendarPendingSubscriptionRef");
