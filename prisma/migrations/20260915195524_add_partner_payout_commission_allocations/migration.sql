-- CreateTable
CREATE TABLE "PartnerPayoutCommission" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "commissionId" TEXT NOT NULL,
    "amountNgn" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerPayoutCommission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerPayoutCommission_commissionId_key" ON "PartnerPayoutCommission"("commissionId");

-- CreateIndex
CREATE INDEX "PartnerPayoutCommission_payoutId_idx" ON "PartnerPayoutCommission"("payoutId");

-- CreateIndex
CREATE INDEX "PartnerPayoutCommission_commissionId_idx" ON "PartnerPayoutCommission"("commissionId");

-- AddForeignKey
ALTER TABLE "PartnerPayoutCommission" ADD CONSTRAINT "PartnerPayoutCommission_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "PartnerPayout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPayoutCommission" ADD CONSTRAINT "PartnerPayoutCommission_commissionId_fkey" FOREIGN KEY ("commissionId") REFERENCES "ReferralCommission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
