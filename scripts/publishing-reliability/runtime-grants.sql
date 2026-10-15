-- LOCAL rehearsal proposal, not production RLS/grants or a migration.
DO $$ DECLARE s text; t text; BEGIN
 s:=current_schema();IF current_user<>'synthetic_owner' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL OR s!~'^accelerated_[0-9]+$' THEN RAISE EXCEPTION 'DISPOSABLE_GRANT_REHEARSAL_ONLY'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='publishing_rehearsal_runtime') THEN CREATE ROLE publishing_rehearsal_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO publishing_rehearsal_runtime',s);
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname=s LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE %I.%I TO publishing_rehearsal_runtime',s,t);
 END LOOP;
 -- DELETE is limited to mutable coordination/application data. Evidence tables
 -- have no DELETE/TRUNCATE grant. Untrusted client SQL must never use this role.
 FOREACH t IN ARRAY ARRAY['PublishingAccountLease','PublishingCoordinationLease','CalendarPost','CalendarPostAsset','CalendarCollaborator'] LOOP
  EXECUTE format('GRANT DELETE ON TABLE %I.%I TO publishing_rehearsal_runtime',s,t);
 END LOOP;
END $$;
