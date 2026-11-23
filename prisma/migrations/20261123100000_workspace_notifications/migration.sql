CREATE TABLE IF NOT EXISTS "WorkspaceNotification" (
  "calendarId" TEXT NOT NULL REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "eventKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "batchId" TEXT,
  "actor" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "postId" TEXT,
  "focusDate" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("calendarId", "eventKey")
);
CREATE INDEX IF NOT EXISTS "WorkspaceNotification_calendarId_createdAt_idx"
  ON "WorkspaceNotification" ("calendarId", "createdAt");
