-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isDeactivated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifyOnView" BOOLEAN NOT NULL DEFAULT false;
