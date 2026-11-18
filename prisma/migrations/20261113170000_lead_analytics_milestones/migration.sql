BEGIN;

-- Historical stage-change dates were not recorded. Start tracking prospectively;
-- never infer an old conversion date from createdAt or updatedAt.
CREATE TABLE IF NOT EXISTS "LeadAnalyticsTracking" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "LeadAnalyticsTracking" ("id") VALUES ('lead-milestones-v1') ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "CalendarLeadMilestone" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "leadId" TEXT NOT NULL REFERENCES "CalendarLead"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('HOT', 'CUSTOMER')),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "CalendarLeadMilestone_leadId_kind_occurredAt_idx" ON "CalendarLeadMilestone"("leadId", "kind", "occurredAt");

CREATE OR REPLACE FUNCTION record_calendar_lead_milestones() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.temperature = 'HOT' AND NEW.status NOT IN ('CUSTOMER', 'LOST') THEN
      INSERT INTO "CalendarLeadMilestone" ("id", "leadId", "kind", "occurredAt")
      VALUES ('lm_' || md5(random()::text || clock_timestamp()::text), NEW.id, 'HOT', clock_timestamp());
    END IF;
    IF NEW.status = 'CUSTOMER' THEN
      INSERT INTO "CalendarLeadMilestone" ("id", "leadId", "kind", "occurredAt")
      VALUES ('lm_' || md5(random()::text || clock_timestamp()::text), NEW.id, 'CUSTOMER', clock_timestamp());
    END IF;
  ELSE
    IF NEW.temperature = 'HOT' AND NEW.status NOT IN ('CUSTOMER', 'LOST')
      AND (OLD.temperature <> 'HOT' OR OLD.status IN ('CUSTOMER', 'LOST')) THEN
      INSERT INTO "CalendarLeadMilestone" ("id", "leadId", "kind", "occurredAt")
      VALUES ('lm_' || md5(random()::text || clock_timestamp()::text), NEW.id, 'HOT', clock_timestamp());
    END IF;
    IF NEW.status = 'CUSTOMER' AND OLD.status <> 'CUSTOMER' THEN
      INSERT INTO "CalendarLeadMilestone" ("id", "leadId", "kind", "occurredAt")
      VALUES ('lm_' || md5(random()::text || clock_timestamp()::text), NEW.id, 'CUSTOMER', clock_timestamp());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS calendar_lead_milestones ON "CalendarLead";
CREATE TRIGGER calendar_lead_milestones
AFTER INSERT OR UPDATE OF temperature, status ON "CalendarLead"
FOR EACH ROW EXECUTE FUNCTION record_calendar_lead_milestones();

COMMIT;
