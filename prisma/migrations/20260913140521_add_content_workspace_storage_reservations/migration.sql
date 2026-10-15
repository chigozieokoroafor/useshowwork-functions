-- CreateEnum
CREATE TYPE "ContentWorkspaceStorageReservationStatus" AS ENUM ('PENDING', 'COMPLETED', 'RELEASED');

-- CreateTable
CREATE TABLE "ContentWorkspaceStorageReservation" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "status" "ContentWorkspaceStorageReservationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "ContentWorkspaceStorageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentWorkspaceStorageReservation_creatorId_status_idx" ON "ContentWorkspaceStorageReservation"("creatorId", "status");

-- CreateIndex
CREATE INDEX "ContentWorkspaceStorageReservation_calendarId_idx" ON "ContentWorkspaceStorageReservation"("calendarId");

-- CreateIndex
CREATE INDEX "ContentWorkspaceStorageReservation_fileKey_idx" ON "ContentWorkspaceStorageReservation"("fileKey");

-- CreateIndex
CREATE INDEX "ContentWorkspaceStorageReservation_expiresAt_idx" ON "ContentWorkspaceStorageReservation"("expiresAt");

-- AddForeignKey
ALTER TABLE "ContentWorkspaceStorageReservation" ADD CONSTRAINT "ContentWorkspaceStorageReservation_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentWorkspaceStorageReservation" ADD CONSTRAINT "ContentWorkspaceStorageReservation_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
