CREATE TABLE "AiGenerationJob" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "request" JSONB NOT NULL,
  "result" JSONB,
  "httpStatus" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiGenerationJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiGenerationJob_creatorId_calendarId_createdAt_idx" ON "AiGenerationJob"("creatorId", "calendarId", "createdAt");
CREATE INDEX "AiGenerationJob_status_createdAt_idx" ON "AiGenerationJob"("status", "createdAt");
