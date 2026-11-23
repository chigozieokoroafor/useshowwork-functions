CREATE TABLE "WorkspaceRandyConversation" (
 "id" TEXT NOT NULL, "calendarId" TEXT NOT NULL, "creatorId" TEXT NOT NULL, "title" TEXT NOT NULL,
 "processingAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "WorkspaceRandyConversation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkspaceRandyMessage" (
 "id" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "role" TEXT NOT NULL, "body" JSONB NOT NULL,
 "knowledgeDocumentId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "WorkspaceRandyMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkspaceRandyConversation_calendarId_creatorId_updatedAt_idx" ON "WorkspaceRandyConversation"("calendarId", "creatorId", "updatedAt");
CREATE INDEX "WorkspaceRandyMessage_conversationId_createdAt_idx" ON "WorkspaceRandyMessage"("conversationId", "createdAt");
ALTER TABLE "WorkspaceRandyConversation" ADD CONSTRAINT "WorkspaceRandyConversation_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "SocialCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceRandyMessage" ADD CONSTRAINT "WorkspaceRandyMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WorkspaceRandyConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceRandyConversation" ADD CONSTRAINT "WorkspaceRandyConversation_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
