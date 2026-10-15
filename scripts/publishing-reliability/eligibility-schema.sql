-- Stage 4C.2 LOCAL proposal. Only after canonical-schema.sql and synthetic
-- application tables. No migration/installer or production schema is modified.
CREATE TABLE "PublishingEligibilityFence"(id integer PRIMARY KEY CHECK(id=1),version bigint NOT NULL DEFAULT 0);
INSERT INTO "PublishingEligibilityFence" VALUES(1,0);
CREATE TABLE "PublishingRevisionPolicy" (
 "intentId" text NOT NULL,revision integer NOT NULL,"calendarId" text NOT NULL,"ownerId" text NOT NULL,
 "principalId" text NOT NULL,"principalKind" text NOT NULL CHECK("principalKind"='CREATOR'),
 PRIMARY KEY("intentId",revision),
 FOREIGN KEY("intentId",revision) REFERENCES "PublishingCanonicalRevision"("intentId",revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE "PublishingEligibilityWitness" (
 id text PRIMARY KEY,"jobId" text NOT NULL REFERENCES "PublishingCanonicalExecution"("jobId") ON DELETE RESTRICT,
 "principalId" text NOT NULL,"fenceVersion" bigint NOT NULL,"validUntil" timestamptz NOT NULL,
 "validatedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER publishing_revision_policy_immutable BEFORE UPDATE OR DELETE ON "PublishingRevisionPolicy" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_witness_immutable BEFORE UPDATE OR DELETE ON "PublishingEligibilityWitness" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_fence_preserved BEFORE DELETE ON "PublishingEligibilityFence" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_eligibility_write_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ELIGIBILITY_ISOLATION_REQUIRED'; END IF;
 UPDATE "PublishingEligibilityFence" SET version=version+1 WHERE id=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'ELIGIBILITY_FENCE_MISSING'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
-- Coarse local serialization deliberately covers every policy-affecting write,
-- including membership deletion, workspace rank changes and asset mutations.
CREATE TRIGGER publishing_creator_eligibility BEFORE INSERT OR UPDATE OR DELETE ON "Creator" FOR EACH ROW EXECUTE FUNCTION publishing_eligibility_write_fence();
CREATE TRIGGER publishing_calendar_eligibility BEFORE INSERT OR UPDATE OR DELETE ON "SocialCalendar" FOR EACH ROW EXECUTE FUNCTION publishing_eligibility_write_fence();
CREATE TRIGGER publishing_member_eligibility BEFORE INSERT OR UPDATE OR DELETE ON "CalendarCollaborator" FOR EACH ROW EXECUTE FUNCTION publishing_eligibility_write_fence();
CREATE TRIGGER publishing_post_eligibility BEFORE INSERT OR UPDATE OR DELETE ON "CalendarPost" FOR EACH ROW EXECUTE FUNCTION publishing_eligibility_write_fence();
CREATE TRIGGER publishing_asset_eligibility BEFORE INSERT OR UPDATE OR DELETE ON "CalendarPostAsset" FOR EACH ROW EXECUTE FUNCTION publishing_eligibility_write_fence();
CREATE TRIGGER publishing_connection_eligibility BEFORE INSERT OR UPDATE OR DELETE ON "SocialConnection" FOR EACH ROW EXECUTE FUNCTION publishing_eligibility_write_fence();

CREATE FUNCTION publishing_eligibility_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_now bigint;principal text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingRevisionPolicy" WHERE "intentId"=NEW."intentId" AND revision=NEW.revision) THEN RETURN NEW; END IF;
 SELECT version INTO version_now FROM "PublishingEligibilityFence" WHERE id=1 FOR SHARE;
 SELECT "principalId" INTO principal FROM "PublishingRevisionPolicy" WHERE "intentId"=NEW."intentId" AND revision=NEW.revision;
 IF current_setting('transaction_isolation')<>'read committed' OR NOT EXISTS(
  SELECT 1 FROM "PublishingEligibilityWitness" WHERE "jobId"=NEW."jobId" AND "principalId"=principal
  AND "fenceVersion"=version_now AND "validUntil">clock_timestamp() AND xmin=pg_current_xact_id()::xid)
 THEN RAISE EXCEPTION 'FRESH_ELIGIBILITY_WITNESS_REQUIRED'; END IF;
 RETURN NEW;
END $$;
-- Trigger ordering places the shared policy fence before canonical account locks.
CREATE TRIGGER publishing_000eligibility_attempt BEFORE INSERT ON "PublishingExternalAttempt" FOR EACH ROW EXECUTE FUNCTION publishing_eligibility_authorization_guard();
CREATE TRIGGER publishing_000eligibility_retry BEFORE UPDATE ON "PublishingRetryGeneration" FOR EACH ROW WHEN(NEW.outcome='AUTHORIZED') EXECUTE FUNCTION publishing_eligibility_authorization_guard();

-- A disconnected/replaced/re-scoped connection cannot revive an old revision
-- merely by restoring CONNECTED. A new explicit account version is required.
CREATE TABLE "PublishingAccountInvalidation" (
 "bindingId" text NOT NULL,version integer NOT NULL,reason text NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY("bindingId",version),
 FOREIGN KEY("bindingId",version) REFERENCES "PublishingAccountVersion"("bindingId",version) ON DELETE RESTRICT
);
CREATE TRIGGER publishing_account_invalidation_immutable BEFORE UPDATE OR DELETE ON "PublishingAccountInvalidation" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_connection_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean;old_scopes text[];new_scopes text[];
BEGIN
 IF TG_OP='DELETE' THEN changed:=true;
 ELSE
  SELECT array_agg(DISTINCT s ORDER BY s) INTO old_scopes FROM regexp_split_to_table(coalesce(OLD."tokenScopes",''),'[[:space:],]+')s WHERE s<>'';
  SELECT array_agg(DISTINCT s ORDER BY s) INTO new_scopes FROM regexp_split_to_table(coalesce(NEW."tokenScopes",''),'[[:space:],]+')s WHERE s<>'';
  changed:=ROW(NEW.id,NEW."calendarId",NEW.platform,NEW."platformAccountId",NEW.status,new_scopes)
    IS DISTINCT FROM ROW(OLD.id,OLD."calendarId",OLD.platform,OLD."platformAccountId",OLD.status,old_scopes);
 END IF;
 IF changed THEN
  INSERT INTO "PublishingAccountInvalidation"("bindingId",version,reason)
  SELECT "bindingId",version,'connection identity, status or grants changed' FROM "PublishingAccountVersion" WHERE "connectionId"=OLD.id ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER publishing_connection_invalidation_check AFTER UPDATE OR DELETE ON "SocialConnection" FOR EACH ROW EXECUTE FUNCTION publishing_connection_invalidation();
-- Time-based expiry cannot be locked. Check the bounded witness at COMMIT too.
CREATE CONSTRAINT TRIGGER publishing_eligibility_attempt_commit AFTER INSERT ON "PublishingExternalAttempt"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_eligibility_authorization_guard();
CREATE CONSTRAINT TRIGGER publishing_eligibility_retry_commit AFTER UPDATE ON "PublishingRetryGeneration"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.outcome='AUTHORIZED') EXECUTE FUNCTION publishing_eligibility_authorization_guard();

CREATE TABLE "PublishingPostEligibilityInvalidation" (
 "intentId" text NOT NULL,revision integer NOT NULL,reason text NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY("intentId",revision),
 FOREIGN KEY("intentId",revision) REFERENCES "PublishingRevisionPolicy"("intentId",revision) ON DELETE RESTRICT
);
CREATE TRIGGER publishing_post_policy_invalidation_immutable BEFORE UPDATE OR DELETE ON "PublishingPostEligibilityInvalidation" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_post_policy_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD."approvalStatus"='APPROVED' AND NEW."approvalStatus"<>'APPROVED') OR NEW."isAiDraft"
 OR (NEW.platform,NEW."calendarId") IS DISTINCT FROM (OLD.platform,OLD."calendarId") THEN
  INSERT INTO "PublishingPostEligibilityInvalidation"("intentId",revision,reason)
  SELECT p."intentId",p.revision,'approval withdrawn, draft or post identity changed'
  FROM "PublishingRevisionPolicy" p JOIN "PublishingIntent" i ON i.id=p."intentId" WHERE i."postId"=OLD.id ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER publishing_post_policy_invalidation_check AFTER UPDATE ON "CalendarPost" FOR EACH ROW EXECUTE FUNCTION publishing_post_policy_invalidation();
