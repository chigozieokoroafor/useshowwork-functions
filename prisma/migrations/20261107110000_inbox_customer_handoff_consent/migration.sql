ALTER TABLE "SocialLeadConversation"
  ADD COLUMN "aiHandoffOfferedAt" TIMESTAMP(3),
  ADD COLUMN "aiHandoffOfferMessageId" TEXT,
  ADD COLUMN "aiHandoffDeclinedAt" TIMESTAMP(3);
ALTER TABLE "SocialInboxOutbound" ADD COLUMN "handoffOffer" BOOLEAN NOT NULL DEFAULT false;
