-- Stage 4A additive local proposal. Apply only after schema.sql and
-- ownership-schema.sql in a NEW disposable test database. No automatic installer.
CREATE TABLE "PublishingAction" (
 "operationId" text PRIMARY KEY, actor text NOT NULL, "requestHash" text NOT NULL,
 "intentId" text NOT NULL REFERENCES "PublishingIntent"(id) ON DELETE RESTRICT,
 action text NOT NULL, result jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "PublishingRevisionInvalidation" (
 "intentId" text NOT NULL, revision integer NOT NULL, "operationId" text NOT NULL,
 reason text NOT NULL CHECK(reason IN ('cancel','reschedule','edit','retry','schedule')),
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY("intentId",revision),
 FOREIGN KEY("intentId",revision) REFERENCES "PublishingIntentRevision"("intentId",revision) ON DELETE RESTRICT
);
CREATE TABLE "PublishingRetryEvidence" (
 id text PRIMARY KEY, "intentId" text NOT NULL REFERENCES "PublishingIntent"(id) ON DELETE RESTRICT,
 "rootAttemptId" text REFERENCES "PublishingExternalAttempt"(id) ON DELETE RESTRICT,
 "predecessorGenerationId" text,
 kind text NOT NULL CHECK(kind IN ('NOT_SENT','PROVIDER_REJECTED')),
 "actorStopped" boolean NOT NULL CHECK("actorStopped"), verified boolean NOT NULL CHECK(verified),
 retryable boolean NOT NULL CHECK(retryable), "evidenceReference" text NOT NULL CHECK(length("evidenceReference") BETWEEN 1 AND 200),
 "verifiedBy" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(("rootAttemptId" IS NOT NULL)::int+("predecessorGenerationId" IS NOT NULL)::int=1)
);
CREATE TABLE "PublishingRetryGeneration" (
 id text PRIMARY KEY, "intentId" text NOT NULL REFERENCES "PublishingIntent"(id) ON DELETE RESTRICT,
 revision integer NOT NULL, generation integer NOT NULL CHECK(generation>=2),
 "rootAttemptId" text UNIQUE REFERENCES "PublishingExternalAttempt"(id) ON DELETE RESTRICT,
 "predecessorGenerationId" text UNIQUE REFERENCES "PublishingRetryGeneration"(id) ON DELETE RESTRICT,
 "evidenceId" text NOT NULL UNIQUE REFERENCES "PublishingRetryEvidence"(id) ON DELETE RESTRICT,
 "jobId" text NOT NULL UNIQUE REFERENCES "PublishingJob"(id) ON DELETE RESTRICT,
 "operationId" text NOT NULL UNIQUE, "approvedBy" text NOT NULL,
 outcome text NOT NULL DEFAULT 'READY' CHECK(outcome IN ('READY','AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED','REJECTED','CANCELLED')),
 owner text CHECK(owner IN ('NETLIFY','VPS')), epoch bigint, "authorizationId" text UNIQUE, "remoteReference" text,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(("rootAttemptId" IS NOT NULL)::int+("predecessorGenerationId" IS NOT NULL)::int=1),
 UNIQUE("intentId",generation), UNIQUE("intentId",revision),
 FOREIGN KEY("intentId",revision) REFERENCES "PublishingIntentRevision"("intentId",revision) ON DELETE RESTRICT
);
ALTER TABLE "PublishingRetryEvidence" ADD FOREIGN KEY("predecessorGenerationId") REFERENCES "PublishingRetryGeneration"(id) ON DELETE RESTRICT;
CREATE TABLE "PublishingRetryEvent" (
 "operationId" text PRIMARY KEY, "generationId" text NOT NULL REFERENCES "PublishingRetryGeneration"(id) ON DELETE RESTRICT,
 outcome text NOT NULL CHECK(outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED','REJECTED','CANCELLED')),
 "remoteReference" text, actor text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER publishing_action_immutable BEFORE UPDATE OR DELETE ON "PublishingAction" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_invalidation_immutable BEFORE UPDATE OR DELETE ON "PublishingRevisionInvalidation" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_retry_evidence_immutable BEFORE UPDATE OR DELETE ON "PublishingRetryEvidence" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_retry_event_immutable BEFORE UPDATE OR DELETE ON "PublishingRetryEvent" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_retry_preserved BEFORE DELETE ON "PublishingRetryGeneration" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();

CREATE FUNCTION publishing_retry_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor_outcome text; predecessor_intent text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 PERFORM id FROM "PublishingIntent" WHERE id=NEW."intentId" FOR UPDATE;
 IF NEW."rootAttemptId" IS NOT NULL THEN
  SELECT outcome,"intentId" INTO predecessor_outcome,predecessor_intent FROM "PublishingExternalAttempt" WHERE id=NEW."rootAttemptId" FOR UPDATE;
 ELSE
  SELECT outcome,"intentId" INTO predecessor_outcome,predecessor_intent FROM "PublishingRetryGeneration" WHERE id=NEW."predecessorGenerationId" FOR UPDATE;
 END IF;
 IF predecessor_outcome IS DISTINCT FROM 'REJECTED' OR predecessor_intent IS DISTINCT FROM NEW."intentId"
 THEN RAISE EXCEPTION 'RETRY_EVIDENCE_NOT_ELIGIBLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_retry_evidence_check BEFORE INSERT ON "PublishingRetryEvidence" FOR EACH ROW EXECUTE FUNCTION publishing_retry_evidence_guard();

CREATE FUNCTION publishing_retry_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof "PublishingRetryEvidence"%ROWTYPE; predecessor_outcome text; previous_number integer; i "PublishingIntent"%ROWTYPE; control "PublishingOwnership"%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO i FROM "PublishingIntent" WHERE id=NEW."intentId" FOR UPDATE;
  SELECT * INTO proof FROM "PublishingRetryEvidence" WHERE id=NEW."evidenceId";
  IF proof.id IS NULL OR proof."intentId"<>NEW."intentId" OR proof."rootAttemptId" IS DISTINCT FROM NEW."rootAttemptId"
   OR proof."predecessorGenerationId" IS DISTINCT FROM NEW."predecessorGenerationId" OR NEW.outcome<>'READY'
   OR NEW.owner IS NOT NULL OR NEW.epoch IS NOT NULL OR NEW."authorizationId" IS NOT NULL OR NEW."remoteReference" IS NOT NULL
   OR i.state<>'ACTIVE' OR i."currentRevision"<>NEW.revision THEN RAISE EXCEPTION 'RETRY_GENERATION_INVALID'; END IF;
  IF NEW."rootAttemptId" IS NOT NULL THEN
   SELECT outcome,1 INTO predecessor_outcome,previous_number FROM "PublishingExternalAttempt" WHERE id=NEW."rootAttemptId" AND "intentId"=NEW."intentId" FOR UPDATE;
  ELSE
   SELECT outcome,generation INTO predecessor_outcome,previous_number FROM "PublishingRetryGeneration" WHERE id=NEW."predecessorGenerationId" AND "intentId"=NEW."intentId" FOR UPDATE;
  END IF;
  IF predecessor_outcome IS DISTINCT FROM 'REJECTED' OR NEW.generation IS DISTINCT FROM previous_number+1
  THEN RAISE EXCEPTION 'RETRY_PREDECESSOR_INVALID'; END IF;
  IF NOT EXISTS(SELECT 1 FROM "PublishingJob" WHERE id=NEW."jobId" AND "intentId"=NEW."intentId" AND "intentRevision"=NEW.revision AND phase='READY')
  THEN RAISE EXCEPTION 'RETRY_JOB_INVALID'; END IF;
 ELSE
  IF ROW(NEW.id,NEW."intentId",NEW.revision,NEW.generation,NEW."rootAttemptId",NEW."predecessorGenerationId",NEW."evidenceId",NEW."jobId",NEW."operationId",NEW."approvedBy",NEW."createdAt")
   IS DISTINCT FROM ROW(OLD.id,OLD."intentId",OLD.revision,OLD.generation,OLD."rootAttemptId",OLD."predecessorGenerationId",OLD."evidenceId",OLD."jobId",OLD."operationId",OLD."approvedBy",OLD."createdAt")
   OR (OLD."remoteReference" IS NOT NULL AND NEW."remoteReference" IS DISTINCT FROM OLD."remoteReference") THEN RAISE EXCEPTION 'RETRY_IDENTITY_IMMUTABLE'; END IF;
  IF OLD.outcome IN ('CONFIRMED','REJECTED','CANCELLED') THEN RAISE EXCEPTION 'RETRY_TERMINAL'; END IF;
  IF OLD.outcome='READY' THEN
   IF NEW.outcome NOT IN ('AUTHORIZED','CANCELLED') THEN RAISE EXCEPTION 'RETRY_TRANSITION_INVALID'; END IF;
   IF NEW.outcome='AUTHORIZED' THEN
    SELECT * INTO control FROM "PublishingOwnership" WHERE id=1 FOR SHARE;
    SELECT * INTO i FROM "PublishingIntent" WHERE id=NEW."intentId" FOR UPDATE;
    IF NOT control.enabled OR control.state IS DISTINCT FROM NEW.owner OR control.epoch IS DISTINCT FROM NEW.epoch
      OR NEW."authorizationId" IS NULL OR i.state<>'ACTIVE' OR i."currentRevision"<>NEW.revision
      OR EXISTS(SELECT 1 FROM "PublishingRevisionInvalidation" WHERE "intentId"=NEW."intentId" AND revision=NEW.revision)
    THEN RAISE EXCEPTION 'RETRY_AUTHORIZATION_FENCED'; END IF;
    PERFORM j.id FROM "PublishingJob" j JOIN "PublishingIntentRevision" r ON r."intentId"=j."intentId" AND r.revision=j."intentRevision"
     WHERE j.id=NEW."jobId" AND j.phase='PREPARED' AND j."ownershipEpoch"=NEW.epoch AND r."dueAt"<=clock_timestamp() FOR UPDATE OF j;
    IF NOT FOUND THEN RAISE EXCEPTION 'RETRY_JOB_FENCED'; END IF;
   ELSIF ROW(NEW.owner,NEW.epoch,NEW."authorizationId") IS DISTINCT FROM ROW(OLD.owner,OLD.epoch,OLD."authorizationId") THEN RAISE EXCEPTION 'RETRY_IDENTITY_IMMUTABLE'; END IF;
  ELSE
   IF NEW.outcome NOT IN ('ACCEPTED','UNKNOWN','CONFIRMED','REJECTED') OR ROW(NEW.owner,NEW.epoch,NEW."authorizationId") IS DISTINCT FROM ROW(OLD.owner,OLD.epoch,OLD."authorizationId") THEN RAISE EXCEPTION 'RETRY_TRANSITION_INVALID'; END IF;
  END IF;
  IF NEW.outcome IN ('ACCEPTED','CONFIRMED') AND NEW."remoteReference" IS NULL THEN RAISE EXCEPTION 'RETRY_REFERENCE_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_retry_generation_check BEFORE INSERT OR UPDATE ON "PublishingRetryGeneration" FOR EACH ROW EXECUTE FUNCTION publishing_retry_generation_guard();

CREATE FUNCTION publishing_retry_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM "PublishingAction" WHERE "operationId"=NEW."operationId" AND "intentId"=NEW."intentId" AND action='retry' AND actor=NEW."approvedBy"
  AND result->>'generationId'=NEW.id AND result->>'jobId'=NEW."jobId"
  AND xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'RETRY_ACTION_REQUIRED'; END IF;
 IF TG_OP='UPDATE' AND NOT EXISTS(SELECT 1 FROM "PublishingRetryEvent" e WHERE e."generationId"=NEW.id AND e.outcome=NEW.outcome AND (e."remoteReference" IS NULL OR e."remoteReference"=NEW."remoteReference") AND e.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'RETRY_AUDIT_REQUIRED'; END IF;
 IF NEW.outcome='AUTHORIZED' AND NOT EXISTS(SELECT 1 FROM "PublishingJob" WHERE id=NEW."jobId" AND phase='EXTERNAL_PENDING') THEN RAISE EXCEPTION 'RETRY_JOB_BOUNDARY_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_retry_commit AFTER INSERT OR UPDATE ON "PublishingRetryGeneration" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_retry_commit_guard();

-- Extra guards coexist with Stage 3B; no old uniqueness constraint is removed.
CREATE FUNCTION publishing_intent_busy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 IF (NEW.state,NEW."currentRevision") IS DISTINCT FROM (OLD.state,OLD."currentRevision") AND (
  EXISTS(SELECT 1 FROM "PublishingExternalAttempt" WHERE "intentId"=OLD.id AND outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED')) OR
  EXISTS(SELECT 1 FROM "PublishingRetryGeneration" WHERE "intentId"=OLD.id AND outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED')))
 THEN RAISE EXCEPTION 'INTENT_EXTERNAL_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_intent_busy BEFORE UPDATE ON "PublishingIntent" FOR EACH ROW EXECUTE FUNCTION publishing_intent_busy_guard();
CREATE FUNCTION publishing_job_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i "PublishingIntent"%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 IF NEW."intentId" IS NOT NULL AND NEW.phase IN ('READY','PREPARED') THEN
  SELECT * INTO i FROM "PublishingIntent" WHERE id=NEW."intentId" FOR UPDATE;
  IF i.id IS NULL OR i.state<>'ACTIVE' OR i."currentRevision"<>NEW."intentRevision" OR i."postId"<>NEW."postId" OR i.platform<>NEW.platform
   OR EXISTS(SELECT 1 FROM "PublishingRevisionInvalidation" WHERE "intentId"=NEW."intentId" AND revision=NEW."intentRevision")
  THEN RAISE EXCEPTION 'JOB_INTENT_FENCED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_job_intent BEFORE INSERT OR UPDATE ON "PublishingJob" FOR EACH ROW EXECUTE FUNCTION publishing_job_intent_guard();
CREATE FUNCTION publishing_owner_retry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 IF NEW.state<>'DRAINING' AND EXISTS(SELECT 1 FROM "PublishingRetryGeneration" WHERE outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN')) THEN RAISE EXCEPTION 'UNRESOLVED_RETRY_GENERATION'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_owner_retry BEFORE UPDATE ON "PublishingOwnership" FOR EACH ROW EXECUTE FUNCTION publishing_owner_retry_guard();

-- Stage 4A hardening: enforce transaction-wide invalidation even for raw SQL.
CREATE FUNCTION publishing_action_invalidation_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 IF (NEW.state,NEW."currentRevision") IS DISTINCT FROM (OLD.state,OLD."currentRevision") THEN
  IF NOT EXISTS(SELECT 1 FROM "PublishingRevisionInvalidation" v JOIN "PublishingAction" a ON a."operationId"=v."operationId"
    WHERE v."intentId"=OLD.id AND v.revision=OLD."currentRevision")
   OR NOT EXISTS(SELECT 1 FROM "PublishingAction" a WHERE a.xmin=pg_current_xact_id()::xid AND
     (a."intentId"=OLD.id OR EXISTS(SELECT 1 FROM "PublishingRevisionInvalidation" v
       WHERE v."intentId"=OLD.id AND v.revision=OLD."currentRevision" AND v."operationId"=a."operationId")))
   OR EXISTS(SELECT 1 FROM "PublishingJob" WHERE "intentId"=OLD.id AND "intentRevision"=OLD."currentRevision" AND phase IN ('READY','PREPARED'))
  THEN RAISE EXCEPTION 'ACTION_INVALIDATION_REQUIRED'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_action_invalidation AFTER UPDATE ON "PublishingIntent"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_action_invalidation_commit();
CREATE FUNCTION publishing_invalidation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 PERFORM id FROM "PublishingIntent" WHERE id=NEW."intentId" FOR UPDATE;
 IF EXISTS(SELECT 1 FROM "PublishingExternalAttempt" WHERE "intentId"=NEW."intentId" AND outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED'))
 OR EXISTS(SELECT 1 FROM "PublishingRetryGeneration" WHERE "intentId"=NEW."intentId" AND outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED'))
 THEN RAISE EXCEPTION 'INVALIDATION_EXTERNAL_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_invalidation_check BEFORE INSERT ON "PublishingRevisionInvalidation"
 FOR EACH ROW EXECUTE FUNCTION publishing_invalidation_guard();
CREATE FUNCTION publishing_action_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 PERFORM id FROM "PublishingOwnership" WHERE id=1 FOR SHARE;
 PERFORM id FROM "PublishingIntent" WHERE id=NEW."intentId" FOR UPDATE;
 IF EXISTS(SELECT 1 FROM "PublishingRevisionInvalidation" WHERE "intentId"=NEW."intentId" AND revision=NEW.revision)
 THEN RAISE EXCEPTION 'ATTEMPT_REVISION_INVALIDATED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_action_attempt BEFORE INSERT ON "PublishingExternalAttempt"
 FOR EACH ROW EXECUTE FUNCTION publishing_action_attempt_guard();
CREATE FUNCTION publishing_action_job_preserve() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 IF OLD."intentId" IS NOT NULL THEN RAISE EXCEPTION 'PUBLISHING_ACTION_JOB_IMMUTABLE'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER publishing_action_job_preserved BEFORE DELETE ON "PublishingJob"
 FOR EACH ROW EXECUTE FUNCTION publishing_action_job_preserve();
CREATE FUNCTION publishing_retry_evidence_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 IF EXISTS(SELECT 1 FROM "PublishingExternalAttempt" WHERE id=NEW."rootAttemptId" AND "remoteReference" IS NOT NULL)
 OR EXISTS(SELECT 1 FROM "PublishingRetryGeneration" WHERE id=NEW."predecessorGenerationId" AND "remoteReference" IS NOT NULL)
 THEN RAISE EXCEPTION 'RETRY_PUBLICATION_REFERENCE_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_retry_reference BEFORE INSERT ON "PublishingRetryEvidence"
 FOR EACH ROW EXECUTE FUNCTION publishing_retry_evidence_reference_guard();
CREATE FUNCTION publishing_action_job_external_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'ACTION_REQUIRES_READ_COMMITTED'; END IF;
 IF NEW."intentId" IS NOT NULL AND NEW.phase IN ('CANCELLED','READY','PREPARED') AND (
  EXISTS(SELECT 1 FROM "PublishingExternalAttempt" WHERE "jobId"=OLD.id AND outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED')) OR
  EXISTS(SELECT 1 FROM "PublishingRetryGeneration" WHERE "jobId"=OLD.id AND outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED')))
 THEN RAISE EXCEPTION 'JOB_EXTERNAL_CONFLICT'; END IF;
 IF ROW(NEW.id,NEW."intentId",NEW."intentRevision",NEW."postId",NEW.platform,NEW."admissionId",NEW.lease)
 IS DISTINCT FROM ROW(OLD.id,OLD."intentId",OLD."intentRevision",OLD."postId",OLD.platform,OLD."admissionId",OLD.lease)
 AND OLD."intentId" IS NOT NULL THEN RAISE EXCEPTION 'JOB_INTENT_IDENTITY_IMMUTABLE'; END IF;
 IF OLD."intentId" IS NOT NULL AND ((OLD."remoteId" IS NOT NULL AND NEW."remoteId" IS DISTINCT FROM OLD."remoteId")
  OR (OLD.confirmation IS NOT NULL AND NEW.confirmation IS DISTINCT FROM OLD.confirmation))
 THEN RAISE EXCEPTION 'JOB_PUBLICATION_EVIDENCE_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_action_job_external BEFORE UPDATE ON "PublishingJob"
 FOR EACH ROW EXECUTE FUNCTION publishing_action_job_external_guard();

-- Action records are inserted last; deferred FKs permit one atomic transaction.
ALTER TABLE "PublishingRevisionInvalidation" ADD CONSTRAINT publishing_invalidation_action_fk
 FOREIGN KEY("operationId") REFERENCES "PublishingAction"("operationId") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PublishingRetryGeneration" ADD CONSTRAINT publishing_retry_action_fk
 FOREIGN KEY("operationId") REFERENCES "PublishingAction"("operationId") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PublishingAction" ADD CONSTRAINT publishing_action_name CHECK(action IN ('schedule','cancel','reschedule','edit','retry'));
