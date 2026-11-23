-- Existing workspaces retain their publishing settings and do not enter setup.
ALTER TABLE "SocialCalendar"
  ADD COLUMN "setupVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "publishingPreferenceSetAt" TIMESTAMP(3),
  ADD COLUMN "setupCompletedAt" TIMESTAMP(3);
