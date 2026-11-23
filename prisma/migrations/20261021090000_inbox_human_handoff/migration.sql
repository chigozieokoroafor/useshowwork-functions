ALTER TABLE "SocialLeadConversation"
  ADD COLUMN "aiPausedAt" TIMESTAMP(3),
  ADD COLUMN "aiHandoffReason" TEXT,
  ADD COLUMN "aiHandoffAcknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "aiControlVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "InboxHandoffNotification" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL,
  "recipientId" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboxHandoffNotification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboxHandoffNotification_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SocialLeadConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "inbox_handoff_recipient_event_key" ON "InboxHandoffNotification"("conversationId", "eventVersion", "recipientId");
CREATE INDEX "InboxHandoffNotification_sentAt_nextAttemptAt_idx" ON "InboxHandoffNotification"("sentAt", "nextAttemptAt");
