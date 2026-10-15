-- AlterTable: add the new columns, slug nullable for now so the
-- existing row isn't rejected outright
ALTER TABLE "CreativoWebinar" ADD COLUMN "description" TEXT,
ADD COLUMN "slug" TEXT,
ADD COLUMN "whatToExpect" TEXT;

-- Backfill: generate a real slug for any existing row from its topic
UPDATE "CreativoWebinar"
SET "slug" = lower(regexp_replace(regexp_replace(trim("topic"), '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'))
WHERE "slug" IS NULL;

-- Now that every row has a value, enforce NOT NULL
ALTER TABLE "CreativoWebinar" ALTER COLUMN "slug" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CreativoWebinar_slug_key" ON "CreativoWebinar"("slug");