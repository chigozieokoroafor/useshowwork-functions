CREATE TABLE IF NOT EXISTS "CalendarPostTeamFeedback" (
  "id" TEXT PRIMARY KEY,
  "postId" TEXT NOT NULL REFERENCES "CalendarPost"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "authorName" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "CalendarPostTeamFeedback_postId_createdAt_id_idx"
ON "CalendarPostTeamFeedback"("postId", "createdAt", "id");

INSERT INTO "CalendarPostTeamFeedback" ("id", "postId", "authorName", "message", "createdAt")
SELECT 'legacy-' || id, id, 'Earlier team feedback', "internalReviewNote", "updatedAt"
FROM "CalendarPost"
WHERE NULLIF(btrim("internalReviewNote"), '') IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
