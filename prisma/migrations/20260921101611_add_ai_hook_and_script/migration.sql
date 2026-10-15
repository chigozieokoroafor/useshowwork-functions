-- AlterTable
ALTER TABLE "CalendarPost" ADD COLUMN     "hook" TEXT,
ADD COLUMN     "script" TEXT;

-- AlterTable
ALTER TABLE "CalendarPostAiGeneration" ADD COLUMN     "hook" TEXT,
ADD COLUMN     "script" TEXT;
