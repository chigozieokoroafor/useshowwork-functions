ALTER TABLE "CalendarPostAsset" ADD COLUMN "posterFileKey" TEXT;

-- Survives workspace deletion so abandoned storage uploads can still be aborted.
CREATE TABLE "WorkspaceVideoUpload" (
  id TEXT PRIMARY KEY,
  "calendarId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "fileKey" TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  "partSize" INTEGER NOT NULL,
  "uploadId" TEXT,
  state TEXT NOT NULL DEFAULT 'STARTING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WorkspaceVideoUpload_state_expiresAt_idx" ON "WorkspaceVideoUpload"(state,"expiresAt");

-- Preview metadata is not creative content and must not reset internal/client review.
DROP TRIGGER calendar_post_asset_review ON "CalendarPostAsset";
CREATE TRIGGER calendar_post_asset_review AFTER INSERT OR DELETE ON "CalendarPostAsset"
FOR EACH ROW EXECUTE FUNCTION calendar_post_review_media_changed();
CREATE TRIGGER calendar_post_asset_review_update AFTER UPDATE ON "CalendarPostAsset"
FOR EACH ROW WHEN ((to_jsonb(OLD) - 'posterFileKey') IS DISTINCT FROM (to_jsonb(NEW) - 'posterFileKey'))
EXECUTE FUNCTION calendar_post_review_media_changed();
