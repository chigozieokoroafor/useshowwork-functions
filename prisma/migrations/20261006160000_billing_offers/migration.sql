-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "billingComplimentaryGrants" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "deliveryCompedTier" "SubscriptionTier",
ADD COLUMN     "deliveryCompedUntil" TIMESTAMP(3),
ADD COLUMN     "deliveryOfferSubscriptionId" TEXT,
ADD COLUMN     "workspaceCompedPlan" "ContentWorkspacePlan",
ADD COLUMN     "workspaceCompedUntil" TIMESTAMP(3),
ADD COLUMN     "workspaceOfferSubscriptionId" TEXT;

-- CreateTable
CREATE TABLE "BillingOffer" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "deliveryTier" "SubscriptionTier",
    "workspacePlan" "ContentWorkspacePlan",
    "billingCycle" "BillingCycle",
    "percent" INTEGER NOT NULL,
    "durationMonths" INTEGER NOT NULL,
    "audience" TEXT NOT NULL,
    "availableUntil" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestHash" TEXT,
    "revokedBy" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "BillingOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingOfferRecipient" (
    "offerId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,

    CONSTRAINT "BillingOfferRecipient_pkey" PRIMARY KEY ("offerId","creatorId")
);

-- CreateTable
CREATE TABLE "BillingOfferSubscription" (
    "id" TEXT NOT NULL,
    "offerId" TEXT,
    "creatorId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "title" TEXT NOT NULL,
    "percent" INTEGER NOT NULL,
    "durationMonths" INTEGER NOT NULL,
    "standardPriceNgn" INTEGER NOT NULL,
    "discountedPriceNgn" INTEGER NOT NULL,
    "paystackPlanCode" TEXT,
    "checkoutReference" TEXT,
    "subscriptionCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CHECKOUT',
    "paidCycles" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "discountEndsAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingOfferSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingOfferCharge" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "amountNgn" INTEGER NOT NULL,

    CONSTRAINT "BillingOfferCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingOfferRedemption" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "discountEndsAt" TIMESTAMP(3) NOT NULL,
    "paidCycles" INTEGER NOT NULL DEFAULT 0,
    "maxCycles" INTEGER NOT NULL,

    CONSTRAINT "BillingOfferRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingOffer_revokedAt_availableUntil_idx" ON "BillingOffer"("revokedAt", "availableUntil");

-- CreateIndex
CREATE INDEX "BillingOfferRecipient_creatorId_idx" ON "BillingOfferRecipient"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingOfferSubscription_paystackPlanCode_key" ON "BillingOfferSubscription"("paystackPlanCode");

-- CreateIndex
CREATE UNIQUE INDEX "BillingOfferSubscription_checkoutReference_key" ON "BillingOfferSubscription"("checkoutReference");

-- CreateIndex
CREATE INDEX "BillingOfferSubscription_creatorId_product_status_idx" ON "BillingOfferSubscription"("creatorId", "product", "status");

-- CreateIndex
CREATE INDEX "BillingOfferSubscription_status_discountEndsAt_idx" ON "BillingOfferSubscription"("status", "discountEndsAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingOfferCharge_reference_key" ON "BillingOfferCharge"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "BillingOfferRedemption_offerId_creatorId_product_key" ON "BillingOfferRedemption"("offerId", "creatorId", "product");

-- AddForeignKey
ALTER TABLE "BillingOfferRecipient" ADD CONSTRAINT "BillingOfferRecipient_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "BillingOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOfferRecipient" ADD CONSTRAINT "BillingOfferRecipient_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOfferSubscription" ADD CONSTRAINT "BillingOfferSubscription_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "BillingOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOfferSubscription" ADD CONSTRAINT "BillingOfferSubscription_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOfferCharge" ADD CONSTRAINT "BillingOfferCharge_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BillingOfferSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOfferRedemption" ADD CONSTRAINT "BillingOfferRedemption_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "BillingOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOfferRedemption" ADD CONSTRAINT "BillingOfferRedemption_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Import previous percentages as explicit Delivery-only, 12-month offers.
-- Existing provider subscriptions are untouched. These terms apply at a new checkout.
INSERT INTO "BillingOffer" ("id", "title", "product", "percent", "durationMonths", "audience", "createdBy", "createdAt")
SELECT 'legacy-delivery-' || "id", 'Account discount', 'DELIVERY', "discountPercent", 12, 'SELECTED', 'legacy-import', CURRENT_TIMESTAMP
FROM "Creator" WHERE "discountPercent" BETWEEN 1 AND 99;
INSERT INTO "BillingOfferRecipient" ("offerId", "creatorId")
SELECT 'legacy-delivery-' || "id", "id" FROM "Creator" WHERE "discountPercent" BETWEEN 1 AND 99;
INSERT INTO "BillingOffer" ("id", "title", "product", "percent", "durationMonths", "audience", "createdBy", "createdAt")
SELECT 'legacy-global-delivery', 'Delivery welcome discount', 'DELIVERY', "globalDiscountPercent", 12, 'ALL', 'legacy-import', CURRENT_TIMESTAMP
FROM "PlatformSettings" WHERE "id" = 'singleton' AND "globalDiscountPercent" BETWEEN 1 AND 99;

ALTER TABLE "BillingOffer" ADD CONSTRAINT "BillingOffer_valid_terms" CHECK (
  "product" IN ('DELIVERY', 'CONTENT_WORKSPACE', 'BOTH') AND "audience" IN ('ALL', 'SELECTED')
  AND "percent" BETWEEN 1 AND 100 AND "durationMonths" BETWEEN 1 AND 36
  AND ("billingCycle" IS NULL OR "billingCycle" <> 'ANNUAL' OR "durationMonths" % 12 = 0)
  AND ("deliveryTier" IS NULL OR "deliveryTier" <> 'FREE')
  AND ("percent" < 100 OR ("audience" = 'SELECTED'
    AND ("product" = 'CONTENT_WORKSPACE' OR "deliveryTier" IS NOT NULL)
    AND ("product" = 'DELIVERY' OR "workspacePlan" IS NOT NULL)))
);
ALTER TABLE "BillingOfferSubscription" ADD CONSTRAINT "BillingOfferSubscription_valid_terms" CHECK (
  "product" IN ('DELIVERY', 'CONTENT_WORKSPACE')
  AND (("product" = 'DELIVERY' AND "plan" IN ('STARTER', 'GROWTH', 'UNLIMITED'))
    OR ("product" = 'CONTENT_WORKSPACE' AND "plan" IN ('CREATOR', 'STUDIO', 'UNLIMITED')))
  AND "percent" BETWEEN 1 AND 100 AND "durationMonths" BETWEEN 1 AND 36 AND "paidCycles" >= 0
  AND "standardPriceNgn" >= 0 AND "discountedPriceNgn" >= 0
  AND "discountedPriceNgn" <= "standardPriceNgn"
  AND "status" IN ('CHECKOUT', 'FAILED', 'ACTIVE', 'RESTORE_PENDING', 'STANDARD', 'COMPLIMENTARY')
);
ALTER TABLE "BillingOfferRedemption" ADD CONSTRAINT "BillingOfferRedemption_valid_cycles" CHECK (
  "paidCycles" >= 0 AND "maxCycles" > 0 AND "discountEndsAt" > "activatedAt"
);
