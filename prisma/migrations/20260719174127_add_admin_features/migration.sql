-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('PROJECT_ONE_TIME', 'SUBSCRIPTION_INITIAL', 'SUBSCRIPTION_RENEWAL');

-- DropForeignKey
ALTER TABLE "Project" DROP CONSTRAINT "Project_creatorId_fkey";

-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "discountPercent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isComped" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "amountNgn" INTEGER NOT NULL,
    "type" "PaymentType" NOT NULL,
    "tier" "SubscriptionTier",
    "paystackReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "globalDiscountPercent" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentRecord_creatorId_idx" ON "PaymentRecord"("creatorId");

-- CreateIndex
CREATE INDEX "PaymentRecord_createdAt_idx" ON "PaymentRecord"("createdAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
