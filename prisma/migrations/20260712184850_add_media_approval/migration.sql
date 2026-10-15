-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'NEEDS_REVISION');

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "approvalNote" TEXT,
ADD COLUMN     "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;
