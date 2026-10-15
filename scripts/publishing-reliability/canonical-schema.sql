-- Stage 4C.1 LOCAL proposal only. Apply after schema, ownership and intent-actions
-- proposals in a NEW disposable database. Never auto-installed; no Prisma migration.
CREATE TABLE "PublishingAccountBinding" (
 id text PRIMARY KEY,"calendarId" text NOT NULL,platform "SocialPlatform" NOT NULL,
 "currentVersion" integer NOT NULL CHECK("currentVersion">0),
 state text NOT NULL CHECK(state IN ('CONNECTED','DISCONNECTED')),UNIQUE("calendarId",platform)
);
CREATE TABLE "PublishingAccountVersion" (
 "bindingId" text NOT NULL REFERENCES "PublishingAccountBinding"(id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>0),"providerAccountId" text NOT NULL CHECK(length("providerAccountId")>0),
 "connectionId" text NOT NULL CHECK(length("connectionId")>0),"authorizationHash" text NOT NULL CHECK("authorizationHash"~'^[0-9a-f]{64}$'),
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY("bindingId",version)
);
ALTER TABLE "PublishingAccountBinding" ADD FOREIGN KEY(id,"currentVersion") REFERENCES "PublishingAccountVersion"("bindingId",version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE "PublishingAccountEvent" (
 "operationId" text PRIMARY KEY,"bindingId" text NOT NULL,version integer NOT NULL,
 state text NOT NULL CHECK(state IN ('CONNECTED','DISCONNECTED')),actor text NOT NULL,"requestHash" text NOT NULL,
 FOREIGN KEY("bindingId",version) REFERENCES "PublishingAccountVersion"("bindingId",version) ON DELETE RESTRICT
);
CREATE TABLE "PublishingCanonicalRevision" (
 "intentId" text NOT NULL,revision integer NOT NULL,"jobId" text NOT NULL UNIQUE REFERENCES "PublishingJob"(id) ON DELETE RESTRICT,
 "accountBindingId" text NOT NULL,"accountVersion" integer NOT NULL,"contentHash" text NOT NULL CHECK("contentHash"~'^[0-9a-f]{64}$'),
 "operationId" text NOT NULL REFERENCES "PublishingAction"("operationId") DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY("intentId",revision),
 FOREIGN KEY("intentId",revision) REFERENCES "PublishingIntentRevision"("intentId",revision) ON DELETE RESTRICT,
 FOREIGN KEY("accountBindingId","accountVersion") REFERENCES "PublishingAccountVersion"("bindingId",version) ON DELETE RESTRICT
);
CREATE TABLE "PublishingCanonicalExecution" (
 "jobId" text PRIMARY KEY REFERENCES "PublishingJob"(id) ON DELETE RESTRICT,
 "intentId" text NOT NULL,revision integer NOT NULL,generation integer NOT NULL CHECK(generation>0),
 "admittedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE("intentId",revision,generation),
 FOREIGN KEY("intentId",revision) REFERENCES "PublishingCanonicalRevision"("intentId",revision) ON DELETE RESTRICT
);
CREATE TABLE "PublishingCanonicalOperation" (
 "operationId" text PRIMARY KEY,"jobId" text NOT NULL REFERENCES "PublishingCanonicalExecution"("jobId") ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN ('admit','prepare')),actor text NOT NULL,"requestHash" text NOT NULL,result jsonb NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER publishing_account_version_immutable BEFORE UPDATE OR DELETE ON "PublishingAccountVersion" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_account_event_immutable BEFORE UPDATE OR DELETE ON "PublishingAccountEvent" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_canonical_revision_immutable BEFORE UPDATE OR DELETE ON "PublishingCanonicalRevision" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_canonical_execution_immutable BEFORE UPDATE OR DELETE ON "PublishingCanonicalExecution" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_canonical_operation_immutable BEFORE UPDATE OR DELETE ON "PublishingCanonicalOperation" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_account_preserved BEFORE DELETE ON "PublishingAccountBinding" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_account_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW."calendarId",NEW.platform) IS DISTINCT FROM ROW(OLD.id,OLD."calendarId",OLD.platform)
 OR NEW."currentVersion"<>OLD."currentVersion"+1 THEN RAISE EXCEPTION 'ACCOUNT_VERSION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_account_update BEFORE UPDATE ON "PublishingAccountBinding" FOR EACH ROW EXECUTE FUNCTION publishing_account_update_guard();
CREATE FUNCTION publishing_account_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR NOT EXISTS(SELECT 1 FROM "PublishingAccountEvent" WHERE "bindingId"=NEW.id AND version=NEW."currentVersion" AND state=NEW.state AND xmin=pg_current_xact_id()::xid)
 THEN RAISE EXCEPTION 'ACCOUNT_AUDIT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_account_commit AFTER INSERT OR UPDATE ON "PublishingAccountBinding" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_account_commit_guard();
CREATE FUNCTION publishing_canonical_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i "PublishingIntent"%ROWTYPE;a "PublishingAccountBinding"%ROWTYPE;
BEGIN
 SELECT * INTO a FROM "PublishingAccountBinding" WHERE id=NEW."accountBindingId" FOR SHARE;
 SELECT * INTO i FROM "PublishingIntent" WHERE id=NEW."intentId" FOR UPDATE;
 IF current_setting('transaction_isolation')<>'read committed' OR i.state IS DISTINCT FROM 'ACTIVE' OR i."currentRevision" IS DISTINCT FROM NEW.revision
 OR a.state IS DISTINCT FROM 'CONNECTED' OR a."currentVersion" IS DISTINCT FROM NEW."accountVersion" OR a.platform IS DISTINCT FROM i.platform
 OR NOT EXISTS(SELECT 1 FROM "PublishingJob" WHERE id=NEW."jobId" AND "intentId"=i.id AND "intentRevision"=NEW.revision AND "postId"=i."postId" AND platform=i.platform AND phase='READY')
 THEN RAISE EXCEPTION 'CANONICAL_REVISION_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_canonical_revision_check BEFORE INSERT ON "PublishingCanonicalRevision" FOR EACH ROW EXECUTE FUNCTION publishing_canonical_revision_guard();
CREATE FUNCTION publishing_canonical_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i "PublishingIntent"%ROWTYPE; expected_generation integer;
BEGIN
 SELECT * INTO i FROM "PublishingIntent" WHERE id=NEW."intentId" FOR UPDATE;
 SELECT COALESCE((SELECT generation FROM "PublishingRetryGeneration" WHERE "jobId"=NEW."jobId"),1) INTO expected_generation;
 IF current_setting('transaction_isolation')<>'read committed' OR i.state IS DISTINCT FROM 'ACTIVE' OR i."currentRevision" IS DISTINCT FROM NEW.revision OR NEW.generation<>expected_generation
 OR EXISTS(SELECT 1 FROM "PublishingRevisionInvalidation" WHERE "intentId"=NEW."intentId" AND revision=NEW.revision)
 OR NOT EXISTS(SELECT 1 FROM "PublishingCanonicalRevision" r JOIN "PublishingJob" j ON j.id=r."jobId" WHERE r."jobId"=NEW."jobId" AND r."intentId"=NEW."intentId" AND r.revision=NEW.revision AND j.phase='READY')
 THEN RAISE EXCEPTION 'CANONICAL_EXECUTION_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_canonical_execution_check BEFORE INSERT ON "PublishingCanonicalExecution" FOR EACH ROW EXECUTE FUNCTION publishing_canonical_execution_guard();

-- Both initial and retry authorization must lock/check the bound destination.
CREATE FUNCTION publishing_canonical_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE jid text; a "PublishingAccountBinding"%ROWTYPE; r "PublishingCanonicalRevision"%ROWTYPE;
BEGIN
 jid:=NEW."jobId";
 SELECT * INTO r FROM "PublishingCanonicalRevision" WHERE "jobId"=jid;
 IF r."jobId" IS NULL THEN RETURN NEW; END IF;
 PERFORM id FROM "PublishingOwnership" WHERE id=1 FOR SHARE;
 SELECT * INTO a FROM "PublishingAccountBinding" WHERE id=r."accountBindingId" FOR SHARE;
 IF a.state<>'CONNECTED' OR a."currentVersion"<>r."accountVersion" OR NOT EXISTS(SELECT 1 FROM "PublishingCanonicalExecution" WHERE "jobId"=jid)
 OR NOT EXISTS(SELECT 1 FROM "PublishingJob" j JOIN "PublishingAccountVersion" v ON v."bindingId"=r."accountBindingId" AND v.version=r."accountVersion"
   WHERE j.id=jid AND j.phase='PREPARED' AND j."workerToken" IS NOT NULL AND j."workerUntil">clock_timestamp() AND j."accountId"=v."providerAccountId")
 THEN RAISE EXCEPTION 'CANONICAL_ACCOUNT_FENCED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_00canonical_attempt BEFORE INSERT ON "PublishingExternalAttempt" FOR EACH ROW EXECUTE FUNCTION publishing_canonical_authorization_guard();
CREATE TRIGGER publishing_00canonical_retry BEFORE UPDATE ON "PublishingRetryGeneration" FOR EACH ROW WHEN(NEW.outcome='AUTHORIZED') EXECUTE FUNCTION publishing_canonical_authorization_guard();

CREATE FUNCTION publishing_canonical_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_phase text; bound "PublishingCanonicalRevision"%ROWTYPE; account "PublishingAccountBinding"%ROWTYPE; owner "PublishingOwnership"%ROWTYPE;
BEGIN
 SELECT * INTO bound FROM "PublishingCanonicalRevision" WHERE "jobId"=NEW.id;
 IF bound."jobId" IS NULL THEN RETURN NEW; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CANONICAL_ISOLATION_REQUIRED'; END IF;
 old_phase:=OLD.phase;
 IF NEW.phase IN ('READY','PREPARED') AND (NEW."remoteId" IS NOT NULL OR NEW.confirmation IS NOT NULL) THEN RAISE EXCEPTION 'CANONICAL_UNSENT_EVIDENCE_CONFLICT'; END IF;
 IF NEW.phase IS DISTINCT FROM old_phase AND NOT (
  old_phase='READY' AND NEW.phase IN ('PREPARED','CANCELLED') OR
  old_phase='PREPARED' AND NEW.phase IN ('EXTERNAL_PENDING','CANCELLED') OR
  old_phase='EXTERNAL_PENDING' AND NEW.phase IN ('PROVIDER_PENDING','CONFIRMED','REJECTED','OUTCOME_UNKNOWN') OR
  old_phase='PROVIDER_PENDING' AND NEW.phase IN ('CONFIRMED','REJECTED','OUTCOME_UNKNOWN') OR
  old_phase='OUTCOME_UNKNOWN' AND NEW.phase IN ('PROVIDER_PENDING','CONFIRMED','REJECTED'))
 THEN RAISE EXCEPTION 'CANONICAL_JOB_TRANSITION_INVALID'; END IF;
 IF NEW.phase='PREPARED' THEN
  SELECT * INTO owner FROM "PublishingOwnership" WHERE id=1 FOR SHARE;
  SELECT * INTO account FROM "PublishingAccountBinding" WHERE id=bound."accountBindingId" FOR SHARE;
  IF NOT owner.enabled OR owner.state='DRAINING' OR owner.epoch IS DISTINCT FROM NEW."ownershipEpoch"
    OR account.state<>'CONNECTED' OR account."currentVersion"<>bound."accountVersion"
    OR NEW."workerUntil" IS NULL OR NEW."workerUntil"<=clock_timestamp()
    OR NEW."accountId" IS DISTINCT FROM (SELECT "providerAccountId" FROM "PublishingAccountVersion" WHERE "bindingId"=bound."accountBindingId" AND version=bound."accountVersion")
  THEN RAISE EXCEPTION 'CANONICAL_PREPARATION_FENCED'; END IF;
 END IF;
 IF old_phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','CONFIRMED','REJECTED','OUTCOME_UNKNOWN','CANCELLED')
  AND ROW(NEW."workerToken",NEW."ownershipEpoch",NEW."accountId") IS DISTINCT FROM ROW(OLD."workerToken",OLD."ownershipEpoch",OLD."accountId")
 THEN RAISE EXCEPTION 'CANONICAL_EXECUTOR_IMMUTABLE'; END IF;
 IF NEW.phase='PREPARED' AND (NEW."workerToken" IS NULL OR NEW."ownershipEpoch" IS NULL OR NOT EXISTS(SELECT 1 FROM "PublishingCanonicalExecution" WHERE "jobId"=NEW.id))
 THEN RAISE EXCEPTION 'CANONICAL_PREPARATION_INVALID'; END IF;
 IF NEW."accountId" IS DISTINCT FROM OLD."accountId" AND NEW."accountId" IS DISTINCT FROM (SELECT "providerAccountId" FROM "PublishingAccountVersion" WHERE "bindingId"=bound."accountBindingId" AND version=bound."accountVersion")
 THEN RAISE EXCEPTION 'CANONICAL_DESTINATION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_canonical_job_check BEFORE UPDATE ON "PublishingJob" FOR EACH ROW EXECUTE FUNCTION publishing_canonical_job_guard();
CREATE FUNCTION publishing_canonical_job_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_outcome text; actual_reference text; expected_phase text; final_phase text; final_reference text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingCanonicalRevision" WHERE "jobId"=NEW.id) THEN RETURN NULL; END IF;
 SELECT outcome,"remoteReference" INTO actual_outcome,actual_reference FROM "PublishingExternalAttempt" WHERE "jobId"=NEW.id;
 IF actual_outcome IS NULL THEN SELECT outcome,"remoteReference" INTO actual_outcome,actual_reference FROM "PublishingRetryGeneration" WHERE "jobId"=NEW.id; END IF;
 expected_phase:=CASE actual_outcome WHEN 'AUTHORIZED' THEN 'EXTERNAL_PENDING' WHEN 'ACCEPTED' THEN 'PROVIDER_PENDING' WHEN 'UNKNOWN' THEN 'OUTCOME_UNKNOWN' WHEN 'CONFIRMED' THEN 'CONFIRMED' WHEN 'REJECTED' THEN 'REJECTED' WHEN 'CANCELLED' THEN 'CANCELLED' END;
 -- READY retry records legitimately accompany both READY and PREPARED jobs.
 SELECT phase,"remoteId" INTO final_phase,final_reference FROM "PublishingJob" WHERE id=NEW.id;
 IF (actual_outcome IS NOT NULL AND actual_outcome<>'READY' AND actual_reference IS DISTINCT FROM final_reference) THEN RAISE EXCEPTION 'CANONICAL_REFERENCE_MISMATCH'; END IF;
 IF (expected_phase IS NOT NULL AND final_phase<>expected_phase) OR (expected_phase IS NULL AND final_phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','CONFIRMED','REJECTED','OUTCOME_UNKNOWN'))
 THEN RAISE EXCEPTION 'CANONICAL_ATTEMPT_JOB_MISMATCH'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_canonical_job_commit_check AFTER UPDATE ON "PublishingJob" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_canonical_job_commit();
-- Outcome-only writes must also validate the final canonical job, not just job UPDATEs.
CREATE FUNCTION publishing_canonical_outcome_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text; ref text; expected text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingCanonicalRevision" WHERE "jobId"=NEW."jobId") THEN RETURN NULL; END IF;
 SELECT phase,"remoteId" INTO p,ref FROM "PublishingJob" WHERE id=NEW."jobId";
 expected:=CASE NEW.outcome WHEN 'AUTHORIZED' THEN 'EXTERNAL_PENDING' WHEN 'ACCEPTED' THEN 'PROVIDER_PENDING' WHEN 'UNKNOWN' THEN 'OUTCOME_UNKNOWN' WHEN 'CONFIRMED' THEN 'CONFIRMED' WHEN 'REJECTED' THEN 'REJECTED' WHEN 'CANCELLED' THEN 'CANCELLED' END;
 IF expected IS NOT NULL AND NEW."remoteReference" IS DISTINCT FROM ref THEN RAISE EXCEPTION 'CANONICAL_REFERENCE_MISMATCH'; END IF;
 IF expected IS NOT NULL AND p<>expected THEN RAISE EXCEPTION 'CANONICAL_OUTCOME_JOB_MISMATCH'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_canonical_attempt_commit AFTER INSERT OR UPDATE ON "PublishingExternalAttempt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_canonical_outcome_commit();
CREATE CONSTRAINT TRIGGER publishing_canonical_retry_commit AFTER INSERT OR UPDATE ON "PublishingRetryGeneration" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_canonical_outcome_commit();

CREATE FUNCTION publishing_canonical_execution_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingCanonicalOperation" WHERE "jobId"=NEW."jobId" AND action='admit'
 AND xmin=pg_current_xact_id()::xid AND result->'identity'->>'intentId'=NEW."intentId"
 AND (result->'identity'->>'revision')::integer=NEW.revision AND (result->'identity'->>'generation')::integer=NEW.generation)
 THEN RAISE EXCEPTION 'CANONICAL_ADMISSION_AUDIT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_canonical_execution_audit AFTER INSERT ON "PublishingCanonicalExecution"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_canonical_execution_commit();
CREATE FUNCTION publishing_canonical_preparation_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "PublishingCanonicalRevision" WHERE "jobId"=NEW.id) AND NEW.phase='PREPARED' AND
 (OLD.phase IS DISTINCT FROM NEW.phase OR OLD."workerToken" IS DISTINCT FROM NEW."workerToken") AND
 NOT EXISTS(SELECT 1 FROM "PublishingCanonicalOperation" WHERE "jobId"=NEW.id AND action='prepare'
 AND xmin=pg_current_xact_id()::xid AND result->>'workerToken'=NEW."workerToken")
 THEN RAISE EXCEPTION 'CANONICAL_PREPARATION_AUDIT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_canonical_preparation_audit AFTER UPDATE ON "PublishingJob"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_canonical_preparation_commit();
CREATE FUNCTION publishing_canonical_revision_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingAction" WHERE "operationId"=NEW."operationId" AND "intentId"=NEW."intentId"
 AND result->>'jobId'=NEW."jobId" AND (result->>'revision')::integer=NEW.revision AND xmin=pg_current_xact_id()::xid)
 THEN RAISE EXCEPTION 'CANONICAL_BINDING_AUDIT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_canonical_revision_audit AFTER INSERT ON "PublishingCanonicalRevision"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_canonical_revision_commit();

ALTER TABLE "PublishingCanonicalOperation" ADD CONSTRAINT publishing_canonical_no_send_receipt
 CHECK((result->>'maySend') IS NOT DISTINCT FROM 'false');
