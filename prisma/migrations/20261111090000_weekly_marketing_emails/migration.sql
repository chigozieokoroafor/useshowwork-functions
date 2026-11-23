-- Retain all historical timestamps; the application uses them for its rollout cooldown.
ALTER TABLE "Creator"
  ADD COLUMN "weeklyMarketingEmailLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "weeklyMarketingEmailSentAt" TIMESTAMP(3),
  ADD COLUMN "weeklyMarketingEmailCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "marketingEmailsUnsubscribedAt" TIMESTAMP(3);
