CREATE TABLE "ReportingSyncJob" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "leaseToken" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReportingSyncJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReportingSyncJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SocialConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReportingSyncJob_connectionId_key" ON "ReportingSyncJob"("connectionId");
CREATE INDEX "ReportingSyncJob_status_nextAttemptAt_idx" ON "ReportingSyncJob"("status", "nextAttemptAt");
CREATE INDEX "ReportingSyncJob_calendarId_idx" ON "ReportingSyncJob"("calendarId");

ALTER TABLE "SocialConnection" ADD COLUMN "lastReportingCheckAt" TIMESTAMP(3);
CREATE INDEX "SocialConnection_status_lastReportingCheckAt_idx" ON "SocialConnection"("status", "lastReportingCheckAt");
