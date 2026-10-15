-- AlterTable
ALTER TABLE "CalendarBusinessDocument" ADD COLUMN     "sizeBytes" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CalendarPostAsset" ADD COLUMN     "sizeBytes" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ContentWorkspaceUsage" ADD COLUMN     "storageReservedBytes" BIGINT NOT NULL DEFAULT 0;
