-- Engage is a distinct product package, excluded from Marketing's tier ranking.
ALTER TYPE "ContentWorkspacePlan" ADD VALUE IF NOT EXISTS 'ENGAGE';

-- Lock the billing owner before checking account limits so concurrent OAuth
-- callbacks cannot connect more than two accounts. Reauthorization and token
-- refreshes of an existing account do not consume another slot.
CREATE OR REPLACE FUNCTION enforce_engage_connection_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner_id text; owner_plan text; connection_count integer;
BEGIN
  IF NEW.status::text = 'DISCONNECTED' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status::text <> 'DISCONNECTED' AND OLD."calendarId" = NEW."calendarId"
      AND OLD."platformAccountId" = NEW."platformAccountId" AND OLD.platform = NEW.platform THEN RETURN NEW; END IF;
  END IF;
  SELECT c.id, c."contentWorkspacePlan"::text INTO owner_id, owner_plan
    FROM "Creator" c JOIN "SocialCalendar" w ON w."managerId" = c.id
    WHERE w.id = NEW."calendarId" FOR UPDATE OF c;
  IF owner_plan = 'ENGAGE' THEN
    SELECT count(*) INTO connection_count FROM "SocialConnection" s
      JOIN "SocialCalendar" w ON w.id = s."calendarId"
      WHERE w."managerId" = owner_id AND s.status::text <> 'DISCONNECTED' AND s.id <> NEW.id;
    IF connection_count >= 2 THEN
      RAISE EXCEPTION 'Showwork Engage includes two connected accounts. Disconnect an account before connecting another.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS engage_connection_limit ON "SocialConnection";
CREATE TRIGGER engage_connection_limit BEFORE INSERT OR UPDATE ON "SocialConnection"
  FOR EACH ROW EXECUTE FUNCTION enforce_engage_connection_limit();
