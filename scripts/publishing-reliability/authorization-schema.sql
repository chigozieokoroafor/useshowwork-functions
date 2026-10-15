-- Stage 4C.3 additive LOCAL proposal only, after the five prior proposals.
-- No production migration/installer. Capabilities do not attest that HTTP was sent.
CREATE TABLE "PublishingSendCapability" (
 id text PRIMARY KEY,"jobId" text NOT NULL UNIQUE REFERENCES "PublishingCanonicalExecution"("jobId") ON DELETE RESTRICT,
 "intentId" text NOT NULL,revision integer NOT NULL,generation integer NOT NULL CHECK(generation>0),
 platform "SocialPlatform" NOT NULL,"accountBindingId" text NOT NULL,"accountVersion" integer NOT NULL,
 "providerAccountId" text NOT NULL,"connectionId" text NOT NULL,"contentHash" text NOT NULL,
 owner text NOT NULL CHECK(owner IN ('NETLIFY','VPS')),epoch bigint NOT NULL CHECK(epoch>0),actor text NOT NULL,"workerToken" text NOT NULL,
 "rootAttemptId" text UNIQUE REFERENCES "PublishingExternalAttempt"(id) ON DELETE RESTRICT,
 "retryGenerationId" text UNIQUE REFERENCES "PublishingRetryGeneration"(id) ON DELETE RESTRICT,
 "tokenHash" text NOT NULL CHECK("tokenHash"~'^[0-9a-f]{64}$'),
 "expiresAt" timestamptz NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'ISSUED' CHECK(state IN ('ISSUED','CONSUMED','REVOKED')),
 "consumedAt" timestamptz,"consumedFenceVersion" bigint,"consumedValidUntil" timestamptz,
 CHECK(("rootAttemptId" IS NOT NULL)::int+("retryGenerationId" IS NOT NULL)::int=1),
 CHECK((state='CONSUMED')=("consumedAt" IS NOT NULL AND "consumedFenceVersion" IS NOT NULL AND "consumedValidUntil" IS NOT NULL)),
 FOREIGN KEY("intentId",revision,generation) REFERENCES "PublishingCanonicalExecution"("intentId",revision,generation) ON DELETE RESTRICT
);
CREATE TABLE "PublishingAuthorizationOperation" (
 "operationId" text PRIMARY KEY,"authorizationId" text NOT NULL UNIQUE REFERENCES "PublishingSendCapability"(id) ON DELETE RESTRICT,
 actor text NOT NULL,"requestHash" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "PublishingCapabilityEvent" (
 "operationId" text PRIMARY KEY,"authorizationId" text NOT NULL REFERENCES "PublishingSendCapability"(id) ON DELETE RESTRICT,
 transition text NOT NULL CHECK(transition IN ('CONSUMED','REVOKED')),actor text NOT NULL,"requestHash" text NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "PublishingAuthorizationOutcome" (
 "operationId" text PRIMARY KEY,"authorizationId" text NOT NULL REFERENCES "PublishingSendCapability"(id) ON DELETE RESTRICT,
 actor text NOT NULL,outcome text NOT NULL CHECK(outcome IN ('ACCEPTED','CONFIRMED','REJECTED','UNKNOWN')),
 "remoteReference" text,"requestHash" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER publishing_capability_preserved BEFORE DELETE ON "PublishingSendCapability" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_auth_operation_immutable BEFORE UPDATE OR DELETE ON "PublishingAuthorizationOperation" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_cap_event_immutable BEFORE UPDATE OR DELETE ON "PublishingCapabilityEvent" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_auth_outcome_immutable BEFORE UPDATE OR DELETE ON "PublishingAuthorizationOutcome" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_send_capability_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "PublishingExternalAttempt"%ROWTYPE;g "PublishingRetryGeneration"%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CAPABILITY_ISOLATION_REQUIRED'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM "PublishingEligibilityWitness" WHERE "jobId"=NEW."jobId" AND xmin=pg_current_xact_id()::xid AND "validUntil">=NEW."expiresAt") THEN RAISE EXCEPTION 'CAPABILITY_WITNESS_REQUIRED'; END IF;
  IF NEW.state<>'ISSUED' OR NEW."consumedAt" IS NOT NULL OR NEW."consumedFenceVersion" IS NOT NULL OR NEW."consumedValidUntil" IS NOT NULL OR NEW."expiresAt"<=clock_timestamp() THEN RAISE EXCEPTION 'CAPABILITY_INITIAL_INVALID'; END IF;
  IF NOT EXISTS(SELECT 1 FROM "PublishingCanonicalRevision" r JOIN "PublishingCanonicalExecution" e ON e."jobId"=r."jobId"
   JOIN "PublishingJob" j ON j.id=r."jobId" JOIN "PublishingIntent" i ON i.id=r."intentId"
   JOIN "PublishingAccountVersion" v ON v."bindingId"=r."accountBindingId" AND v.version=r."accountVersion"
   WHERE j.id=NEW."jobId" AND j.phase='EXTERNAL_PENDING' AND j."workerToken"=NEW."workerToken" AND e."intentId"=NEW."intentId" AND e.revision=NEW.revision AND e.generation=NEW.generation
   AND i.platform=NEW.platform AND r."accountBindingId"=NEW."accountBindingId" AND r."accountVersion"=NEW."accountVersion"
   AND r."contentHash"=NEW."contentHash" AND v."connectionId"=NEW."connectionId" AND v."providerAccountId"=NEW."providerAccountId")
  THEN RAISE EXCEPTION 'CAPABILITY_IDENTITY_INVALID'; END IF;
  IF NEW."rootAttemptId" IS NOT NULL THEN
   SELECT * INTO a FROM "PublishingExternalAttempt" WHERE id=NEW."rootAttemptId";
   IF NEW.generation<>1 OR a."jobId" IS DISTINCT FROM NEW."jobId" OR a.owner IS DISTINCT FROM NEW.owner OR a.epoch IS DISTINCT FROM NEW.epoch OR a.actor IS DISTINCT FROM NEW.actor OR a.outcome IS DISTINCT FROM 'AUTHORIZED' OR NOT EXISTS(SELECT 1 FROM "PublishingExternalAttempt" WHERE id=a.id AND xmin=pg_current_xact_id()::xid)
   THEN RAISE EXCEPTION 'CAPABILITY_ATTEMPT_INVALID'; END IF;
  ELSE
   SELECT * INTO g FROM "PublishingRetryGeneration" WHERE id=NEW."retryGenerationId";
   IF NEW.generation<>g.generation OR g."jobId" IS DISTINCT FROM NEW."jobId" OR g.owner IS DISTINCT FROM NEW.owner OR g.epoch IS DISTINCT FROM NEW.epoch OR g.outcome IS DISTINCT FROM 'AUTHORIZED' OR g."authorizationId" IS DISTINCT FROM NEW.id OR NOT EXISTS(SELECT 1 FROM "PublishingRetryGeneration" WHERE id=g.id AND xmin=pg_current_xact_id()::xid) OR NOT EXISTS(SELECT 1 FROM "PublishingRetryEvent" WHERE "generationId"=g.id AND outcome='AUTHORIZED' AND actor=NEW.actor AND xmin=pg_current_xact_id()::xid)
   THEN RAISE EXCEPTION 'CAPABILITY_RETRY_INVALID'; END IF;
  END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','consumedAt','consumedFenceVersion','consumedValidUntil']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','consumedAt','consumedFenceVersion','consumedValidUntil']) THEN RAISE EXCEPTION 'CAPABILITY_IDENTITY_IMMUTABLE'; END IF;
  IF OLD.state<>'ISSUED' OR NEW.state NOT IN ('CONSUMED','REVOKED') THEN RAISE EXCEPTION 'CAPABILITY_ALREADY_SPENT'; END IF;
  IF NEW.state='CONSUMED' THEN
   IF NEW."expiresAt"<=clock_timestamp() OR NEW."consumedAt" IS NULL OR NEW."consumedFenceVersion" IS NULL OR NEW."consumedValidUntil"<=clock_timestamp() THEN RAISE EXCEPTION 'CAPABILITY_EXPIRED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM "PublishingJob" j JOIN "PublishingIntent" i ON i.id=j."intentId" WHERE j.id=NEW."jobId" AND j.phase='EXTERNAL_PENDING' AND i.state='ACTIVE' AND i."currentRevision"=NEW.revision) THEN RAISE EXCEPTION 'CAPABILITY_JOB_FENCED'; END IF;
   PERFORM id FROM "PublishingOwnership" WHERE id=1 AND enabled AND state=NEW.owner AND epoch=NEW.epoch FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'CAPABILITY_OWNERSHIP_FENCED'; END IF;
   PERFORM id FROM "PublishingEligibilityFence" WHERE id=1 AND version=NEW."consumedFenceVersion" FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'CAPABILITY_POLICY_FENCED'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_capability_check BEFORE INSERT OR UPDATE ON "PublishingSendCapability" FOR EACH ROW EXECUTE FUNCTION publishing_send_capability_guard();
CREATE FUNCTION publishing_send_capability_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM "PublishingAuthorizationOperation" WHERE "authorizationId"=NEW.id AND actor=NEW.actor AND xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'CAPABILITY_AUTH_AUDIT_REQUIRED'; END IF;
 IF TG_OP='UPDATE' AND NOT EXISTS(SELECT 1 FROM "PublishingCapabilityEvent" WHERE "authorizationId"=NEW.id AND transition=NEW.state AND xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'CAPABILITY_EVENT_REQUIRED'; END IF;
 IF ((TG_OP='INSERT' OR NEW.state='CONSUMED') AND NEW."expiresAt"<=clock_timestamp()) OR (NEW.state='CONSUMED' AND NEW."consumedValidUntil"<=clock_timestamp()) THEN RAISE EXCEPTION 'CAPABILITY_EXPIRED_AT_COMMIT'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publishing_capability_commit AFTER INSERT OR UPDATE ON "PublishingSendCapability" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_send_capability_commit();
