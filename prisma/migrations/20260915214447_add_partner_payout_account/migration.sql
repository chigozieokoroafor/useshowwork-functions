-- CreateTable
CREATE TABLE "PartnerPayoutAccount" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerPayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerPayoutAccount_partnerId_key" ON "PartnerPayoutAccount"("partnerId");

-- AddForeignKey
ALTER TABLE "PartnerPayoutAccount" ADD CONSTRAINT "PartnerPayoutAccount_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "PartnerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
