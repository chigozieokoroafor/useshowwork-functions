CREATE TYPE "CalendarLeadTemperature" AS ENUM ('COLD', 'WARM', 'HOT');
CREATE TYPE "CalendarLeadPipelineStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CUSTOMER', 'LOST');
CREATE TYPE "CalendarLeadSource" AS ENUM ('SOCIAL', 'MANUAL', 'IMPORT');

CREATE TABLE "CalendarLead" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "socialConversationId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "company" TEXT,
    "temperature" "CalendarLeadTemperature" NOT NULL DEFAULT 'WARM',
    "status" "CalendarLeadPipelineStatus" NOT NULL DEFAULT 'NEW',
    "source" "CalendarLeadSource" NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CalendarLead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CalendarLead_socialConversationId_key" ON "CalendarLead"("socialConversationId");
CREATE INDEX "CalendarLead_calendarId_status_idx" ON "CalendarLead"("calendarId", "status");
CREATE INDEX "CalendarLead_calendarId_temperature_idx" ON "CalendarLead"("calendarId", "temperature");
CREATE INDEX "CalendarLead_calendarId_updatedAt_idx" ON "CalendarLead"("calendarId", "updatedAt");
CREATE UNIQUE INDEX "CalendarLead_calendarId_email_key" ON "CalendarLead"("calendarId", "email");

ALTER TABLE "CalendarLead" ADD CONSTRAINT "CalendarLead_calendarId_fkey"
FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarLead" ADD CONSTRAINT "CalendarLead_socialConversationId_fkey"
FOREIGN KEY ("socialConversationId") REFERENCES "SocialLeadConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "CalendarLead" (
    "id", "calendarId", "socialConversationId", "name", "status", "source", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    conversation."calendarId",
    conversation."id",
    COALESCE(NULLIF(conversation."participantName", ''), NULLIF(conversation."participantUsername", ''), 'Social contact'),
    CASE WHEN conversation."leadStatus" = 'NOT_A_LEAD' THEN 'LOST'::"CalendarLeadPipelineStatus"
         ELSE conversation."leadStatus"::text::"CalendarLeadPipelineStatus" END,
    'SOCIAL'::"CalendarLeadSource",
    conversation."createdAt",
    conversation."updatedAt"
FROM "SocialLeadConversation" AS conversation
ON CONFLICT ("socialConversationId") DO NOTHING;
