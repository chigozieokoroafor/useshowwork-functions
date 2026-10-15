-- AlterEnum
ALTER TYPE "CalendarBillingStatus" ADD VALUE 'TRIAL';

-- AlterTable
ALTER TABLE "SocialCalendar" ADD COLUMN     "trialEndsAt" TIMESTAMP(3);
