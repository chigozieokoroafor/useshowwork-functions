CREATE TABLE "WorkspaceStorageCleanup" (
 "id" TEXT NOT NULL PRIMARY KEY, "fileKey" TEXT NOT NULL UNIQUE,
 "creatorId" TEXT NOT NULL, "calendarId" TEXT NOT NULL, "bytes" BIGINT NOT NULL CHECK ("bytes">=0),
 "state" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','DELETING','COMPLETE')),
 "notBefore" TIMESTAMP(3) NOT NULL, "usageReleasedAt" TIMESTAMP(3),
 "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
 "lastError" TEXT, "completedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WorkspaceStorageCleanup_state_notBefore_idx" ON "WorkspaceStorageCleanup"("state","notBefore");

CREATE INDEX "CalendarPostAsset_fileKey_idx" ON "CalendarPostAsset"("fileKey");
CREATE INDEX "CalendarBusinessDocument_fileKey_idx" ON "CalendarBusinessDocument"("fileKey");
