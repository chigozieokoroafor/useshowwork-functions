-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "creativoPromoEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "lastDeliveryReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "lifecycleSequenceStartedAt" TIMESTAMP(3),
ADD COLUMN     "portfolioInviteEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "projectManagementEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "welcomeEmailSentAt" TIMESTAMP(3);
