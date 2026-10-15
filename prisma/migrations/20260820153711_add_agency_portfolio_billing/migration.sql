/*
  Warnings:

  - A unique constraint covering the columns `[setupFeePaystackRef]` on the table `Portfolio` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CREATOR', 'AGENCY');

-- CreateEnum
CREATE TYPE "PortfolioBillingStatus" AS ENUM ('ACTIVE', 'OFFLINE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentType" ADD VALUE 'PORTFOLIO_SETUP_FEE';
ALTER TYPE "PaymentType" ADD VALUE 'PORTFOLIO_SUBSCRIPTION_INITIAL';
ALTER TYPE "PaymentType" ADD VALUE 'PORTFOLIO_SUBSCRIPTION_RENEWAL';

-- DropIndex
DROP INDEX "Portfolio_creatorId_key";

-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "accountType" "AccountType" NOT NULL DEFAULT 'CREATOR';

-- AlterTable
ALTER TABLE "PaymentRecord" ADD COLUMN     "portfolioId" TEXT;

-- AlterTable
ALTER TABLE "Portfolio" ADD COLUMN     "billingStatus" "PortfolioBillingStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "lastPaymentReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "paystackCustomerCode" TEXT,
ADD COLUMN     "paystackEmailToken" TEXT,
ADD COLUMN     "paystackSubscriptionCode" TEXT,
ADD COLUMN     "setupFeePaid" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "setupFeePaystackRef" TEXT,
ADD COLUMN     "subscriptionRenewsAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PaymentRecord_portfolioId_idx" ON "PaymentRecord"("portfolioId");

-- CreateIndex
CREATE UNIQUE INDEX "Portfolio_setupFeePaystackRef_key" ON "Portfolio"("setupFeePaystackRef");

-- CreateIndex
CREATE INDEX "Portfolio_creatorId_idx" ON "Portfolio"("creatorId");
