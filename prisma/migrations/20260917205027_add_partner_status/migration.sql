-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED');

-- AlterTable
ALTER TABLE "PartnerProfile" ADD COLUMN     "status" "PartnerStatus" NOT NULL DEFAULT 'PENDING';
