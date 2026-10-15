CREATE TYPE "SocialLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CUSTOMER', 'NOT_A_LEAD');
CREATE TYPE "SocialInboxMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "SocialInboxMessageStatus" AS ENUM ('RECEIVED', 'PENDING', 'SENT', 'FAILED');

ALTER TABLE "SocialConnection" ADD COLUMN "messagingWebhookSubscribedAt" TIMESTAMP(3);
ALTER TABLE "SocialConnection" ADD COLUMN "messagingWebhookError" TEXT;

CREATE TABLE "SocialLeadConversation" (
  "id" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "socialConnectionId" TEXT,
  "platform" "SocialPlatform" NOT NULL,
  "providerConversationId" TEXT NOT NULL,
  "participantPlatformId" TEXT NOT NULL,
  "participantName" TEXT,
  "participantUsername" TEXT,
  "leadStatus" "SocialLeadStatus" NOT NULL DEFAULT 'NEW',
  "unreadCount" INTEGER NOT NULL DEFAULT 0,
  "lastMessagePreview" TEXT,
  "lastMessageAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialLeadConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SocialLeadMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "direction" "SocialInboxMessageDirection" NOT NULL,
  "status" "SocialInboxMessageStatus" NOT NULL DEFAULT 'RECEIVED',
  "text" TEXT NOT NULL,
  "platformCreatedAt" TIMESTAMP(3) NOT NULL,
  "sentByCreatorId" TEXT,
  "isAiGenerated" BOOLEAN NOT NULL DEFAULT false,
  "autoReplyEligible" BOOLEAN NOT NULL DEFAULT false,
  "autoReplyClaimedAt" TIMESTAMP(3),
  "autoReplyHandledAt" TIMESTAMP(3),
  "autoReplyAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "autoReplyHandoffReason" TEXT,
  "sendError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialLeadMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SocialInboxSettings" (
  "id" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "clientAccessEnabled" BOOLEAN NOT NULL DEFAULT true,
  "aiAutoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
  "aiAutoReplyInstructions" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialInboxSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialLeadConversation_socialConnectionId_providerConversationId_key" ON "SocialLeadConversation"("socialConnectionId", "providerConversationId");
CREATE INDEX "SocialLeadConversation_calendarId_lastMessageAt_idx" ON "SocialLeadConversation"("calendarId", "lastMessageAt");
CREATE INDEX "SocialLeadConversation_calendarId_platform_leadStatus_idx" ON "SocialLeadConversation"("calendarId", "platform", "leadStatus");
CREATE UNIQUE INDEX "SocialLeadMessage_conversationId_providerMessageId_key" ON "SocialLeadMessage"("conversationId", "providerMessageId");
CREATE INDEX "SocialLeadMessage_conversationId_platformCreatedAt_idx" ON "SocialLeadMessage"("conversationId", "platformCreatedAt");
CREATE INDEX "SocialLeadMessage_autoReplyEligible_autoReplyHandledAt_idx" ON "SocialLeadMessage"("autoReplyEligible", "autoReplyHandledAt");
CREATE UNIQUE INDEX "SocialInboxSettings_calendarId_key" ON "SocialInboxSettings"("calendarId");

ALTER TABLE "SocialLeadConversation" ADD CONSTRAINT "SocialLeadConversation_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialLeadConversation" ADD CONSTRAINT "SocialLeadConversation_socialConnectionId_fkey" FOREIGN KEY ("socialConnectionId") REFERENCES "SocialConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SocialLeadMessage" ADD CONSTRAINT "SocialLeadMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SocialLeadConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialInboxSettings" ADD CONSTRAINT "SocialInboxSettings_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
