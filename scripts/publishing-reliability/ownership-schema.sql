-- Stage 3A proposal ONLY. Apply after schema.sql in a NEW disposable database.
-- Not a Prisma migration. No existing application entry point reads these tables.
CREATE TABLE "PublishingOwnership" (
 id integer PRIMARY KEY CHECK(id=1), state text NOT NULL CHECK(state IN ('NETLIFY','DRAINING','VPS')),
 epoch bigint NOT NULL CHECK(epoch>=0), enabled boolean NOT NULL DEFAULT false
);
INSERT INTO "PublishingOwnership" VALUES(1,'DRAINING',0,false);
CREATE TABLE "PublishingOwnershipEvent" (
 "operationId" text PRIMARY KEY, "fromState" text NOT NULL, "toState" text NOT NULL,
 epoch bigint NOT NULL UNIQUE, actor text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "PublishingIntent" (
 id text PRIMARY KEY, "postId" text NOT NULL, platform "SocialPlatform" NOT NULL,
 "currentRevision" integer NOT NULL CHECK("currentRevision">0),
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','CANCELLED')),
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE("postId",platform)
);
CREATE TABLE "PublishingIntentRevision" (
 "intentId" text NOT NULL REFERENCES "PublishingIntent"(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0), "dueAt" timestamptz NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY("intentId",revision)
);
ALTER TABLE "PublishingIntent" ADD CONSTRAINT "PublishingIntent_current_revision_fk"
 FOREIGN KEY(id,"currentRevision") REFERENCES "PublishingIntentRevision"("intentId",revision)
 DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PublishingJob" ADD COLUMN "intentId" text,
 ADD COLUMN "intentRevision" integer, ADD COLUMN "ownershipEpoch" bigint;
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_intent_pair"
 CHECK (("intentId" IS NULL AND "intentRevision" IS NULL) OR ("intentId" IS NOT NULL AND "intentRevision" IS NOT NULL));
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_intent_fk"
 FOREIGN KEY("intentId","intentRevision") REFERENCES "PublishingIntentRevision"("intentId",revision) ON DELETE RESTRICT;
CREATE UNIQUE INDEX "PublishingJob_intent_revision_key" ON "PublishingJob"("intentId","intentRevision");
CREATE TABLE "PublishingExternalAttempt" (
 id text PRIMARY KEY, "intentId" text NOT NULL UNIQUE, revision integer NOT NULL,
 "jobId" text NOT NULL UNIQUE REFERENCES "PublishingJob"(id) ON DELETE RESTRICT,
 owner text NOT NULL CHECK(owner IN ('NETLIFY','VPS')), epoch bigint NOT NULL CHECK(epoch>0),
 actor text NOT NULL, outcome text NOT NULL DEFAULT 'AUTHORIZED'
 CHECK(outcome IN ('AUTHORIZED','ACCEPTED','CONFIRMED','REJECTED','UNKNOWN')),
 "remoteReference" text, "authorizedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY("intentId",revision) REFERENCES "PublishingIntentRevision"("intentId",revision) ON DELETE RESTRICT
);
CREATE TABLE "PublishingAttemptEvent" (
 "operationId" text PRIMARY KEY, "attemptId" text NOT NULL REFERENCES "PublishingExternalAttempt"(id) ON DELETE RESTRICT,
 outcome text NOT NULL CHECK(outcome IN ('ACCEPTED','CONFIRMED','REJECTED','UNKNOWN')),
 "remoteReference" text, actor text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "PublishingIntentRevision_due" ON "PublishingIntentRevision"("dueAt");
CREATE INDEX "PublishingExternalAttempt_unresolved" ON "PublishingExternalAttempt"(outcome);

CREATE FUNCTION publishing_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PUBLISHING_EVIDENCE_IMMUTABLE'; END $$;
CREATE TRIGGER publishing_revision_immutable BEFORE UPDATE OR DELETE ON "PublishingIntentRevision"
 FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_owner_event_immutable BEFORE UPDATE OR DELETE ON "PublishingOwnershipEvent"
 FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_attempt_event_immutable BEFORE UPDATE OR DELETE ON "PublishingAttemptEvent"
 FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_attempt_preserved BEFORE DELETE ON "PublishingExternalAttempt"
 FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_owner_preserved BEFORE DELETE ON "PublishingOwnership"
 FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_intent_preserved BEFORE DELETE ON "PublishingIntent"
 FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_owner_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.epoch <> OLD.epoch+1 OR NEW.id <> OLD.id THEN RAISE EXCEPTION 'PUBLISHING_EPOCH_INVALID'; END IF;
 IF NEW.state=OLD.state OR (NEW.state<>'DRAINING' AND OLD.state<>'DRAINING')
 OR NOT NEW.enabled THEN RAISE EXCEPTION 'PUBLISHING_TRANSITION_INVALID'; END IF;
 IF NOT OLD.enabled AND NEW.state<>'NETLIFY' THEN RAISE EXCEPTION 'PUBLISHING_ACTIVATION_INVALID'; END IF;
 IF NEW.state<>'DRAINING' AND EXISTS(SELECT 1 FROM "PublishingExternalAttempt" WHERE outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN'))
 THEN RAISE EXCEPTION 'PUBLISHING_UNRESOLVED_ATTEMPTS'; END IF;
 IF OLD.enabled AND NEW.state<>'DRAINING' AND EXISTS(SELECT 1 FROM "PublishingJob" WHERE "intentId" IS NULL AND phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN'))
 THEN RAISE EXCEPTION 'PUBLISHING_UNRESOLVED_LEGACY'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_owner_epoch BEFORE UPDATE ON "PublishingOwnership"
 FOR EACH ROW EXECUTE FUNCTION publishing_owner_epoch_guard();
CREATE FUNCTION publishing_attempt_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW."intentId",NEW.revision,NEW."jobId",NEW.owner,NEW.epoch,NEW.actor,NEW."authorizedAt")
 IS DISTINCT FROM ROW(OLD.id,OLD."intentId",OLD.revision,OLD."jobId",OLD.owner,OLD.epoch,OLD.actor,OLD."authorizedAt")
 OR (OLD."remoteReference" IS NOT NULL AND NEW."remoteReference" IS DISTINCT FROM OLD."remoteReference")
 THEN RAISE EXCEPTION 'PUBLISHING_ATTEMPT_IDENTITY_IMMUTABLE'; END IF;
 IF NEW.outcome='AUTHORIZED' OR OLD.outcome IN ('CONFIRMED','REJECTED')
 THEN RAISE EXCEPTION 'PUBLISHING_OUTCOME_TERMINAL'; END IF;
 IF NEW.outcome IN ('ACCEPTED','CONFIRMED') AND NEW."remoteReference" IS NULL
 THEN RAISE EXCEPTION 'PUBLISHING_REFERENCE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_attempt_identity BEFORE UPDATE ON "PublishingExternalAttempt"
 FOR EACH ROW EXECUTE FUNCTION publishing_attempt_identity_guard();
CREATE FUNCTION publishing_intent_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW."postId",NEW.platform,NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD."postId",OLD.platform,OLD."createdAt")
 OR NEW."currentRevision" NOT IN (OLD."currentRevision",OLD."currentRevision"+1)
 THEN RAISE EXCEPTION 'PUBLISHING_INTENT_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_intent_identity BEFORE UPDATE ON "PublishingIntent"
 FOR EACH ROW EXECUTE FUNCTION publishing_intent_identity_guard();

-- Stage 3B: raw INSERT must not bypass the same locking/eligibility boundary.
CREATE FUNCTION publishing_attempt_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE control "PublishingOwnership"%ROWTYPE; intent "PublishingIntent"%ROWTYPE;
BEGIN
 SELECT * INTO control FROM "PublishingOwnership" WHERE id=1 FOR SHARE;
 IF NOT control.enabled OR control.state<>NEW.owner OR control.epoch<>NEW.epoch
 THEN RAISE EXCEPTION 'PUBLISHING_OWNERSHIP_FENCED'; END IF;
 IF NEW.outcome<>'AUTHORIZED' OR NEW."remoteReference" IS NOT NULL
 THEN RAISE EXCEPTION 'PUBLISHING_INITIAL_OUTCOME_INVALID'; END IF;
 SELECT * INTO intent FROM "PublishingIntent" WHERE id=NEW."intentId" FOR UPDATE;
 IF intent.id IS NULL OR intent.state<>'ACTIVE' OR intent."currentRevision"<>NEW.revision
 THEN RAISE EXCEPTION 'PUBLISHING_INTENT_FENCED'; END IF;
 PERFORM j.id FROM "PublishingJob" j JOIN "PublishingIntentRevision" r
 ON r."intentId"=j."intentId" AND r.revision=j."intentRevision"
 WHERE j.id=NEW."jobId" AND j."intentId"=NEW."intentId" AND j."intentRevision"=NEW.revision
 AND j."ownershipEpoch"=NEW.epoch AND j."postId"=intent."postId" AND j.platform=intent.platform
 AND j.phase='PREPARED' AND r."dueAt"<=clock_timestamp() FOR UPDATE OF j;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISHING_JOB_FENCED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_attempt_authorization BEFORE INSERT ON "PublishingExternalAttempt"
 FOR EACH ROW EXECUTE FUNCTION publishing_attempt_authorization_guard();

-- Ownership state and its audit event must commit together, including raw SQL.
CREATE FUNCTION publishing_owner_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingOwnershipEvent" WHERE epoch=NEW.epoch
 AND "fromState"=OLD.state AND "toState"=NEW.state)
 THEN RAISE EXCEPTION 'PUBLISHING_OWNERSHIP_AUDIT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_owner_audit AFTER UPDATE ON "PublishingOwnership"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_owner_audit_guard();

CREATE FUNCTION publishing_attempt_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM "PublishingJob" WHERE id=NEW."jobId" AND phase='EXTERNAL_PENDING')
 THEN RAISE EXCEPTION 'PUBLISHING_JOB_BOUNDARY_REQUIRED'; END IF;
 IF TG_OP='UPDATE' AND NOT EXISTS(SELECT 1 FROM "PublishingAttemptEvent" e
 WHERE e."attemptId"=NEW.id AND e.outcome=NEW.outcome
 AND (e."remoteReference" IS NULL OR e."remoteReference"=NEW."remoteReference")
 AND e.xmin=pg_current_xact_id()::xid)
 THEN RAISE EXCEPTION 'PUBLISHING_OUTCOME_AUDIT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_attempt_commit AFTER INSERT OR UPDATE ON "PublishingExternalAttempt"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_attempt_commit_guard();
