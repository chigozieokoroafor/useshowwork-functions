ALTER TABLE "SocialCalendar" ADD COLUMN "aiBusinessSummarySourceHash" VARCHAR(64);
CREATE TABLE "BusinessResearchRun" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "calendarId" TEXT NOT NULL REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "status" TEXT NOT NULL DEFAULT 'QUEUED',
 "phase" TEXT NOT NULL DEFAULT 'Waiting to research',
 "focus" TEXT NOT NULL,
 "sourceHash" VARCHAR(64),
 "result" JSONB,
 "excludedFindingIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "startedAt" TIMESTAMP(3),
 "completedAt" TIMESTAMP(3)
);
CREATE INDEX "BusinessResearchRun_calendarId_createdAt_idx" ON "BusinessResearchRun"("calendarId", "createdAt");
CREATE INDEX "BusinessResearchRun_status_createdAt_idx" ON "BusinessResearchRun"("status", "createdAt");
CREATE UNIQUE INDEX "business_research_one_active" ON "BusinessResearchRun"("calendarId") WHERE "status" IN ('QUEUED','RUNNING');
