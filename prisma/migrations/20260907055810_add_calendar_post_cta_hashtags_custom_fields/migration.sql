-- AlterTable
ALTER TABLE "CalendarPost" ADD COLUMN     "cta" TEXT,
ADD COLUMN     "hashtags" TEXT,
ADD COLUMN     "linkUrl" TEXT,
ADD COLUMN     "taggedAccounts" TEXT;

-- CreateTable
CREATE TABLE "CalendarPostCustomField" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "CalendarPostCustomField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarPostCustomField_postId_idx" ON "CalendarPostCustomField"("postId");

-- AddForeignKey
ALTER TABLE "CalendarPostCustomField" ADD CONSTRAINT "CalendarPostCustomField_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CalendarPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
