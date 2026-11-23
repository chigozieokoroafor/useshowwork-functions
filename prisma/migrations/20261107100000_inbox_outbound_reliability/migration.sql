CREATE TABLE "SocialInboxOutbound" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "providerMessageId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewedByCreatorId" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialInboxOutbound_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialInboxOutbound_state_check" CHECK ("state" IN ('PENDING','SENDING','SENT','UNCONFIRMED','CANCELLED'))
);
CREATE UNIQUE INDEX "SocialInboxOutbound_messageId_key" ON "SocialInboxOutbound"("messageId");
CREATE INDEX "SocialInboxOutbound_conversationId_state_idx" ON "SocialInboxOutbound"("conversationId", "state");
CREATE INDEX "SocialInboxOutbound_state_startedAt_idx" ON "SocialInboxOutbound"("state", "startedAt");
ALTER TABLE "SocialInboxOutbound" ADD CONSTRAINT "SocialInboxOutbound_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SocialLeadConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
