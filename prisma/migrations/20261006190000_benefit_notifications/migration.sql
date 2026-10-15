-- AlterTable
ALTER TABLE "BillingOfferRecipient" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedBy" TEXT;

-- CreateTable
CREATE TABLE "BillingBenefitNotification" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "offerId" TEXT,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingBenefitNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingBenefitNotification_status_nextAttemptAt_idx" ON "BillingBenefitNotification"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "BillingBenefitNotification_offerId_idx" ON "BillingBenefitNotification"("offerId");

-- AddForeignKey
ALTER TABLE "BillingBenefitNotification" ADD CONSTRAINT "BillingBenefitNotification_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "BillingOfferSubscription" DROP CONSTRAINT "BillingOfferSubscription_valid_terms";
ALTER TABLE "BillingOfferSubscription" ADD CONSTRAINT "BillingOfferSubscription_valid_terms" CHECK (
  "product" IN ('DELIVERY', 'CONTENT_WORKSPACE')
  AND (("product" = 'DELIVERY' AND "plan" IN ('STARTER', 'GROWTH', 'UNLIMITED'))
    OR ("product" = 'CONTENT_WORKSPACE' AND "plan" IN ('CREATOR', 'STUDIO', 'UNLIMITED')))
  AND "percent" BETWEEN 1 AND 100 AND "durationMonths" BETWEEN 1 AND 36 AND "paidCycles" >= 0
  AND "standardPriceNgn" >= 0 AND "discountedPriceNgn" >= 0 AND "discountedPriceNgn" <= "standardPriceNgn"
  AND "status" IN ('CHECKOUT', 'FAILED', 'ACTIVE', 'RESTORE_PENDING', 'STANDARD', 'COMPLIMENTARY', 'REVOKED')
);
ALTER TABLE "BillingBenefitNotification" ADD CONSTRAINT "BillingBenefitNotification_valid_state" CHECK (
  "status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED') AND "event" IN ('GRANTED', 'STOPPED') AND "attempts" >= 0
);
