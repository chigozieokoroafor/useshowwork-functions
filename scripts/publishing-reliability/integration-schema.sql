-- Stage 4C.6–4C.13 LOCAL proposal only. Load after all seven prior proposals.
CREATE TABLE "PublishingIntegrationControl"(id integer PRIMARY KEY CHECK(id=1),mode text NOT NULL CHECK(mode IN ('LEGACY','CANONICAL')));
INSERT INTO "PublishingIntegrationControl" VALUES(1,'LEGACY');
CREATE TABLE "PublishingIntegrationEvent"("operationId" text PRIMARY KEY,mode text NOT NULL,epoch bigint NOT NULL,actor text NOT NULL,"stopEvidenceId" text NOT NULL,"requestHash" text NOT NULL);
CREATE TABLE "PublishingSenderStopEvidence"(id text PRIMARY KEY,epoch bigint NOT NULL,scope text NOT NULL CHECK(scope='ALL_SENDERS'),"evidenceHash" text NOT NULL,"verifiedBy" text NOT NULL,"verifiedAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "PublishingLegacyDisposition"("postId" text PRIMARY KEY,platform "SocialPlatform" NOT NULL,classification text NOT NULL CHECK(classification IN ('ADOPTABLE','QUARANTINED','CONFIRMED','ADOPTED')),"snapshotHash" text NOT NULL,"remoteReference" text,"operationId" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "PublishingResourceTombstone"("resourceType" text NOT NULL,"resourceId" text NOT NULL,"evidenceHash" text NOT NULL,"retentionUntil" timestamptz NOT NULL,actor text NOT NULL,"operationId" text NOT NULL,PRIMARY KEY("resourceType","resourceId"));
CREATE TABLE "PublishingApplicationOperation"("operationId" text PRIMARY KEY,actor text NOT NULL,"requestHash" text NOT NULL,result jsonb NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE "PublishingMediaSnapshot"("jobId" text NOT NULL REFERENCES "PublishingCanonicalExecution"("jobId") ON DELETE RESTRICT,"assetId" text NOT NULL,"sourceKey" text NOT NULL,"objectVersion" text NOT NULL,"contentSha256" text NOT NULL CHECK("contentSha256"~'^[a-f0-9]{64}$'),"blobKey" text NOT NULL,PRIMARY KEY("jobId","assetId"));
CREATE TABLE "PublishingProviderCallback"(platform "SocialPlatform" NOT NULL,"eventId" text NOT NULL,"payloadHash" text NOT NULL,"authorizationId" text,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(platform,"eventId"));
CREATE TABLE "PublishingCoordinationLease"(key text PRIMARY KEY,token text NOT NULL,"leaseUntil" timestamptz NOT NULL);
CREATE TABLE "PublishingRateBucket"(key text NOT NULL,"bucketWindow" bigint NOT NULL,used integer NOT NULL CHECK(used>0),PRIMARY KEY(key,"bucketWindow"));
ALTER TABLE "CalendarPostAsset" ADD COLUMN IF NOT EXISTS "objectVersion" text;
ALTER TABLE "CalendarPostAsset" ADD COLUMN IF NOT EXISTS "contentSha256" text;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['PublishingIntegrationEvent','PublishingSenderStopEvidence','PublishingLegacyDisposition','PublishingResourceTombstone','PublishingApplicationOperation','PublishingMediaSnapshot','PublishingProviderCallback'] LOOP
 EXECUTE format('CREATE TRIGGER integration_evidence_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable()',t);
END LOOP; END $$;
CREATE FUNCTION publishing_integration_mode_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR NOT EXISTS(SELECT 1 FROM "PublishingIntegrationEvent" e JOIN "PublishingSenderStopEvidence" s ON s.id=e."stopEvidenceId" JOIN "PublishingOwnership" o ON o.id=1 WHERE e.mode=NEW.mode AND e.epoch=o.epoch AND s.epoch=o.epoch AND o.state='DRAINING' AND e.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'INTEGRATION_FENCE_AUDIT_REQUIRED'; END IF;
 RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER integration_mode_audit AFTER UPDATE ON "PublishingIntegrationControl" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_integration_mode_audit();
CREATE TABLE "PublishingPostOrigin"("postId" text PRIMARY KEY,protocol text NOT NULL CHECK(protocol='CANONICAL'),epoch bigint NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER publishing_post_origin_immutable BEFORE UPDATE OR DELETE ON "PublishingPostOrigin" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TABLE "PublishingLegacyAdoptionProof"("postId" text PRIMARY KEY,"actionOperationId" text NOT NULL REFERENCES "PublishingAction"("operationId") DEFERRABLE INITIALLY DEFERRED,"snapshotHash" text NOT NULL,"evidenceHash" text NOT NULL,"stopEpoch" bigint NOT NULL);
CREATE TRIGGER publishing_adoption_proof_immutable BEFORE UPDATE OR DELETE ON "PublishingLegacyAdoptionProof" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_post_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM "PublishingIntegrationControl" WHERE mode='CANONICAL') THEN INSERT INTO "PublishingPostOrigin"("postId",protocol,epoch) SELECT NEW.id,'CANONICAL',epoch FROM "PublishingOwnership" WHERE id=1; END IF; RETURN NEW; END $$;
CREATE TRIGGER publishing_post_origin_check AFTER INSERT ON "CalendarPost" FOR EACH ROW EXECUTE FUNCTION publishing_post_origin();
CREATE FUNCTION publishing_integration_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingIntegrationControl" WHERE id=1 AND mode='CANONICAL') THEN RAISE EXCEPTION 'CANONICAL_INTEGRATION_INACTIVE'; END IF;
 IF EXISTS(SELECT 1 FROM "PublishingLegacyDisposition" d JOIN "PublishingJob" j ON j."postId"=d."postId" WHERE j.id=NEW."jobId" AND d.classification IN ('QUARANTINED','CONFIRMED')) THEN RAISE EXCEPTION 'LEGACY_OUTCOME_REQUIRES_NEW_AUTHORIZED_POST'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "PublishingJob" j WHERE j.id=NEW."jobId" AND (EXISTS(SELECT 1 FROM "PublishingPostOrigin" o WHERE o."postId"=j."postId") OR EXISTS(SELECT 1 FROM "PublishingLegacyAdoptionProof" p WHERE p."postId"=j."postId"))) THEN RAISE EXCEPTION 'TRUSTED_LEGACY_ADOPTION_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "PublishingAccountLease" a JOIN "PublishingJob" j ON j.id=a."jobId" WHERE j.id=NEW."jobId" AND a.platform=j.platform AND a."accountId"=j."accountId" AND a.token=j."workerToken" AND a."leaseUntil">clock_timestamp()) THEN RAISE EXCEPTION 'CANONICAL_ACCOUNT_MUTEX_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM "PublishingJob" j JOIN "CalendarPostAsset" a ON a."postId"=j."postId" WHERE j.id=NEW."jobId" AND NOT EXISTS(SELECT 1 FROM "PublishingMediaSnapshot" s WHERE s."jobId"=j.id AND s."assetId"=a.id AND s."sourceKey"=a."fileKey" AND s."objectVersion"=a."objectVersion" AND s."contentSha256"=a."contentSha256")) THEN RAISE EXCEPTION 'IMMUTABLE_MEDIA_REQUIRED'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_000integration_attempt BEFORE INSERT ON "PublishingExternalAttempt" FOR EACH ROW EXECUTE FUNCTION publishing_integration_authorization_guard();
CREATE TRIGGER publishing_000integration_retry BEFORE UPDATE ON "PublishingRetryGeneration" FOR EACH ROW WHEN(NEW.outcome='AUTHORIZED') EXECUTE FUNCTION publishing_integration_authorization_guard();
CREATE FUNCTION publishing_retained_post_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM "PublishingIntent" WHERE "postId"=OLD.id) AND NOT EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"='POST' AND "resourceId"=OLD.id AND xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'PUBLISHING_TOMBSTONE_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM "PublishingJob" WHERE "postId"=OLD.id AND phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN')) THEN RAISE EXCEPTION 'UNRESOLVED_PUBLICATION_RETAINED'; END IF;
 RETURN OLD; END $$;
CREATE TRIGGER publishing_retained_post BEFORE DELETE ON "CalendarPost" FOR EACH ROW EXECUTE FUNCTION publishing_retained_post_guard();
CREATE FUNCTION publishing_retained_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM "PublishingMediaSnapshot" s JOIN "PublishingJob" j ON j.id=s."jobId" WHERE s."assetId"=OLD.id AND j.phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN')) THEN RAISE EXCEPTION 'PUBLISHING_MEDIA_RETAINED'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
CREATE TRIGGER publishing_retained_asset BEFORE UPDATE OR DELETE ON "CalendarPostAsset" FOR EACH ROW EXECUTE FUNCTION publishing_retained_asset_guard();
CREATE TABLE "PublishingLegacyResolution"("operationId" text PRIMARY KEY,"postId" text NOT NULL REFERENCES "PublishingLegacyDisposition"("postId") ON DELETE RESTRICT,outcome text NOT NULL CHECK(outcome IN ('CONFIRMED','REJECTED')),reference text,"evidenceHash" text NOT NULL,actor text NOT NULL);
CREATE TRIGGER publishing_legacy_resolution_immutable BEFORE UPDATE OR DELETE ON "PublishingLegacyResolution" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_legacy_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state<>'DRAINING' AND EXISTS(SELECT 1 FROM "PublishingIntegrationControl" WHERE mode='CANONICAL') AND NOT EXISTS(SELECT 1 FROM "PublishingSenderStopEvidence" WHERE epoch=OLD.epoch AND scope='ALL_SENDERS') THEN RAISE EXCEPTION 'CURRENT_SENDER_STOP_REQUIRED'; END IF;
 IF NEW.state<>'DRAINING' AND EXISTS(SELECT 1 FROM "PublishingLegacyDisposition" WHERE classification='QUARANTINED' AND NOT EXISTS(SELECT 1 FROM "PublishingLegacyResolution" r WHERE r."postId"="PublishingLegacyDisposition"."postId")) THEN RAISE EXCEPTION 'UNRESOLVED_LEGACY_QUARANTINE'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_legacy_transfer BEFORE UPDATE ON "PublishingOwnership" FOR EACH ROW EXECUTE FUNCTION publishing_legacy_transfer_guard();
CREATE TABLE "PublishingProviderInvocation"("authorizationId" text PRIMARY KEY REFERENCES "PublishingSendCapability"(id) ON DELETE RESTRICT,operation text NOT NULL,"requestHash" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER publishing_provider_invocation_immutable BEFORE UPDATE OR DELETE ON "PublishingProviderInvocation" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_provider_invocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingSendCapability" c JOIN "PublishingJob" j ON j.id=c."jobId" JOIN "PublishingOwnership" o ON o.id=1 JOIN "PublishingAccountBinding" b ON b.id=c."accountBindingId" JOIN "SocialConnection" s ON s.id=c."connectionId" JOIN "PublishingEligibilityFence" f ON f.id=1 WHERE c.id=NEW."authorizationId" AND c.state='CONSUMED' AND j.phase='EXTERNAL_PENDING' AND c."consumedValidUntil">clock_timestamp() AND o.enabled AND o.state=c.owner AND o.epoch=c.epoch AND b."currentVersion"=c."accountVersion" AND b.state='CONNECTED' AND s.status='CONNECTED' AND s."platformAccountId"=c."providerAccountId" AND f.version=c."consumedFenceVersion") THEN RAISE EXCEPTION 'PROVIDER_INVOCATION_FENCED'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_provider_invocation_check BEFORE INSERT ON "PublishingProviderInvocation" FOR EACH ROW EXECUTE FUNCTION publishing_provider_invocation_guard();
CREATE FUNCTION publishing_retired_resource_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"='POST' AND "resourceId"=NEW.id) THEN RAISE EXCEPTION 'POST_RETIRED'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_retired_resource BEFORE INSERT ON "CalendarPost" FOR EACH ROW EXECUTE FUNCTION publishing_retired_resource_guard();
CREATE FUNCTION publishing_parent_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource text; BEGIN
 resource:=CASE WHEN TG_TABLE_NAME='Creator' THEN 'CREATOR' ELSE 'WORKSPACE' END;
 IF EXISTS(SELECT 1 FROM "PublishingAccountBinding" b JOIN "SocialCalendar" c ON c.id=b."calendarId" WHERE (resource='WORKSPACE' AND c.id=OLD.id OR resource='CREATOR' AND c."managerId"=OLD.id)) AND NOT EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"=resource AND "resourceId"=OLD.id AND xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'PUBLISHING_PARENT_TOMBSTONE_REQUIRED'; END IF;
 RETURN OLD; END $$;
CREATE TRIGGER publishing_parent_retention BEFORE DELETE ON "SocialCalendar" FOR EACH ROW EXECUTE FUNCTION publishing_parent_delete_guard();
CREATE TRIGGER publishing_creator_retention BEFORE DELETE ON "Creator" FOR EACH ROW EXECUTE FUNCTION publishing_parent_delete_guard();
CREATE TABLE "PublishingRequestSpacing"(key text PRIMARY KEY,"nextAt" timestamptz NOT NULL);
CREATE TABLE "PublishingEligibilityHold"("intentId" text NOT NULL,revision integer NOT NULL,reason text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY("intentId",revision,reason),FOREIGN KEY("intentId",revision) REFERENCES "PublishingCanonicalRevision"("intentId",revision) ON DELETE RESTRICT);
CREATE TRIGGER publishing_eligibility_hold_immutable BEFORE UPDATE OR DELETE ON "PublishingEligibilityHold" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_reauthorization_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE principal text; reason text; BEGIN
 IF TG_TABLE_NAME='Creator' THEN
  IF ROW(OLD."isDeactivated",OLD."contentWorkspacePlan",OLD."contentWorkspaceBillingStatus",OLD."contentWorkspaceTrialEndsAt",OLD."isComped",OLD."compedUntil",OLD."workspaceCompedPlan",OLD."workspaceCompedUntil",OLD."billingComplimentaryGrants") IS NOT DISTINCT FROM ROW(NEW."isDeactivated",NEW."contentWorkspacePlan",NEW."contentWorkspaceBillingStatus",NEW."contentWorkspaceTrialEndsAt",NEW."isComped",NEW."compedUntil",NEW."workspaceCompedPlan",NEW."workspaceCompedUntil",NEW."billingComplimentaryGrants") THEN RETURN NEW; END IF;
  principal:=OLD.id;reason:='ENTITLEMENT_OR_ACCOUNT_REVIEW_REQUIRED';
 ELSE principal:=OLD."creatorId";reason:='PRINCIPAL_REVIEW_REQUIRED'; END IF;
 INSERT INTO "PublishingEligibilityHold"("intentId",revision,reason) SELECT p."intentId",p.revision,reason FROM "PublishingRevisionPolicy" p JOIN "PublishingCanonicalRevision" r ON r."intentId"=p."intentId" AND r.revision=p.revision JOIN "PublishingJob" j ON j.id=r."jobId" WHERE (p."principalId"=principal OR TG_TABLE_NAME='Creator' AND p."ownerId"=principal) AND j.phase IN ('READY','PREPARED','EXTERNAL_PENDING') ON CONFLICT DO NOTHING;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER publishing_entitlement_hold AFTER UPDATE ON "Creator" FOR EACH ROW EXECUTE FUNCTION publishing_reauthorization_hold();
CREATE TRIGGER publishing_principal_hold AFTER UPDATE OR DELETE ON "CalendarCollaborator" FOR EACH ROW EXECUTE FUNCTION publishing_reauthorization_hold();
-- Launch-critical LOCAL additive proposal: retired original keys cannot regain
-- references after the cleanup decision commits. Immutable publishing objects
-- and snapshots are retained; this is not a retention-policy purge mechanism.
CREATE FUNCTION publishing_retired_object_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM version FROM "PublishingEligibilityFence" WHERE id=1 FOR UPDATE;
 IF EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"='OBJECT' AND "resourceId"=NEW."fileKey") THEN RAISE EXCEPTION 'ORIGINAL_OBJECT_RETIRED'; END IF;
 RETURN NEW; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['CalendarPostAsset','Media','PortfolioMedia','TaskAsset','BriefAttachment','CalendarBusinessDocument','ContentWorkspaceStorageReservation'] LOOP
 IF to_regclass(format('%I',t)) IS NOT NULL THEN EXECUTE format('CREATE TRIGGER publishing_retired_object_reference BEFORE INSERT OR UPDATE OF "fileKey" ON %I FOR EACH ROW EXECUTE FUNCTION publishing_retired_object_reference()',t); END IF;
END LOOP; END $$;
CREATE FUNCTION publishing_retired_banner_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM version FROM "PublishingEligibilityFence" WHERE id=1 FOR UPDATE;
 IF EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"='OBJECT' AND "resourceId" IN (NEW."headerBannerDesktopUrl",NEW."headerBannerMobileUrl")) THEN RAISE EXCEPTION 'ORIGINAL_OBJECT_RETIRED'; END IF;
 RETURN NEW; END $$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='SocialCalendar' AND column_name='headerBannerDesktopUrl') THEN
 CREATE TRIGGER publishing_retired_banner_reference BEFORE INSERT OR UPDATE OF "headerBannerDesktopUrl","headerBannerMobileUrl" ON "SocialCalendar" FOR EACH ROW EXECUTE FUNCTION publishing_retired_banner_reference();
END IF; END $$;

CREATE FUNCTION publishing_retired_portfolio_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM version FROM "PublishingEligibilityFence" WHERE id=1 FOR UPDATE;
 IF EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"='OBJECT' AND "resourceId" IN (NEW."heroBannerDesktopUrl",NEW."heroBannerMobileUrl",NEW."logoUrl")) THEN RAISE EXCEPTION 'ORIGINAL_OBJECT_RETIRED'; END IF;
 RETURN NEW; END $$;
DO $$ BEGIN IF to_regclass('"Portfolio"') IS NOT NULL THEN
 CREATE TRIGGER publishing_retired_portfolio_reference BEFORE INSERT OR UPDATE OF "heroBannerDesktopUrl","heroBannerMobileUrl","logoUrl" ON "Portfolio" FOR EACH ROW EXECUTE FUNCTION publishing_retired_portfolio_reference();
END IF; END $$;

-- LOCAL proposal: an external subscription disable can outlive a rolled-back
-- application transaction. Keep this sanitized eligibility evidence separate
-- from private native response receipts; reconciliation never restores revisions.
CREATE TABLE "PublishingBillingRevocationHold"("ownerId" text NOT NULL,"operationId" text NOT NULL,"invocationId" text NOT NULL UNIQUE REFERENCES "PublishingApplicationOperation"("operationId"),"cancelledSubscriptionHash" text NOT NULL CHECK(length("cancelledSubscriptionHash")=64),"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY("ownerId","operationId"));
CREATE TABLE "PublishingBillingRevocationResolution"("ownerId" text NOT NULL,"holdOperationId" text NOT NULL,"operationId" text NOT NULL,reason text NOT NULL CHECK(reason IN ('LOCAL_REVOCATION_COMMITTED','TRUSTED_PAYMENT_VERIFIED')),"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY("ownerId","holdOperationId"),FOREIGN KEY("ownerId","holdOperationId") REFERENCES "PublishingBillingRevocationHold"("ownerId","operationId"));
CREATE TRIGGER billing_revocation_hold_immutable BEFORE UPDATE OR DELETE ON "PublishingBillingRevocationHold" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE TRIGGER billing_revocation_resolution_immutable BEFORE UPDATE OR DELETE ON "PublishingBillingRevocationResolution" FOR EACH ROW EXECUTE FUNCTION publishing_evidence_immutable();
CREATE FUNCTION publishing_billing_resolution_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PublishingApplicationOperation" WHERE "operationId"=NEW."operationId" AND xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'BILLING_RESOLUTION_COMMIT_RECEIPT_REQUIRED'; END IF;
 RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER billing_resolution_commit_audit AFTER INSERT ON "PublishingBillingRevocationResolution" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION publishing_billing_resolution_audit();
CREATE FUNCTION publishing_billing_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job text; BEGIN
 IF TG_TABLE_NAME='PublishingSendCapability' THEN
  IF TG_OP='UPDATE' AND NEW.state<>'CONSUMED' THEN RETURN NEW; END IF;
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'READ_COMMITTED_BILLING_FENCE_REQUIRED'; END IF;
 PERFORM version FROM "PublishingEligibilityFence" WHERE id=1 FOR SHARE;
 IF TG_TABLE_NAME='PublishingProviderInvocation' THEN SELECT "jobId" INTO job FROM "PublishingSendCapability" WHERE id=NEW."authorizationId"; ELSE job:=NEW."jobId"; END IF;
 IF EXISTS(SELECT 1 FROM "PublishingJob" j JOIN "PublishingRevisionPolicy" p ON p."intentId"=j."intentId" AND p.revision=j."intentRevision" JOIN "PublishingBillingRevocationHold" h ON h."ownerId"=p."ownerId" WHERE j.id=job AND NOT EXISTS(SELECT 1 FROM "PublishingBillingRevocationResolution" r WHERE r."ownerId"=h."ownerId" AND r."holdOperationId"=h."operationId")) THEN RAISE EXCEPTION 'BILLING_RECONCILIATION_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publishing_0000billing_attempt BEFORE INSERT ON "PublishingExternalAttempt" FOR EACH ROW EXECUTE FUNCTION publishing_billing_publication_guard();
CREATE TRIGGER publishing_0000billing_capability BEFORE INSERT OR UPDATE ON "PublishingSendCapability" FOR EACH ROW EXECUTE FUNCTION publishing_billing_publication_guard();
CREATE TRIGGER publishing_0000billing_invocation BEFORE INSERT ON "PublishingProviderInvocation" FOR EACH ROW EXECUTE FUNCTION publishing_billing_publication_guard();
-- Approved local migration policy: soft-retained resources have no invented
-- expiry. NULL means policy review required, never permission to purge.
ALTER TABLE "PublishingResourceTombstone" ALTER COLUMN "retentionUntil" DROP NOT NULL;
ALTER TABLE "PublishingResourceTombstone" ADD COLUMN reason text;
ALTER TABLE "PublishingResourceTombstone" ADD COLUMN dependency text;
ALTER TABLE "PublishingResourceTombstone" ADD COLUMN "policyReviewRequired" boolean NOT NULL DEFAULT true;
ALTER TABLE "PublishingResourceTombstone" ADD COLUMN "retainedAt" timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE FUNCTION publishing_retention_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE post_id text; calendar_id text; owner_id text; BEGIN
 PERFORM version FROM "PublishingEligibilityFence" WHERE id=1 FOR SHARE;
 IF TG_TABLE_NAME IN ('PublishingIntent','PublishingJob') THEN post_id:=NEW."postId";
 ELSE SELECT "postId" INTO post_id FROM "PublishingJob" WHERE id=NEW."jobId"; END IF;
 SELECT p."calendarId",c."managerId" INTO calendar_id,owner_id FROM "CalendarPost" p JOIN "SocialCalendar" c ON c.id=p."calendarId" WHERE p.id=post_id;
 IF EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE ("resourceType"='POST' AND "resourceId"=post_id) OR ("resourceType"='WORKSPACE' AND "resourceId"=calendar_id) OR ("resourceType"='CREATOR' AND "resourceId"=owner_id)) THEN RAISE EXCEPTION 'RETAINED_RESOURCE_NO_NEW_PUBLICATION'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_retention_intent BEFORE INSERT ON "PublishingIntent" FOR EACH ROW EXECUTE FUNCTION publishing_retention_admission_guard();
CREATE TRIGGER publishing_retention_attempt BEFORE INSERT ON "PublishingExternalAttempt" FOR EACH ROW EXECUTE FUNCTION publishing_retention_admission_guard();
CREATE TRIGGER publishing_retention_capability BEFORE INSERT ON "PublishingSendCapability" FOR EACH ROW EXECUTE FUNCTION publishing_retention_admission_guard();
CREATE FUNCTION publishing_retention_invocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_id text; BEGIN
 PERFORM version FROM "PublishingEligibilityFence" WHERE id=1 FOR SHARE;
 SELECT "jobId" INTO job_id FROM "PublishingSendCapability" WHERE id=NEW."authorizationId";
 IF EXISTS(SELECT 1 FROM "PublishingJob" j JOIN "CalendarPost" p ON p.id=j."postId" JOIN "SocialCalendar" c ON c.id=p."calendarId" JOIN "PublishingResourceTombstone" t ON (t."resourceType"='POST' AND t."resourceId"=p.id) OR (t."resourceType"='WORKSPACE' AND t."resourceId"=c.id) OR (t."resourceType"='CREATOR' AND t."resourceId"=c."managerId") WHERE j.id=job_id) THEN RAISE EXCEPTION 'RETAINED_RESOURCE_NO_NEW_PUBLICATION'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_retention_invocation BEFORE INSERT ON "PublishingProviderInvocation" FOR EACH ROW EXECUTE FUNCTION publishing_retention_invocation_guard();
CREATE FUNCTION publishing_retention_change_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE "PublishingEligibilityFence" SET version=version+1 WHERE id=1;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_retention_change BEFORE INSERT ON "PublishingResourceTombstone" FOR EACH ROW EXECUTE FUNCTION publishing_retention_change_fence();
CREATE TRIGGER publishing_retention_consumption BEFORE UPDATE ON "PublishingSendCapability" FOR EACH ROW WHEN(OLD.state='ISSUED' AND NEW.state='CONSUMED') EXECUTE FUNCTION publishing_retention_admission_guard();
CREATE FUNCTION publishing_soft_retained_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource text; resource_id text; BEGIN
 resource:=CASE TG_TABLE_NAME WHEN 'CalendarPost' THEN 'POST' WHEN 'CalendarPostAsset' THEN 'POST' WHEN 'SocialCalendar' THEN 'WORKSPACE' ELSE 'CREATOR' END;
 IF TG_TABLE_NAME='CalendarPostAsset' THEN resource_id:=OLD."postId"; ELSE resource_id:=OLD.id; END IF;
 IF EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"=resource AND "resourceId"=resource_id AND dependency IS NOT NULL) THEN RAISE EXCEPTION 'RETAINED_RESOURCE_PURGE_POLICY_REQUIRED'; END IF;
 RETURN OLD; END $$;
CREATE TRIGGER publishing_soft_retained_post BEFORE DELETE ON "CalendarPost" FOR EACH ROW EXECUTE FUNCTION publishing_soft_retained_delete_guard();
CREATE TRIGGER publishing_soft_retained_asset BEFORE DELETE ON "CalendarPostAsset" FOR EACH ROW EXECUTE FUNCTION publishing_soft_retained_delete_guard();
CREATE TRIGGER publishing_soft_retained_workspace BEFORE DELETE ON "SocialCalendar" FOR EACH ROW EXECUTE FUNCTION publishing_soft_retained_delete_guard();
CREATE TRIGGER publishing_soft_retained_creator BEFORE DELETE ON "Creator" FOR EACH ROW EXECUTE FUNCTION publishing_soft_retained_delete_guard();
CREATE FUNCTION publishing_soft_retained_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"='POST' AND "resourceId"=OLD.id AND dependency IS NOT NULL) AND
 (to_jsonb(NEW)-ARRAY['publishStatus','instagramPublishStatus','tikTokPublishStatus','platformPostId','instagramMediaId','tikTokPublishId','publishedAt','instagramPublishedAt','tikTokPublishedAt','publishPermalink','instagramPermalink','updatedAt']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['publishStatus','instagramPublishStatus','tikTokPublishStatus','platformPostId','instagramMediaId','tikTokPublishId','publishedAt','instagramPublishedAt','tikTokPublishedAt','publishPermalink','instagramPermalink','updatedAt']) THEN RAISE EXCEPTION 'RETAINED_RESOURCE_RESTORE_NOT_AUTHORIZED'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_soft_retained_content BEFORE UPDATE ON "CalendarPost" FOR EACH ROW EXECUTE FUNCTION publishing_soft_retained_update_guard();

CREATE TRIGGER publishing_retention_job_creation BEFORE INSERT ON "PublishingJob" FOR EACH ROW EXECUTE FUNCTION publishing_retention_admission_guard();
CREATE TRIGGER publishing_retention_job_preparation BEFORE UPDATE ON "PublishingJob" FOR EACH ROW WHEN(NEW.phase IN ('READY','PREPARED')) EXECUTE FUNCTION publishing_retention_admission_guard();
CREATE TRIGGER publishing_retention_admission BEFORE INSERT ON "PublishingCanonicalOperation" FOR EACH ROW WHEN(NEW.action IN ('admit','prepare')) EXECUTE FUNCTION publishing_retention_admission_guard();
CREATE FUNCTION publishing_retained_parent_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; BEGIN
 PERFORM version FROM "PublishingEligibilityFence" WHERE id=1 FOR SHARE;
 SELECT "managerId" INTO owner_id FROM "SocialCalendar" WHERE id=NEW."calendarId";
 IF EXISTS(SELECT 1 FROM "PublishingResourceTombstone" WHERE ("resourceType"='WORKSPACE' AND "resourceId"=NEW."calendarId") OR ("resourceType"='CREATOR' AND "resourceId"=owner_id)) THEN RAISE EXCEPTION 'RETAINED_PARENT_NO_NEW_CONTENT'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_retained_parent_post BEFORE INSERT ON "CalendarPost" FOR EACH ROW EXECUTE FUNCTION publishing_retained_parent_insert_guard();
CREATE FUNCTION publishing_retired_workspace_rank_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; BEGIN
 IF NEW."resourceType"<>'WORKSPACE' THEN RETURN NEW; END IF;
 SELECT "managerId" INTO owner_id FROM "SocialCalendar" WHERE id=NEW."resourceId";
 INSERT INTO "PublishingEligibilityHold"("intentId",revision,reason)
 SELECT p."intentId",p.revision,'WORKSPACE_ENTITLEMENT_ORDER_CHANGED' FROM "PublishingRevisionPolicy" p JOIN "PublishingCanonicalRevision" r ON r."intentId"=p."intentId" AND r.revision=p.revision JOIN "PublishingJob" j ON j.id=r."jobId"
 WHERE p."ownerId"=owner_id AND j.phase IN ('READY','PREPARED','EXTERNAL_PENDING') ON CONFLICT DO NOTHING;
 RETURN NEW; END $$;
CREATE TRIGGER publishing_retired_workspace_order AFTER INSERT ON "PublishingResourceTombstone" FOR EACH ROW EXECUTE FUNCTION publishing_retired_workspace_rank_hold();
