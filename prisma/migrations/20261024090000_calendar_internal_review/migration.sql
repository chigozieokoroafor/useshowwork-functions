ALTER TABLE "CalendarPost"
  ADD COLUMN "internalReviewStatus" "InternalReviewStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "internalReviewNote" TEXT,
  ADD COLUMN "internalReviewedAt" TIMESTAMP(3),
  ADD COLUMN "internalReviewedBy" TEXT,
  ADD COLUMN "internalReviewVersion" INTEGER NOT NULL DEFAULT 0;

-- Preserve already accepted/live work, without exposing existing unapproved drafts.
UPDATE "CalendarPost" SET "internalReviewStatus"='APPROVED', "internalReviewedAt"=CURRENT_TIMESTAMP
WHERE NOT "isAiDraft" AND ("approvalStatus"='APPROVED'
 OR "publishStatus" IN ('SCHEDULED','PUBLISHING','PUBLISHED')
 OR "instagramPublishStatus" IN ('SCHEDULED','PUBLISHING','PUBLISHED')
 OR "tikTokPublishStatus" IN ('SCHEDULED','PUBLISHING','PUBLISHED'));

CREATE FUNCTION calendar_post_internal_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW."postDate",NEW.platform,NEW."postType",NEW.category,NEW.caption,NEW.hook,NEW.script,NEW."contentIdea",NEW.cta,NEW.hashtags,NEW."taggedAccounts",NEW."linkUrl",NEW."isAiDraft")
    IS DISTINCT FROM ROW(OLD."postDate",OLD.platform,OLD."postType",OLD.category,OLD.caption,OLD.hook,OLD.script,OLD."contentIdea",OLD.cta,OLD.hashtags,OLD."taggedAccounts",OLD."linkUrl",OLD."isAiDraft") THEN
   IF OLD."approvalStatus"='APPROVED' THEN RAISE EXCEPTION 'APPROVED_CONTENT_LOCKED'; END IF;
   NEW."internalReviewStatus":='PENDING';
   NEW."internalReviewNote":=NULL;
   NEW."internalReviewedAt":=NULL;
   NEW."internalReviewedBy":=NULL;
   NEW."internalReviewVersion":=OLD."internalReviewVersion"+1;
   NEW."approvalStatus":='PENDING';
   NEW."approvalNote":=NULL;
   NEW."reviewedAt":=NULL;
  END IF;
 END IF;
 IF NEW."internalReviewStatus"<>'APPROVED' AND (NEW."approvalStatus"='APPROVED'
  OR NEW."publishStatus" IN ('SCHEDULED','PUBLISHING','PUBLISHED')
  OR NEW."instagramPublishStatus" IN ('SCHEDULED','PUBLISHING','PUBLISHED')
  OR NEW."tikTokPublishStatus" IN ('SCHEDULED','PUBLISHING','PUBLISHED')) THEN
  RAISE EXCEPTION 'INTERNAL_REVIEW_REQUIRED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calendar_post_internal_review BEFORE INSERT OR UPDATE ON "CalendarPost"
FOR EACH ROW EXECUTE FUNCTION calendar_post_internal_review_guard();

CREATE FUNCTION calendar_post_review_media_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_id TEXT;
BEGIN
 affected_id := CASE WHEN TG_OP='DELETE' THEN OLD."postId" ELSE NEW."postId" END;
 -- Lock the parent before testing approval so concurrent approvals cannot be bypassed.
 PERFORM id FROM "CalendarPost" WHERE id=affected_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM "CalendarPost" WHERE id=affected_id AND "approvalStatus"='APPROVED') THEN
  RAISE EXCEPTION 'APPROVED_CONTENT_LOCKED';
 END IF;
 -- This update serializes media changes against approval.
 UPDATE "CalendarPost" SET "internalReviewStatus"='PENDING',"internalReviewNote"=NULL,
  "internalReviewedAt"=NULL,"internalReviewedBy"=NULL,"internalReviewVersion"="internalReviewVersion"+1,
  "approvalStatus"='PENDING',"approvalNote"=NULL,"reviewedAt"=NULL,"updatedAt"=clock_timestamp()
 WHERE id=affected_id;
 IF TG_OP='UPDATE' AND OLD."postId" IS DISTINCT FROM NEW."postId" THEN
  RAISE EXCEPTION 'POST_ASSET_REASSIGNMENT_NOT_ALLOWED';
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER calendar_post_asset_review AFTER INSERT OR UPDATE OR DELETE ON "CalendarPostAsset"
FOR EACH ROW EXECUTE FUNCTION calendar_post_review_media_changed();
CREATE TRIGGER calendar_post_custom_field_review AFTER INSERT OR UPDATE OR DELETE ON "CalendarPostCustomField"
FOR EACH ROW EXECUTE FUNCTION calendar_post_review_media_changed();
