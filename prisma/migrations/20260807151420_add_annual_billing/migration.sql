-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');

-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "subscriptionCycle" "BillingCycle";

-- AlterTable
ALTER TABLE "PaymentRecord" ADD COLUMN     "cycle" "BillingCycle";
