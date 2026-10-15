-- REVIEW-ONLY PROPOSAL. Never invoked by an application, worker or build.
-- Requires deployment approval, DBA-selected schema and distinct migration owner.
-- All names below assume public is the approved application/canonical schema.
-- Substitute role names after reviewing existing Supabase/RLS/pooler grants.
BEGIN;
CREATE ROLE publishing_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO publishing_runtime;
-- No schema CREATE, table ownership, trigger alteration, TRUNCATE or evidence DELETE.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'Publishing%'
 LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',r.tablename);
  -- Application receipts can contain private native billing/admin responses and
  -- encrypted OAuth selection tickets. The worker neither reads nor writes them.
  IF r.tablename <> 'PublishingApplicationOperation' THEN
   IF r.tablename IN ('PublishingBillingRevocationHold','PublishingBillingRevocationResolution') THEN
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO publishing_runtime',r.tablename);
   ELSE
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO publishing_runtime',r.tablename);
   END IF;
  END IF;
 END LOOP;
END $$;
GRANT UPDATE ON public."PublishingOwnership",public."PublishingIntent",public."PublishingJob",
 public."PublishingExternalAttempt",public."PublishingRetryGeneration",public."PublishingSendCapability",
 public."PublishingAccountBinding",public."PublishingIntegrationControl",public."PublishingBudget",
 public."PublishingAccountLease",public."PublishingCoordinationLease",public."PublishingRateBucket",
 public."PublishingRequestSpacing",public."PublishingLegacyDisposition"
 TO publishing_runtime;
GRANT UPDATE (version) ON public."PublishingEligibilityFence" TO publishing_runtime;
GRANT DELETE ON public."PublishingAccountLease",public."PublishingCoordinationLease" TO publishing_runtime;
GRANT SELECT ON public."Creator",public."SocialCalendar",public."CalendarCollaborator",
 public."CalendarPost",public."CalendarPostAsset",public."SocialConnection" TO publishing_runtime;
-- SQL projections/refresh need narrowly scoped application writes. Application
-- mutation roles require separate permission review; do not grant broad cascades.
-- Projection writes references/timestamps only after durable confirmation. These
-- fields are UI evidence projections, never authoritative send permissions.
GRANT UPDATE ("publishStatus","instagramPublishStatus","tikTokPublishStatus",
 "platformPostId","instagramMediaId","tikTokPublishId",
 "publishedAt","instagramPublishedAt","tikTokPublishedAt",
 "publishPermalink","instagramPermalink") ON public."CalendarPost" TO publishing_runtime;
GRANT UPDATE ("accessToken","accessTokenExpiresAt","refreshToken","refreshTokenExpiresAt","tokenScopes","updatedAt") ON public."SocialConnection" TO publishing_runtime;
-- Trigger invocation does not require exposing trigger functions to API roles.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'publishing_%'
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',r.signature); END LOOP;
END $$;
-- Confirmed publication reporting projection; never account creation/retargeting.
GRANT SELECT, INSERT, UPDATE ON public."PublishedSocialPost" TO publishing_runtime;
COMMIT;
-- This proposal is not sufficient tenant RLS or a security-definer API. The
-- trusted backend can insert evidence; restricting that authority is a release gate.
