-- CreateEnum
CREATE TYPE "ManagedProjectStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');

-- CreateTable
CREATE TABLE "ManagedProject" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brief" TEXT,
    "status" "ManagedProjectStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "deliveryProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedProjectCollaborator" (
    "id" TEXT NOT NULL,
    "managedProjectId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagedProjectCollaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "managedProjectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assignedToCreatorId" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedProject_deliveryProjectId_key" ON "ManagedProject"("deliveryProjectId");

-- CreateIndex
CREATE INDEX "ManagedProjectCollaborator_managedProjectId_idx" ON "ManagedProjectCollaborator"("managedProjectId");

-- CreateIndex
CREATE INDEX "ManagedProjectCollaborator_creatorId_idx" ON "ManagedProjectCollaborator"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedProjectCollaborator_managedProjectId_creatorId_key" ON "ManagedProjectCollaborator"("managedProjectId", "creatorId");

-- CreateIndex
CREATE INDEX "Task_managedProjectId_idx" ON "Task"("managedProjectId");

-- CreateIndex
CREATE INDEX "Task_assignedToCreatorId_idx" ON "Task"("assignedToCreatorId");

-- AddForeignKey
ALTER TABLE "ManagedProject" ADD CONSTRAINT "ManagedProject_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedProject" ADD CONSTRAINT "ManagedProject_deliveryProjectId_fkey" FOREIGN KEY ("deliveryProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedProjectCollaborator" ADD CONSTRAINT "ManagedProjectCollaborator_managedProjectId_fkey" FOREIGN KEY ("managedProjectId") REFERENCES "ManagedProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedProjectCollaborator" ADD CONSTRAINT "ManagedProjectCollaborator_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_managedProjectId_fkey" FOREIGN KEY ("managedProjectId") REFERENCES "ManagedProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedToCreatorId_fkey" FOREIGN KEY ("assignedToCreatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
