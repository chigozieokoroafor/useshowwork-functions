ALTER TABLE "PartnerPayoutAccount" ADD COLUMN "bankCode" TEXT, ADD COLUMN "verifiedAt" TIMESTAMP(3);
ALTER TABLE "PartnerPayout" ADD COLUMN "bankName" TEXT, ADD COLUMN "bankCode" TEXT, ADD COLUMN "accountNumber" TEXT, ADD COLUMN "accountName" TEXT, ADD COLUMN "accountVerifiedAt" TIMESTAMP(3);
-- Historic destinations cannot be reconstructed reliably; never backfill from mutable bank details.
ALTER TABLE "ReferralCommission" ADD COLUMN "reversedAmountNgn" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "onHold" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "recoverySettledNgn" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_reversal_check" CHECK ("reversedAmountNgn" BETWEEN 0 AND "commissionAmountNgn" AND "recoverySettledNgn" BETWEEN 0 AND "reversedAmountNgn");
CREATE TABLE "PartnerPaymentIssue" ("id" TEXT PRIMARY KEY, "reference" TEXT NOT NULL, "kind" TEXT NOT NULL, "relatedIssueId" TEXT, "state" TEXT NOT NULL, "amountKobo" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "PartnerPaymentIssue_reference_idx" ON "PartnerPaymentIssue"("reference");
CREATE TABLE "PartnerAuditEvent" ("id" TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, "targetId" TEXT NOT NULL, "action" TEXT NOT NULL, "detail" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "PartnerAuditEvent_targetId_createdAt_idx" ON "PartnerAuditEvent"("targetId", "createdAt");
