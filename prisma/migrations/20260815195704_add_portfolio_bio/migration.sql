-- AlterTable
ALTER TABLE "Portfolio" ADD COLUMN     "bioPhotoUrl" TEXT,
ADD COLUMN     "bioSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "bioStat" TEXT,
ADD COLUMN     "bioText" TEXT;
