ALTER TABLE "CalendarLead" ADD COLUMN "username" TEXT;

UPDATE "CalendarLead" AS lead
SET "username" = conversation."participantUsername"
FROM "SocialLeadConversation" AS conversation
WHERE lead."socialConversationId" = conversation."id"
  AND conversation."participantUsername" IS NOT NULL;
