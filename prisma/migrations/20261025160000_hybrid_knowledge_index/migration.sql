-- Additive, extension-free index. Originals and all existing knowledge paths remain intact.
ALTER TABLE "CalendarBusinessDocument" ADD CONSTRAINT "CalendarBusinessDocument_id_calendarId_key" UNIQUE ("id", "calendarId");
CREATE TABLE "KnowledgeSourceIndex" (
  "sourceId" TEXT PRIMARY KEY,
  "calendarId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "sourceHash" TEXT,
  "indexKey" TEXT,
  "model" TEXT,
  "modelVersion" TEXT,
  "dimensions" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','RUNNING','READY','FAILED')),
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "errorCode" TEXT,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("sourceId","calendarId") REFERENCES "CalendarBusinessDocument"("id","calendarId") ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE ("sourceId","calendarId")
);
CREATE INDEX "KnowledgeSourceIndex_queue_idx" ON "KnowledgeSourceIndex" ("status","nextAttemptAt");
CREATE INDEX "KnowledgeSourceIndex_workspace_idx" ON "KnowledgeSourceIndex" ("calendarId","indexKey");
CREATE TABLE "KnowledgePassage" (
  "id" TEXT PRIMARY KEY,
  "sourceId" TEXT NOT NULL,
  "calendarId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT,
  "heading" TEXT NOT NULL,
  "start" INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT '{}',
  FOREIGN KEY ("sourceId","calendarId") REFERENCES "KnowledgeSourceIndex"("sourceId","calendarId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "KnowledgePassage_workspace_idx" ON "KnowledgePassage" ("calendarId","sourceId","revision");
CREATE OR REPLACE FUNCTION showwork_invalidate_knowledge_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "KnowledgeSourceIndex" ("sourceId","calendarId") VALUES (NEW.id,NEW."calendarId")
  ON CONFLICT ("sourceId") DO UPDATE SET
    "revision"="KnowledgeSourceIndex"."revision"+1,"sourceHash"=NULL,"status"='PENDING',
    "leaseToken"=NULL,"leaseUntil"=NULL,"attempts"=0,"errorCode"=NULL,"inputTokens"=0,
    "nextAttemptAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP;
  DELETE FROM "KnowledgePassage" WHERE "sourceId"=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER "knowledge_source_insert" AFTER INSERT ON "CalendarBusinessDocument"
FOR EACH ROW EXECUTE FUNCTION showwork_invalidate_knowledge_index();
CREATE TRIGGER "knowledge_source_update" AFTER UPDATE OF "extractedText","originalName","websiteUrl","calendarId" ON "CalendarBusinessDocument"
FOR EACH ROW WHEN (OLD."extractedText" IS DISTINCT FROM NEW."extractedText" OR OLD."originalName" IS DISTINCT FROM NEW."originalName" OR OLD."websiteUrl" IS DISTINCT FROM NEW."websiteUrl" OR OLD."calendarId" IS DISTINCT FROM NEW."calendarId")
EXECUTE FUNCTION showwork_invalidate_knowledge_index();
-- Queue only metadata for existing sources. No external calls in migration.
INSERT INTO "KnowledgeSourceIndex" ("sourceId","calendarId") SELECT id,"calendarId" FROM "CalendarBusinessDocument" ON CONFLICT DO NOTHING;
