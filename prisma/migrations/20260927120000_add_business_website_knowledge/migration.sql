ALTER TABLE "CalendarBusinessDocument" ALTER COLUMN "fileKey" DROP NOT NULL;

ALTER TABLE "CalendarBusinessDocument" ADD COLUMN "websiteUrl" TEXT;
ALTER TABLE "CalendarBusinessDocument" ADD COLUMN "websiteUrlHash" VARCHAR(64);

CREATE UNIQUE INDEX "CalendarBusinessDocument_calendarId_websiteUrlHash_key"
ON "CalendarBusinessDocument"("calendarId", "websiteUrlHash");
