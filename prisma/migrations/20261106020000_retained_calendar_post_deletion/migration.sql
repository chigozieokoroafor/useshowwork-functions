ALTER TABLE "CalendarPost" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "CalendarPost_calendarId_deletedAt_idx" ON "CalendarPost"("calendarId", "deletedAt");
