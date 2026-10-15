-- CreateTable
CREATE TABLE "WebinarRsvp" (
    "id" TEXT NOT NULL,
    "webinarId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "whatsappNumber" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "joinedCommunity" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebinarRsvp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebinarRsvp_webinarId_idx" ON "WebinarRsvp"("webinarId");

-- AddForeignKey
ALTER TABLE "WebinarRsvp" ADD CONSTRAINT "WebinarRsvp_webinarId_fkey" FOREIGN KEY ("webinarId") REFERENCES "CreativoWebinar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
