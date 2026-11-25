-- AlterTable ContentWorkspaceUsage: add trialAiCreditsUsed
ALTER TABLE "ContentWorkspaceUsage" ADD COLUMN IF NOT EXISTS "trialAiCreditsUsed" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing trial usage into trialAiCreditsUsed for active or historical trial accounts
UPDATE "ContentWorkspaceUsage" u
SET "trialAiCreditsUsed" = LEAST(10, u."aiGenerationsUsed")
FROM "Creator" c
WHERE u."creatorId" = c."id"
  AND (c."contentWorkspaceBillingStatus" = 'TRIAL' OR c."contentWorkspaceTrialEndsAt" IS NOT NULL)
  AND u."trialAiCreditsUsed" = 0
  AND u."aiGenerationsUsed" > 0;
