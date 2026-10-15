-- CreateTable
CREATE TABLE "CalendarPostAiGeneration" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "generationNumber" INTEGER NOT NULL,
    "postDate" TIMESTAMP(3) NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "postType" TEXT,
    "category" TEXT,
    "caption" TEXT,
    "contentIdea" TEXT,
    "cta" TEXT,
    "hashtags" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarPostAiGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarPostAiGeneration_postId_idx" ON "CalendarPostAiGeneration"("postId");

-- CreateIndex
CREATE INDEX "CalendarPostAiGeneration_postId_generationNumber_idx" ON "CalendarPostAiGeneration"("postId", "generationNumber");

-- AddForeignKey
ALTER TABLE "CalendarPostAiGeneration" ADD CONSTRAINT "CalendarPostAiGeneration_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CalendarPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
