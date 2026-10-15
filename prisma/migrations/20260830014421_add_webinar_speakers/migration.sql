-- CreateTable
CREATE TABLE "WebinarSpeaker" (
    "id" TEXT NOT NULL,
    "webinarId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bio" TEXT,
    "profileImageUrl" TEXT,
    "instagramUrl" TEXT,
    "youtubeUrl" TEXT,
    "xUrl" TEXT,
    "linkedinUrl" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebinarSpeaker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebinarSpeaker_webinarId_idx" ON "WebinarSpeaker"("webinarId");

-- AddForeignKey
ALTER TABLE "WebinarSpeaker" ADD CONSTRAINT "WebinarSpeaker_webinarId_fkey" FOREIGN KEY ("webinarId") REFERENCES "CreativoWebinar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
