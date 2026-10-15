ALTER TABLE "SocialConnection" ADD COLUMN "whatsappBusinessAccountId" TEXT;

-- A business number routes to one workspace, preventing duplicate AI replies.
CREATE UNIQUE INDEX "SocialConnection_whatsapp_connected_phone_key"
  ON "SocialConnection" ("platformAccountId")
  WHERE "platform" = 'WHATSAPP' AND "status" = 'CONNECTED';
CREATE UNIQUE INDEX "SocialConnection_whatsapp_connected_calendar_key"
  ON "SocialConnection" ("calendarId")
  WHERE "platform" = 'WHATSAPP' AND "status" = 'CONNECTED';
