/*
  Warnings:

  - You are about to drop the column `brief` on the `ManagedProject` table. All the data in the column will be lost.
  - Added the required column `createdByCreatorId` to the `Task` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "InternalReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'NEEDS_CHANGES');

-- AlterTable
ALTER TABLE "ManagedProject" DROP COLUMN "brief",
ADD COLUMN     "briefBackground" TEXT,
ADD COLUMN     "briefBrandGuidelines" TEXT,
ADD COLUMN     "briefCreativeDirection" TEXT,
ADD COLUMN     "briefDeadline" TIMESTAMP(3),
ADD COLUMN     "briefDeliverables" TEXT,
ADD COLUMN     "briefImportantNotes" TEXT,
ADD COLUMN     "briefObjective" TEXT,
ADD COLUMN     "briefPlatforms" TEXT,
ADD COLUMN     "briefReferences" TEXT,
ADD COLUMN     "briefRequiredFormats" TEXT,
ADD COLUMN     "briefTargetAudience" TEXT,
ADD COLUMN     "briefVisibleToClient" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "createdByCreatorId" TEXT NOT NULL,
ADD COLUMN     "milestoneId" TEXT,
ADD COLUMN     "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM';

-- CreateTable
CREATE TABLE "BriefAttachment" (
    "id" TEXT NOT NULL,
    "managedProjectId" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "filename" TEXT,
    "uploadedByCreatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BriefAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "managedProjectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAsset" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "filename" TEXT,
    "uploadedByCreatorId" TEXT NOT NULL,
    "internalReviewStatus" "InternalReviewStatus" NOT NULL DEFAULT 'PENDING',
    "internalReviewNote" TEXT,
    "internalReviewedAt" TIMESTAMP(3),
    "promotedToMediaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BriefAttachment_managedProjectId_idx" ON "BriefAttachment"("managedProjectId");

-- CreateIndex
CREATE INDEX "Milestone_managedProjectId_idx" ON "Milestone"("managedProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskAsset_promotedToMediaId_key" ON "TaskAsset"("promotedToMediaId");

-- CreateIndex
CREATE INDEX "TaskAsset_taskId_idx" ON "TaskAsset"("taskId");

-- CreateIndex
CREATE INDEX "Task_milestoneId_idx" ON "Task"("milestoneId");

-- AddForeignKey
ALTER TABLE "BriefAttachment" ADD CONSTRAINT "BriefAttachment_managedProjectId_fkey" FOREIGN KEY ("managedProjectId") REFERENCES "ManagedProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefAttachment" ADD CONSTRAINT "BriefAttachment_uploadedByCreatorId_fkey" FOREIGN KEY ("uploadedByCreatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_managedProjectId_fkey" FOREIGN KEY ("managedProjectId") REFERENCES "ManagedProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByCreatorId_fkey" FOREIGN KEY ("createdByCreatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAsset" ADD CONSTRAINT "TaskAsset_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAsset" ADD CONSTRAINT "TaskAsset_uploadedByCreatorId_fkey" FOREIGN KEY ("uploadedByCreatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAsset" ADD CONSTRAINT "TaskAsset_promotedToMediaId_fkey" FOREIGN KEY ("promotedToMediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
