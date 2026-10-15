-- Candidate schema. Applied ONLY to disposable staging by the assessment runner.
-- No Prisma migration or production installation is authorized.
CREATE TABLE "PublishingLeader" (
 id integer PRIMARY KEY CHECK(id=1), owner text, epoch bigint NOT NULL DEFAULT 0,
 "leaseUntil" timestamptz, "lastMinute" bigint NOT NULL DEFAULT -1
);
INSERT INTO "PublishingLeader"(id) VALUES(1);
CREATE TABLE "PublishingBudget" (
 id integer PRIMARY KEY CHECK(id BETWEEN 0 AND 3), owner text, "leaseUntil" timestamptz
);
INSERT INTO "PublishingBudget"(id) SELECT generate_series(0,3);
CREATE TABLE "PublishingAdmission" (
 id text PRIMARY KEY, platform "SocialPlatform" NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "PublishingJob" (
 id text PRIMARY KEY, "admissionId" text NOT NULL REFERENCES "PublishingAdmission"(id),
 "postId" text NOT NULL, platform "SocialPlatform" NOT NULL, lease timestamp(3) NOT NULL,
 phase text NOT NULL CHECK(phase IN ('READY','PREPARED','EXTERNAL_PENDING','PROVIDER_PENDING','CONFIRMED','OUTCOME_UNKNOWN','CANCELLED','REJECTED')),
 "availableAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "attempts" integer NOT NULL DEFAULT 0, "lastError" text,
 "accountId" text,"confirmation" jsonb,"reportingPending" boolean NOT NULL DEFAULT true,
 "reconcileOwner" text,"reconcileUntil" timestamptz,
 "consumerSlot" integer,"consumerEpoch" bigint,"consumerOwner" text,
 "workerToken" text, "workerUntil" timestamptz, "startedAt" timestamp(3), "remoteId" text,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE("postId",platform,lease)
);
CREATE INDEX ON "PublishingJob"(phase,platform,"createdAt",id);
CREATE TABLE "PublishingConsumerLease" (
 id integer PRIMARY KEY CHECK(id IN (0,1)),owner text,epoch bigint NOT NULL DEFAULT 0,"leaseUntil" timestamptz
);
INSERT INTO "PublishingConsumerLease"(id) VALUES(0),(1);
CREATE TABLE "PublishingWake" (
 id integer PRIMARY KEY CHECK(id=1),generation bigint NOT NULL DEFAULT 0,pending boolean NOT NULL DEFAULT false,
 "sendAt" timestamptz NOT NULL DEFAULT clock_timestamp(),"deliveryOwner" text,"deliveryUntil" timestamptz,"attempts" integer NOT NULL DEFAULT 0
);
INSERT INTO "PublishingWake"(id) VALUES(1);

-- Account-level execution mutex across all consumer hosts, independent of DB slots.
CREATE TABLE "PublishingAccountLease" (
 platform "SocialPlatform" NOT NULL, "accountId" text NOT NULL, "jobId" text NOT NULL,
 token text NOT NULL, "leaseUntil" timestamptz NOT NULL, PRIMARY KEY(platform,"accountId")
);
