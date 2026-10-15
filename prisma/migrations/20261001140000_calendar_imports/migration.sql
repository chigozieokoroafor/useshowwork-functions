CREATE TABLE "CalendarImport" (
  "id" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "payloadHash" VARCHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalendarImport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CalendarImport_calendarId_requestId_key" ON "CalendarImport"("calendarId", "requestId");
CREATE INDEX "CalendarImport_calendarId_idx" ON "CalendarImport"("calendarId");
ALTER TABLE "CalendarImport" ADD CONSTRAINT "CalendarImport_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
