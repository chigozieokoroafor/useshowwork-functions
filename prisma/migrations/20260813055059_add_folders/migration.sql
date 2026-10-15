-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "folderId" TEXT;

-- AlterTable
ALTER TABLE "TaskAsset" ADD COLUMN     "folderId" TEXT;

-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskFolder" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskFolder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Folder_sectionId_idx" ON "Folder"("sectionId");

-- CreateIndex
CREATE INDEX "TaskFolder_taskId_idx" ON "TaskFolder"("taskId");

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "MediaSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFolder" ADD CONSTRAINT "TaskFolder_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAsset" ADD CONSTRAINT "TaskAsset_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TaskFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
