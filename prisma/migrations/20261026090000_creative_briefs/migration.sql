-- Additive only. Historical scripts/captions stay untouched; no conversion is required.
ALTER TABLE "CalendarPost" ADD COLUMN "creativeBrief" JSONB, ADD COLUMN "creativeDevelopment" JSONB;
ALTER TABLE "CalendarPostAiGeneration" ADD COLUMN "creativeBrief" JSONB, ADD COLUMN "creativeDevelopment" JSONB;
