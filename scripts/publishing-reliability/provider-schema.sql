-- Stage 4C.4 LOCAL proposal only, after authorization-schema.sql. No installer.
CREATE TABLE "PublishingProviderPreparation" (
 "jobId" text PRIMARY KEY REFERENCES "PublishingCanonicalExecution"("jobId") ON DELETE RESTRICT,
 "targetHash" text NOT NULL CHECK("targetHash" ~ '^[a-f0-9]{64}$'),"contentHash" text NOT NULL CHECK("contentHash" ~ '^[a-f0-9]{64}$'),artifact jsonb NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "PublishingProviderJournal" (
 id text PRIMARY KEY,"authorizationId" text NOT NULL REFERENCES "PublishingSendCapability"(id) ON DELETE RESTRICT,
 "jobId" text NOT NULL,platform "SocialPlatform" NOT NULL,
 kind text NOT NULL CHECK(kind IN ('SUBMISSION','RESPONSE','STATUS')),
 outcome text NOT NULL CHECK(outcome IN ('ACCEPTED','CONFIRMED','REJECTED','UNKNOWN')),
 reference text CHECK(reference IS NULL OR length(reference) BETWEEN 1 AND 500),"responseHash" text NOT NULL CHECK("responseHash" ~ '^[a-f0-9]{64}$'),
 operation text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- Additive local proposal: retain final publication IDs separately from an
 -- immutable provider operation reference (notably TikTok publish_id).
 "publicationReferences" text[],permalink text
);
CREATE TRIGGER publishing_preparation_immutable BEFORE UPDATE OR DELETE ON "PublishingProviderPreparation" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER publishing_provider_journal_immutable BEFORE UPDATE OR DELETE ON "PublishingProviderJournal" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_provider_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingSendCapability" WHERE id=NEW."authorizationId" AND "jobId"=NEW."jobId" AND platform=NEW.platform AND state='CONSUMED') THEN RAISE EXCEPTION 'PROVIDER_JOURNAL_CAPABILITY_REQUIRED'; END IF;
 IF NEW.outcome IN ('ACCEPTED','CONFIRMED') AND NEW.reference IS NULL THEN RAISE EXCEPTION 'PROVIDER_REFERENCE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_provider_journal_check BEFORE INSERT ON "PublishingProviderJournal" FOR EACH ROW EXECUTE FUNCTION publishing_provider_journal_guard();

CREATE FUNCTION publishing_provider_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingCanonicalRevision" WHERE "jobId"=NEW."jobId" AND "contentHash"=NEW."contentHash") THEN RAISE EXCEPTION 'PROVIDER_PREPARATION_CONTENT_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_provider_preparation_check BEFORE INSERT ON "PublishingProviderPreparation" FOR EACH ROW EXECUTE FUNCTION publishing_provider_preparation_guard();
