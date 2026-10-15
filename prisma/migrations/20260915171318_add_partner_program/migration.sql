-- CreateEnum
CREATE TYPE "PartnerReferralStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "PartnerCommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'VOIDED');

-- CreateTable
CREATE TABLE "PartnerProfile" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "referredCreatorId" TEXT NOT NULL,
    "status" "PartnerReferralStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "commissionEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCommission" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "paymentRecordId" TEXT NOT NULL,
    "paymentAmountNgn" INTEGER NOT NULL,
    "commissionPercent" INTEGER NOT NULL,
    "commissionAmountNgn" INTEGER NOT NULL,
    "status" "PartnerCommissionStatus" NOT NULL DEFAULT 'PENDING',
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "payoutReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCommission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerProfile_creatorId_key" ON "PartnerProfile"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerProfile_referralCode_key" ON "PartnerProfile"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referredCreatorId_key" ON "Referral"("referredCreatorId");

-- CreateIndex
CREATE INDEX "Referral_partnerId_idx" ON "Referral"("partnerId");

-- CreateIndex
CREATE INDEX "Referral_referredCreatorId_idx" ON "Referral"("referredCreatorId");

-- CreateIndex
CREATE INDEX "Referral_status_idx" ON "Referral"("status");

-- CreateIndex
CREATE INDEX "Referral_commissionEndsAt_idx" ON "Referral"("commissionEndsAt");

-- CreateIndex
CREATE INDEX "ReferralCommission_referralId_idx" ON "ReferralCommission"("referralId");

-- CreateIndex
CREATE INDEX "ReferralCommission_status_idx" ON "ReferralCommission"("status");

-- CreateIndex
CREATE INDEX "ReferralCommission_earnedAt_idx" ON "ReferralCommission"("earnedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCommission_paymentRecordId_key" ON "ReferralCommission"("paymentRecordId");

-- AddForeignKey
ALTER TABLE "PartnerProfile" ADD CONSTRAINT "PartnerProfile_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "PartnerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredCreatorId_fkey" FOREIGN KEY ("referredCreatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;
