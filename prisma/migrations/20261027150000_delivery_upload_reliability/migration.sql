ALTER TABLE "Media" ADD COLUMN "uploadSessionId" TEXT, ADD COLUMN "aspectRatio" DOUBLE PRECISION, ADD COLUMN "posterFileKey" TEXT, ADD COLUMN "sizeBytes" DOUBLE PRECISION;
CREATE UNIQUE INDEX "Media_uploadSessionId_key" ON "Media"("uploadSessionId");
CREATE TABLE "DeliveryUploadSession" (
 "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "creatorId" TEXT NOT NULL,
 "fileKey" TEXT NOT NULL, "uploadId" TEXT, "expectedBytes" BIGINT NOT NULL,
 "contentType" TEXT NOT NULL, "purpose" TEXT NOT NULL DEFAULT 'NEW', "targetId" TEXT, "state" TEXT NOT NULL DEFAULT 'OPEN', "mediaId" TEXT,
 "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "DeliveryUploadSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeliveryUploadSession_fileKey_key" ON "DeliveryUploadSession"("fileKey");
CREATE INDEX "DeliveryUploadSession_projectId_creatorId_idx" ON "DeliveryUploadSession"("projectId", "creatorId");
CREATE INDEX "DeliveryUploadSession_state_expiresAt_idx" ON "DeliveryUploadSession"("state", "expiresAt");

ALTER TABLE "TaskAsset" ADD COLUMN "uploadSessionId" TEXT, ADD COLUMN "aspectRatio" DOUBLE PRECISION, ADD COLUMN "posterFileKey" TEXT, ADD COLUMN "sizeBytes" DOUBLE PRECISION;
CREATE UNIQUE INDEX "TaskAsset_uploadSessionId_key" ON "TaskAsset"("uploadSessionId");
