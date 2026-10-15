ALTER TYPE "CalendarRole" ADD VALUE IF NOT EXISTS 'MANAGER';
ALTER TYPE "CalendarRole" ADD VALUE IF NOT EXISTS 'SOCIAL_MEDIA_MANAGER';
ALTER TYPE "CalendarRole" ADD VALUE IF NOT EXISTS 'CREATIVE_CONTRIBUTOR';
ALTER TYPE "CalendarRole" ADD VALUE IF NOT EXISTS 'INBOX_AGENT';
ALTER TYPE "CalendarRole" ADD VALUE IF NOT EXISTS 'VIEWER';
ALTER TABLE "CalendarCollaborator" ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], ADD COLUMN "customPermissions" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CalendarInvite" ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], ADD COLUMN "customPermissions" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'QUEUED', ADD COLUMN "lastDeliveryError" TEXT;
CREATE TABLE "CalendarTeamActivity" (
  "id" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "actorCreatorId" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetEmail" TEXT NOT NULL,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalendarTeamActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CalendarTeamActivity_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CalendarTeamActivity_calendarId_createdAt_idx" ON "CalendarTeamActivity"("calendarId", "createdAt");
