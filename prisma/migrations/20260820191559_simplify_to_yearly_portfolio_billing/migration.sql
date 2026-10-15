/*
  Warnings:

  - The values [PORTFOLIO_SETUP_FEE] on the enum `PaymentType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `setupFeePaid` on the `Portfolio` table. All the data in the column will be lost.
  - You are about to drop the column `setupFeePaystackRef` on the `Portfolio` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[pendingSubscriptionRef]` on the table `Portfolio` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PaymentType_new" AS ENUM ('PROJECT_ONE_TIME', 'SUBSCRIPTION_INITIAL', 'SUBSCRIPTION_RENEWAL', 'PORTFOLIO_SUBSCRIPTION_INITIAL', 'PORTFOLIO_SUBSCRIPTION_RENEWAL');
ALTER TABLE "PaymentRecord" ALTER COLUMN "type" TYPE "PaymentType_new" USING ("type"::text::"PaymentType_new");
ALTER TYPE "PaymentType" RENAME TO "PaymentType_old";
ALTER TYPE "PaymentType_new" RENAME TO "PaymentType";
DROP TYPE "PaymentType_old";
COMMIT;

-- DropIndex
DROP INDEX "Portfolio_setupFeePaystackRef_key";

-- AlterTable
ALTER TABLE "Portfolio" DROP COLUMN "setupFeePaid",
DROP COLUMN "setupFeePaystackRef",
ADD COLUMN     "pendingSubscriptionRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Portfolio_pendingSubscriptionRef_key" ON "Portfolio"("pendingSubscriptionRef");
