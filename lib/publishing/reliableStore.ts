import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed, assertLegacyFactoryNotRetired } from "@/lib/publishing/applicationBoundary";
import { Prisma, type PrismaClient, type SocialPlatform } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PUBLISHING_PLATFORMS } from "./state";
import { PublishingDeferred } from "./errors";
export { PublishingDeferred } from "./errors";

/** Offline candidate; no production handler imports this store. Tables are a
 * reviewed proposal, created only in disposable staging by the assessment. */
type Database = Pick<PrismaClient, "$queryRaw" | "$transaction">;
type Leader = { owner: string; epoch: bigint };
export type ConsumerLease = Leader & { id: number };
export type PublicationProof = { accountId: string; data: Record<string, string>; reference: string };
export type DurableJob = { id: string; postId: string; platform: SocialPlatform; lease: Date; phase: string; workerToken: string | null; remoteId?: string | null; accountId?: string | null; confirmation?: PublicationProof | null };

function field(platform: SocialPlatform) {
  if (!PUBLISHING_PLATFORMS.includes(platform)) throw new Error("Unsupported publishing platform");
  return Prisma.raw(platform === "INSTAGRAM" ? '"instagramPublishStatus"' : platform === "TIKTOK" ? '"tikTokPublishStatus"' : '"publishStatus"');
}

export function createReliablePublishingStore(database: Database, options: { dataSlots?: 3 | 4; coordination?: "autocommit" | "budgeted" } = {}) {
/* canonical-only-helper */
  assertLegacyFactoryNotRetired("lib/publishing/reliableStore.ts#createReliablePublishingStore");
/* end-canonical-only-helper */
  const dataSlots = options.dataSlots ?? 3;
  if (![3, 4].includes(dataSlots)) throw new Error("Invalid global data budget");
  const query = <T,>(sql: Prisma.Sql) => database.$queryRaw<T>(sql);
  function consumerGuard(consumer?: ConsumerLease) {
    return Prisma.sql`(${consumer?.id ?? null}::integer IS NULL OR EXISTS(SELECT 1 FROM "PublishingConsumerLease" c WHERE c.id=${consumer?.id ?? null} AND c.owner=${consumer?.owner ?? null} AND c.epoch=${consumer?.epoch ?? null} AND c."leaseUntil">clock_timestamp() FOR SHARE))`;
  }
  function transition<T>(sql: Prisma.Sql, consumer?: ConsumerLease) {
    // A single conditional statement is already atomic; its returned result is
    // committed before an SDK dispatch. The five-backend pool bounds physical
    // connections while three slots remain reserved for multi-query native work.
    return options.coordination === "budgeted" ? budget("worker", tx => tx.$queryRaw<T>(sql), undefined, undefined, consumer) : query<T>(sql);
  }
  async function leader(owner: string): Promise<Leader | null> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#leader@33"); } /* end-canonical-integration-boundary */

    const rows = await query<Leader[]>(Prisma.sql`UPDATE "PublishingLeader" SET owner=${owner},epoch=epoch+1,
      "leaseUntil"=clock_timestamp()+interval '30 seconds',"lastMinute"=floor(extract(epoch FROM clock_timestamp())/60)::bigint
      WHERE id=1 AND (owner IS NULL OR "leaseUntil"<=clock_timestamp())
        AND "lastMinute"<floor(extract(epoch FROM clock_timestamp())/60)::bigint RETURNING owner,epoch`);
    return rows[0] ?? null;
  }
  async function scheduledWorkExists() {
    const rows = await query<{ needed: boolean }[]>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM "CalendarPost" p WHERE p."approvalStatus"='APPROVED' AND NOT p."isAiDraft" AND p."postDate"<=clock_timestamp() AT TIME ZONE 'UTC'
      AND (p.platform='INSTAGRAM' AND p."instagramPublishStatus"='SCHEDULED' OR p.platform='TIKTOK' AND p."tikTokPublishStatus"='SCHEDULED' OR p.platform IN ('FACEBOOK','LINKEDIN','X') AND p."publishStatus"='SCHEDULED')) AS needed`);
    return !!rows[0]?.needed;
  }
  async function releaseLeader(l: Leader) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#releaseLeader@45"); } /* end-canonical-integration-boundary */

    await query(Prisma.sql`UPDATE "PublishingLeader" SET owner=NULL,"leaseUntil"=NULL WHERE id=1 AND owner=${l.owner} AND epoch=${l.epoch}`);
  }
  async function recoverLeader(owner: string) {
    const rows = await query<Leader[]>(Prisma.sql`SELECT owner,epoch FROM "PublishingLeader" WHERE id=1 AND owner=${owner} AND "leaseUntil">clock_timestamp()`);
    return rows[0] ?? null;
  }
  async function findJob(id: string) {
    const rows = await query<(DurableJob & { remoteId: string | null })[]>(Prisma.sql`SELECT id,"postId",platform,lease,phase,"workerToken","remoteId","accountId","confirmation" FROM "PublishingJob" WHERE id=${id}`);
    return rows[0] ?? null;
  }
  async function findJobs(ids: string[]) {
    if (!ids.length || ids.length > 5) throw new Error("Invalid fair job batch");
    return query<DurableJob[]>(Prisma.sql`SELECT id,"postId",platform,lease,phase,"workerToken" FROM "PublishingJob" WHERE id IN (${Prisma.join(ids)}) ORDER BY "createdAt",id`);
  }
  async function prepareMany(requests: { id: string; token: string }[], consumer?: ConsumerLease) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#prepareMany@60"); } /* end-canonical-integration-boundary */

    if (!requests.length || requests.length > 5) throw new Error("Invalid preparation batch");
    return transition<DurableJob[]>(Prisma.sql`WITH requested AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(requests)}::jsonb) AS r(id text,token text)),
      unlocked AS MATERIALIZED (SELECT j.id FROM "PublishingJob" j JOIN requested r ON r.id=j.id FOR UPDATE OF j SKIP LOCKED)
      UPDATE "PublishingJob" j SET phase='PREPARED',"workerToken"=r.token,"workerUntil"=clock_timestamp()+interval '3 minutes',"consumerSlot"=${consumer?.id ?? null},"consumerEpoch"=${consumer?.epoch ?? null},"consumerOwner"=${consumer?.owner ?? null},"updatedAt"=clock_timestamp()
      FROM requested r,unlocked u,"CalendarPost" p WHERE j.id=r.id AND j.id=u.id AND p.id=j."postId" AND p.platform=j.platform AND p."updatedAt"=j.lease
        AND p."approvalStatus"='APPROVED' AND NOT p."isAiDraft" AND p."publishWorkerStartedAt" IS NULL
        AND CASE WHEN p.platform='INSTAGRAM' THEN p."instagramPublishStatus"::text WHEN p.platform='TIKTOK' THEN p."tikTokPublishStatus"::text ELSE p."publishStatus"::text END='PUBLISHING'
        AND ${consumerGuard(consumer)} AND j."availableAt"<=clock_timestamp() AND (j.phase='READY' OR j.phase='PREPARED' AND j."workerUntil"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PublishingConsumerLease" c WHERE c.id=j."consumerSlot" AND c.owner=j."consumerOwner" AND c.epoch=j."consumerEpoch" AND c."leaseUntil">clock_timestamp()))
      RETURNING j.id,j."postId",j.platform,j.lease,j.phase,j."workerToken"`, consumer);
  }
  async function recoverPrepared(tokens: string[]) {
    return query<DurableJob[]>(Prisma.sql`SELECT id,"postId",platform,lease,phase,"workerToken" FROM "PublishingJob" WHERE "workerToken" IN (${Prisma.join(tokens)}) AND phase='PREPARED' AND "workerUntil">clock_timestamp()`);
  }
  async function releasePrepared(id: string, token: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#releasePrepared@74"); } /* end-canonical-integration-boundary */

    // The caller has stopped its private actor. PREPARED proves that no external
    // boundary committed; pending/unknown outcomes must never use this path.
    return query(Prisma.sql`UPDATE "PublishingJob" SET "workerUntil"=clock_timestamp(),
      "consumerSlot"=NULL,"consumerEpoch"=NULL,"consumerOwner"=NULL,"updatedAt"=clock_timestamp()
      WHERE id=${id} AND "workerToken"=${token} AND phase='PREPARED'`);
  }
  async function budget<T>(lane: "admission" | "worker", action: (tx: Prisma.TransactionClient) => Promise<T>, l?: Leader, limits?: { timeout?: number; maxWait?: number }, consumer?: ConsumerLease) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#budget@81"); } /* end-canonical-integration-boundary */

    const timeout = limits?.timeout ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 40_000) throw new Error("Invalid publishing transaction limit");
    const leaseSeconds = Math.max(10, Math.ceil(timeout / 1000) + 5);
    const owner = randomUUID();
    // Three global data slots by default leave two backend connections for control.
    // Four is available ONLY for comparative isolated capacity assessments.
    // Reserve before opening an interactive transaction. Trying to reserve only
    // inside that transaction lets unsuccessful contenders occupy pool capacity
    // and caused P2028 errors in the realistic five-backend staging assessment.
    const slots = await query<{ id: number }[]>(Prisma.sql`
      WITH candidate AS MATERIALIZED (SELECT b.id FROM "PublishingBudget" b WHERE b.id<${dataSlots} AND (b.owner IS NULL OR b."leaseUntil"<=clock_timestamp())
        AND (${lane}='admission' AND b.id<2 OR ${lane}='worker' AND (b.id>=2 OR NOT EXISTS(SELECT 1 FROM "PublishingLeader" WHERE owner IS NOT NULL AND "leaseUntil">clock_timestamp())))
        ORDER BY CASE WHEN b.id>=2 THEN 0 ELSE 1 END,b.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED),
      free AS (SELECT id FROM candidate WHERE pg_try_advisory_xact_lock(19370421,id))
      UPDATE "PublishingBudget" b SET owner=${owner},"leaseUntil"=clock_timestamp()+${leaseSeconds}*interval '1 second'
      FROM free WHERE b.id=free.id RETURNING b.id`);
    if (!slots.length) throw new PublishingDeferred("Global database budget busy");
    const slot = slots[0].id;
    try {
      return await database.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL statement_timeout='2000ms'`;
        const rows = await tx.$queryRaw<{ valid: boolean }[]>(Prisma.sql`SELECT pg_try_advisory_xact_lock(19370421,${slot}::integer) AND EXISTS(
          SELECT 1 FROM "PublishingBudget" WHERE id=${slot} AND owner=${owner} AND "leaseUntil">clock_timestamp()) AS valid`);
        if (!rows[0]?.valid) throw new PublishingDeferred("Database slot expired or fenced");
        if (l) {
          const current = await tx.$queryRaw(Prisma.sql`SELECT id FROM "PublishingLeader" WHERE id=1 AND owner=${l.owner} AND epoch=${l.epoch} AND "leaseUntil">clock_timestamp() FOR SHARE`);
          if (!(current as unknown[]).length) throw new PublishingDeferred("Leadership lost", "PUBLISHING_FENCED");
        }
        if (consumer) {
          const valid = await tx.$queryRaw(Prisma.sql`SELECT id FROM "PublishingConsumerLease" WHERE id=${consumer.id} AND owner=${consumer.owner} AND epoch=${consumer.epoch} AND "leaseUntil">clock_timestamp() FOR SHARE`);
          if (!(valid as unknown[]).length) throw new PublishingDeferred("Consumer leadership lost", "PUBLISHING_FENCED");
        }
        return action(tx);
      }, { maxWait: Math.min(limits?.maxWait ?? 2500, 2500), timeout });
    } finally {
      try { await query(Prisma.sql`UPDATE "PublishingBudget" SET owner=NULL,"leaseUntil"=NULL WHERE id=${slot} AND owner=${owner}`); }
      catch { /* expiry recovers the slot; the advisory lock protects a live TX */ }
    }
  }
  async function admit(l: Leader | undefined, platform: SocialPlatform, admissionId: string, now: Date, limit = 20, onlyPostId?: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#admit@121"); } /* end-canonical-integration-boundary */

    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid batch size");
    const status = field(platform);
    return budget(l ? "admission" : "worker", async tx => tx.$queryRaw<DurableJob[]>(Prisma.sql`
      WITH operation AS (INSERT INTO "PublishingAdmission"(id,platform) VALUES(${admissionId},${platform}::"SocialPlatform") ON CONFLICT DO NOTHING RETURNING id),
      candidates AS (SELECT p.id,p."updatedAt" FROM "CalendarPost" p WHERE EXISTS(SELECT 1 FROM operation)
        AND p.platform=${platform}::"SocialPlatform" AND p.${status}='SCHEDULED' AND p."approvalStatus"='APPROVED' AND NOT p."isAiDraft"
        AND (${onlyPostId ?? null}::text IS NULL OR p.id=${onlyPostId ?? null})
        AND NOT EXISTS(SELECT 1 FROM "PublishingJob" j WHERE j."postId"=p.id AND j.platform=p.platform AND j.phase<>'CANCELLED')
        AND p."postDate"<=(${now}::timestamptz AT TIME ZONE 'UTC') ORDER BY p."postDate",p.id LIMIT ${limit} FOR UPDATE OF p SKIP LOCKED),
      claimed AS (UPDATE "CalendarPost" p SET ${status}='PUBLISHING',"publishWorkerStartedAt"=NULL,
        "updatedAt"=GREATEST(date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC'),p."updatedAt"+interval '1 millisecond')
        FROM candidates c WHERE p.id=c.id AND p."updatedAt"=c."updatedAt" AND p.${status}='SCHEDULED' AND p."approvalStatus"='APPROVED' AND NOT p."isAiDraft"
        RETURNING p.id,p.platform,p."updatedAt"),
      jobs AS (INSERT INTO "PublishingJob"(id,"admissionId","postId",platform,lease,phase)
        SELECT ${admissionId}||':'||c.id,${admissionId},c.id,c.platform,c."updatedAt",'READY' FROM claimed c
        RETURNING id,"postId",platform,lease,phase,"workerToken") SELECT * FROM jobs`), l);
  }
  // Reconcile an uncertain DB commit by reading the durable outbox; never issue a
  // second claim or invoke a provider to determine whether that commit happened.
  async function recoverAdmission(admissionId: string) {
    return query<DurableJob[]>(Prisma.sql`SELECT id,"postId",platform,lease,phase,"workerToken" FROM "PublishingJob" WHERE "admissionId"=${admissionId} ORDER BY id`);
  }
  async function ready(platform: SocialPlatform, limit = 20) {
    field(platform);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid worker batch size");
    return query<DurableJob[]>(Prisma.sql`SELECT id,"postId",platform,lease,phase,"workerToken" FROM "PublishingJob" WHERE platform=${platform}::"SocialPlatform"
      AND "availableAt"<=clock_timestamp() AND (phase='READY' OR phase='PREPARED' AND "workerUntil"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PublishingConsumerLease" c WHERE c.id="PublishingJob"."consumerSlot" AND c.owner="PublishingJob"."consumerOwner" AND c.epoch="PublishingJob"."consumerEpoch" AND c."leaseUntil">clock_timestamp())) ORDER BY "createdAt",id LIMIT ${limit}`);
  }
  async function readyFair(rotation = 0) {
    if (!Number.isInteger(rotation) || rotation < 0 || rotation >= PUBLISHING_PLATFORMS.length) throw new Error("Invalid platform rotation");
    const order = PUBLISHING_PLATFORMS.map((_, i) => PUBLISHING_PLATFORMS[(rotation + i) % PUBLISHING_PLATFORMS.length]);
    // Five index-supported oldest-job selections share one control query.
    return query<DurableJob[]>(Prisma.sql`SELECT j.* FROM unnest(ARRAY[${Prisma.join(order)}]::"SocialPlatform"[]) WITH ORDINALITY AS p(platform,n)
      CROSS JOIN LATERAL (SELECT id,"postId",platform,lease,phase,"workerToken" FROM "PublishingJob" WHERE platform=p.platform
        AND "availableAt"<=clock_timestamp() AND (phase='READY' OR phase='PREPARED' AND "workerUntil"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PublishingConsumerLease" c WHERE c.id="PublishingJob"."consumerSlot" AND c.owner="PublishingJob"."consumerOwner" AND c.epoch="PublishingJob"."consumerEpoch" AND c."leaseUntil">clock_timestamp())) ORDER BY "createdAt",id LIMIT 1) j ORDER BY p.n`);
  }
  async function readLiveAuthorization(job: DurableJob, connectionId?: string) {
    // A fixed read-only autocommit snapshot; it does not consume an interactive
    // transaction slot. Only the fields used by the existing authorization
    // policy and by the exact publishing connection guard are selected.
    const rows = await query<{calendarId:string; workspaceOrdinal:number; manager: Record<string,unknown>; connection: Record<string,unknown> | null; legacy: Record<string,unknown>}[]>(Prisma.sql`
      SELECT c.id AS "calendarId",(SELECT count(*)::integer FROM "SocialCalendar" x WHERE x."managerId"=c."managerId" AND (x."createdAt",x.id)<=(c."createdAt",c.id)) AS "workspaceOrdinal",
        jsonb_build_object('id',m.id,'contentWorkspacePlan',m."contentWorkspacePlan",'contentWorkspaceBillingStatus',m."contentWorkspaceBillingStatus",
          'contentWorkspaceBillingCycle',m."contentWorkspaceBillingCycle",'contentWorkspaceTrialEndsAt',m."contentWorkspaceTrialEndsAt",
          'billingComplimentaryGrants',m."billingComplimentaryGrants",'workspaceCompedPlan',m."workspaceCompedPlan",'workspaceCompedUntil',m."workspaceCompedUntil",
          'isComped',m."isComped",'compedUntil',m."compedUntil") AS manager,
        CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id',s.id,'calendarId',s."calendarId",'platform',s.platform,'platformAccountId',s."platformAccountId",
          'status',s.status,'accessToken',s."accessToken",'accessTokenExpiresAt',s."accessTokenExpiresAt",'tokenScopes',s."tokenScopes") END AS connection,
        jsonb_build_object('instagramAccountId',c."instagramAccountId",'instagramAccessToken',c."instagramAccessToken",'instagramTokenExpiresAt',c."instagramTokenExpiresAt") AS legacy
      FROM "PublishingJob" j JOIN "CalendarPost" p ON p.id=j."postId" JOIN "SocialCalendar" c ON c.id=p."calendarId" JOIN "Creator" m ON m.id=c."managerId"
      LEFT JOIN "SocialConnection" s ON s.id=${connectionId ?? null} AND s."calendarId"=c.id AND s.platform=j.platform
      WHERE j.id=${job.id} AND j."workerToken"=${job.workerToken} AND j.phase IN ('PREPARED','EXTERNAL_PENDING')`);
    if (!rows[0]) throw new PublishingDeferred("Live publishing ownership changed","PUBLISHING_FENCED");
    const row = rows[0];
    for (const value of [row.manager,row.connection,row.legacy]) if (value) for (const key of ['contentWorkspaceTrialEndsAt','workspaceCompedUntil','compedUntil','accessTokenExpiresAt','instagramTokenExpiresAt']) {
      const text = value[key]; if (typeof text === 'string') value[key] = new Date(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : text+'Z');
    }
    return row;
  }
  async function reserveTikTokRate(account: string, kind: "creator" | "init" | "status") {
    const settings = {creator:{field:'"creatorNextAt"',interval:3100},init:{field:'"initNextAt"',interval:10100},status:{field:'"statusNextAt"',interval:2100}};
    const setting = settings[kind];
    if (!setting || !account) throw new Error("Invalid TikTok rate reservation");
    const column = Prisma.raw(setting.field), interval = setting.interval;
    // Same advisory-lock namespace as the native path: UI/status callers and
    // candidate workers serialize reservations together. No IO holds this lock.
    const rows = await query<{ locked: boolean; wait: number | null }[]>(Prisma.sql`WITH lock AS MATERIALIZED (
      SELECT pg_try_advisory_xact_lock(hashtext(${'tiktok-rate:'+account})) AS locked), reserved AS (
      INSERT INTO "TikTokAccountRuntime"("accountId",${column})
      SELECT ${account},(clock_timestamp() AT TIME ZONE 'UTC')+${interval}*interval '1 millisecond' FROM lock WHERE locked
      ON CONFLICT("accountId") DO UPDATE SET ${column}=GREATEST(clock_timestamp() AT TIME ZONE 'UTC',"TikTokAccountRuntime".${column})+${interval}*interval '1 millisecond'
      WHERE "TikTokAccountRuntime".${column} IS NULL OR "TikTokAccountRuntime".${column}<=(clock_timestamp() AT TIME ZONE 'UTC')+interval '15 seconds'
      RETURNING GREATEST(0,EXTRACT(EPOCH FROM (${column}-${interval}*interval '1 millisecond'-(clock_timestamp() AT TIME ZONE 'UTC')))*1000)::integer AS wait)
      SELECT lock.locked,reserved.wait FROM lock LEFT JOIN reserved ON true`);
    if (!rows[0]?.locked || rows[0].wait === null) throw new PublishingDeferred("TikTok account rate capacity busy");
    return rows[0].wait;
  }
  async function acquireAccount(job: DurableJob, token: string, account: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#acquireAccount@199"); } /* end-canonical-integration-boundary */

    const rows = await query<{ token: string }[]>(Prisma.sql`INSERT INTO "PublishingAccountLease"(platform,"accountId","jobId",token,"leaseUntil")
      SELECT ${job.platform}::"SocialPlatform",${account},${job.id},${token},clock_timestamp()+interval '14 minutes'
      WHERE EXISTS(SELECT 1 FROM "PublishingJob" WHERE id=${job.id} AND "workerToken"=${token} AND phase='PREPARED' AND "workerUntil">clock_timestamp())
      ON CONFLICT(platform,"accountId") DO UPDATE SET "jobId"=EXCLUDED."jobId",token=EXCLUDED.token,"leaseUntil"=EXCLUDED."leaseUntil"
      WHERE "PublishingAccountLease"."leaseUntil"<=clock_timestamp() OR "PublishingAccountLease".token=EXCLUDED.token RETURNING token`);
    return rows.length === 1;
  }
  async function releaseAccount(job: DurableJob, token: string, account: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#releaseAccount@207"); } /* end-canonical-integration-boundary */

    await query(Prisma.sql`DELETE FROM "PublishingAccountLease" WHERE platform=${job.platform}::"SocialPlatform" AND "accountId"=${account} AND "jobId"=${job.id} AND token=${token}`);
  }
  async function recoverAccountLeases() {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#recoverAccountLeases@210"); } /* end-canonical-integration-boundary */

    await query(Prisma.sql`DELETE FROM "PublishingAccountLease" a USING "PublishingJob" j WHERE a."jobId"=j.id AND a.token=j."workerToken"
      AND (j.phase IN ('CONFIRMED','PROVIDER_PENDING','CANCELLED','REJECTED') OR j.phase='OUTCOME_UNKNOWN' AND j.confirmation IS NOT NULL
        OR j.phase='PREPARED' AND j."workerUntil"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PublishingConsumerLease" c WHERE c.id=j."consumerSlot" AND c.owner=j."consumerOwner" AND c.epoch=j."consumerEpoch" AND c."leaseUntil">clock_timestamp()))`);
  }
  async function nextWorkDelay(maximumMs = 5000) {
    if (!Number.isInteger(maximumMs) || maximumMs < 100 || maximumMs > 60_000) throw new Error("Invalid due-aware wait");
    const rows = await query<{ wait: number }[]>(Prisma.sql`SELECT COALESCE(GREATEST(100,LEAST(${maximumMs},EXTRACT(EPOCH FROM (min("availableAt")-clock_timestamp()))*1000)),${maximumMs})::integer AS wait
      FROM "PublishingJob" WHERE phase IN ('READY','PROVIDER_PENDING','OUTCOME_UNKNOWN') OR phase='CONFIRMED' AND "reportingPending"`);
    return rows[0]?.wait ?? maximumMs;
  }
  async function readyFairAccounts(rotation = 0) {
    if (!Number.isInteger(rotation) || rotation < 0 || rotation >= 5) throw new Error("Invalid platform rotation");
    const order = PUBLISHING_PLATFORMS.map((_,i) => PUBLISHING_PLATFORMS[(rotation+i)%5]);
    // Pick up to two distinct accounts per platform; interleave first choices
    // before second choices. A busy account cannot hide a different account.
    return query<DurableJob[]>(Prisma.sql`SELECT j.* FROM unnest(ARRAY[${Prisma.join(order)}]::"SocialPlatform"[]) WITH ORDINALITY AS r(platform,n)
      CROSS JOIN LATERAL (SELECT candidates.*,row_number() OVER(ORDER BY candidates."createdAt",candidates.id) AS opportunity FROM (
        SELECT DISTINCT ON (a.account) j.id,j."postId",j.platform,j.lease,j.phase,j."workerToken",j."createdAt"
        FROM "PublishingJob" j JOIN "CalendarPost" p ON p.id=j."postId" JOIN "SocialCalendar" c ON c.id=p."calendarId"
        CROSS JOIN LATERAL (SELECT COALESCE(j."accountId",CASE WHEN j.platform='TIKTOK' THEN p."tikTokConsentAccountId" ELSE
          (SELECT s."platformAccountId" FROM "SocialConnection" s WHERE s."calendarId"=p."calendarId" AND s.platform=j.platform AND s.status='CONNECTED' ORDER BY s.id LIMIT 1) END,
          CASE WHEN j.platform='INSTAGRAM' THEN c."instagramAccountId" END,p.id) AS account) a
        WHERE j.platform=r.platform AND j."availableAt"<=clock_timestamp() AND (j.phase='READY' OR j.phase='PREPARED' AND j."workerUntil"<=clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM "PublishingConsumerLease" x WHERE x.id=j."consumerSlot" AND x.owner=j."consumerOwner" AND x.epoch=j."consumerEpoch" AND x."leaseUntil">clock_timestamp()))
          AND NOT EXISTS(SELECT 1 FROM "PublishingAccountLease" l WHERE l.platform=j.platform AND l."accountId"=a.account AND l."leaseUntil">clock_timestamp())
        ORDER BY a.account,j."createdAt",j.id) candidates ORDER BY candidates."createdAt",candidates.id LIMIT 2) j
      ORDER BY j.opportunity,r.n`);
  }
  async function prepare(job: DurableJob, token: string, consumer?: ConsumerLease) {
    field(job.platform);
    return prepareMany([{ id: job.id, token }], consumer);
  }
  async function beginExternal(job: DurableJob, token: string, consumer?: ConsumerLease, accountId?: string, tikTokInit = false) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#beginExternal@243"); } /* end-canonical-integration-boundary */

    const status = field(job.platform);
    return transition<{ id: string }[]>(Prisma.sql`WITH locked AS MATERIALIZED (SELECT * FROM "PublishingJob" WHERE id=${job.id} FOR UPDATE),
      stamp AS (SELECT date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC') AS started),marked AS (
      UPDATE "CalendarPost" p SET "publishWorkerStartedAt"=stamp.started,"tikTokInitStartedAt"=CASE WHEN ${tikTokInit} AND p.platform='TIKTOK' THEN stamp.started ELSE p."tikTokInitStartedAt" END FROM locked j,stamp
      WHERE ${consumerGuard(consumer)} AND j.id=${job.id} AND j.phase='PREPARED' AND j."workerToken"=${token} AND (j."workerUntil">clock_timestamp() OR EXISTS(SELECT 1 FROM "PublishingConsumerLease" c WHERE c.id=j."consumerSlot" AND c.owner=j."consumerOwner" AND c.epoch=j."consumerEpoch" AND c."leaseUntil">clock_timestamp()))
        AND p.id=j."postId" AND p.platform=j.platform AND p."updatedAt"=j.lease AND p.${status}='PUBLISHING'
        AND p."approvalStatus"='APPROVED' AND NOT p."isAiDraft" AND p."publishWorkerStartedAt" IS NULL AND (NOT ${tikTokInit} OR p."tikTokInitStartedAt" IS NULL) RETURNING p.id)
      UPDATE "PublishingJob" SET phase='EXTERNAL_PENDING',"accountId"=COALESCE(${accountId ?? null},"accountId"),"startedAt"=stamp.started,"workerUntil"=clock_timestamp()+interval '14 minutes',"updatedAt"=clock_timestamp() FROM stamp
      WHERE id=${job.id} AND "workerToken"=${token} AND EXISTS(SELECT 1 FROM marked) RETURNING id`, consumer);
  }
  async function finish(job: DurableJob, token: string, remoteId: string, reportingComplete = false) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#finish@254"); } /* end-canonical-integration-boundary */

    if (!remoteId) throw new Error("Provider confirmation required");
    const status = field(job.platform);
    return transition(Prisma.sql`WITH saved AS (UPDATE "PublishingJob" SET phase='CONFIRMED',"remoteId"=${remoteId},"reportingPending"=NOT ${reportingComplete},"updatedAt"=clock_timestamp()
      WHERE id=${job.id} AND "workerToken"=${token} AND (phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN')
        OR phase='PREPARED' AND EXISTS(SELECT 1 FROM "CalendarPost" p WHERE p.id="PublishingJob"."postId" AND p.platform="PublishingJob".platform AND p.${status}='PUBLISHED')) RETURNING id,"postId",platform,"startedAt"),
      changed AS (UPDATE "CalendarPost" p SET ${status}='PUBLISHED' FROM saved s WHERE p.id=s."postId" AND p.platform=s.platform
        AND p."publishWorkerStartedAt"=s."startedAt" AND p.${status}='PUBLISHING' RETURNING p.id)
      SELECT s.id FROM saved s WHERE EXISTS(SELECT 1 FROM changed) OR EXISTS(SELECT 1 FROM "CalendarPost" p WHERE p.id=s."postId" AND p.platform=s.platform AND p.${status}='PUBLISHED')`);
  }
  async function failProvider(job: DurableJob, reference: string, reason: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#failProvider@264"); } /* end-canonical-integration-boundary */

    if(job.platform!=="TIKTOK" || !reference || !job.workerToken) throw new Error("Known TikTok operation required");
    // Definitive provider failure is terminal, not a retry. Retain the operation
    // ID so the existing authorization flow requires a NEW approved post.
    return query<{id:string}[]>(Prisma.sql`WITH saved AS (UPDATE "PublishingJob" SET phase='REJECTED',"lastError"=${reason.slice(0,1000)},"updatedAt"=clock_timestamp()
      WHERE id=${job.id} AND "workerToken"=${job.workerToken} AND "remoteId"=${reference} AND phase IN ('PROVIDER_PENDING','OUTCOME_UNKNOWN') AND confirmation IS NULL RETURNING id,"postId")
      UPDATE "CalendarPost" p SET "tikTokPublishStatus"='FAILED',"tikTokPublishError"=${reason.slice(0,1000)} FROM saved s
      WHERE p.id=s."postId" AND p."tikTokPublishId"=${reference} AND p."tikTokPublishStatus"='PUBLISHING' RETURNING s.id`);
  }
  async function accept(job: DurableJob, token: string, reference: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#accept@273"); } /* end-canonical-integration-boundary */

    if (!reference) throw new Error("Provider reference required");
    return transition<{ id: string }[]>(Prisma.sql`WITH saved AS (UPDATE "PublishingJob" SET phase='PROVIDER_PENDING',"remoteId"=${reference},"updatedAt"=clock_timestamp()
      WHERE id=${job.id} AND "workerToken"=${token} AND phase IN ('EXTERNAL_PENDING','PREPARED') RETURNING id,"postId",platform),
      checkpoint AS (UPDATE "CalendarPost" p SET "tikTokPublishId"=${reference} FROM saved s WHERE p.id=s."postId" AND s.platform='TIKTOK' AND (p."tikTokPublishId" IS NULL OR p."tikTokPublishId"=${reference}) RETURNING p.id)
      SELECT id FROM saved`);
  }
  async function unknown(job: DurableJob, token: string, reference?: string | null, proof?: PublicationProof) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#unknown@280"); } /* end-canonical-integration-boundary */

    const status = field(job.platform);
    // One bounded autocommit CTE uses the reserved coordination lane even when
    // every heavy data slot is busy, preserving known references for recovery.
    return query(Prisma.sql`WITH held AS (UPDATE "PublishingJob" SET phase='OUTCOME_UNKNOWN',"remoteId"=COALESCE(${reference ?? null},"remoteId"),"confirmation"=COALESCE(${proof ? JSON.stringify(proof) : null}::jsonb,"confirmation"),"updatedAt"=clock_timestamp() WHERE id=${job.id} AND "workerToken"=${token} AND phase IN ('EXTERNAL_PENDING','PREPARED') RETURNING "postId",platform,"startedAt")
      UPDATE "CalendarPost" p SET ${status}='PUBLISHING' FROM held h WHERE p.id=h."postId" AND p.platform=h.platform AND p."publishWorkerStartedAt" IS NOT DISTINCT FROM h."startedAt" AND p.${status}<>'PUBLISHED' RETURNING p.id`);
  }
  async function reject(job: DurableJob, token: string, message: string, retry = false, resetTikTokInit = false) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#reject@287"); } /* end-canonical-integration-boundary */

    const status = field(job.platform);
    // Known-no-send / definite rejection is a short durable coordination write.
    // It must remain available when all heavy slots are busy; otherwise native
    // temporary failure status can outlive an abandoned PREPARED claim.
    return query(Prisma.sql`WITH locked AS MATERIALIZED (SELECT * FROM "PublishingJob" WHERE id=${job.id} FOR UPDATE),
      eligible AS (SELECT * FROM locked WHERE "workerToken"=${token} AND phase IN ('PREPARED','EXTERNAL_PENDING')),
      changed AS (UPDATE "CalendarPost" p SET ${status}=${retry ? "PUBLISHING" : "FAILED"}::${Prisma.raw(job.platform === "TIKTOK" ? '"TikTokPublishStatus"' : '"InstagramPublishStatus"')},
        "publishWorkerStartedAt"=NULL,"tikTokInitStartedAt"=CASE WHEN ${resetTikTokInit} AND p.platform='TIKTOK' AND p."tikTokPublishId" IS NULL THEN NULL ELSE p."tikTokInitStartedAt" END,
        "updatedAt"=GREATEST(date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC'),p."updatedAt"+interval '1 millisecond')
        FROM eligible e WHERE p.id=e."postId" AND p.platform=e.platform AND p.${status}<>'PUBLISHED'
          AND (e.phase='PREPARED' AND p."updatedAt"=e.lease OR e.phase='EXTERNAL_PENDING' AND (p."publishWorkerStartedAt"=e."startedAt" OR p."publishWorkerStartedAt" IS NULL)) RETURNING p.id,p."updatedAt")
      UPDATE "PublishingJob" j SET phase=${retry ? "READY" : "REJECTED"},lease=c."updatedAt","workerToken"=NULL,"workerUntil"=NULL,"startedAt"=NULL,
        "availableAt"=clock_timestamp()+interval '1 minute',"attempts"="attempts"+1,"lastError"=${message.slice(0,1000)},"updatedAt"=clock_timestamp()
      FROM changed c WHERE j.id=${job.id} AND j."postId"=c.id RETURNING j.id`);
  }
  async function reconciliationJobs(limit = 20) {
    return query<(DurableJob & { remoteId: string | null })[]>(Prisma.sql`SELECT id,"postId",platform,lease,phase,"workerToken","remoteId","accountId","confirmation" FROM "PublishingJob"
      WHERE phase IN ('PROVIDER_PENDING','OUTCOME_UNKNOWN') AND "availableAt"<=clock_timestamp()
        AND ("reconcileOwner" IS NULL OR "reconcileUntil"<=clock_timestamp()) ORDER BY "updatedAt",id LIMIT ${limit}`);
  }
  async function claimReconciliation(id: string, owner: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#claimReconciliation@308"); } /* end-canonical-integration-boundary */

    const rows = await query<DurableJob[]>(Prisma.sql`UPDATE "PublishingJob" SET "reconcileOwner"=${owner},"reconcileUntil"=clock_timestamp()+interval '3 minutes'
      WHERE id=${id} AND phase IN ('PROVIDER_PENDING','OUTCOME_UNKNOWN') AND "availableAt"<=clock_timestamp()
        AND ("reconcileOwner" IS NULL OR "reconcileUntil"<=clock_timestamp()) RETURNING id,"postId",platform,lease,phase,"workerToken","remoteId","accountId","confirmation"`);
    return rows[0] ?? null;
  }
  async function releaseReconciliation(id: string, owner: string, resolved: boolean) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#releaseReconciliation@314"); } /* end-canonical-integration-boundary */

    await query(Prisma.sql`UPDATE "PublishingJob" SET "reconcileOwner"=NULL,"reconcileUntil"=NULL,"availableAt"=CASE WHEN ${resolved} THEN "availableAt" WHEN phase='OUTCOME_UNKNOWN' AND "remoteId" IS NULL THEN clock_timestamp()+interval '15 minutes' ELSE clock_timestamp()+interval '1 minute' END
      WHERE id=${id} AND "reconcileOwner"=${owner}`);
  }
  async function reportingJobs(limit = 5) {
    return query<DurableJob[]>(Prisma.sql`SELECT id,"postId",platform,lease,phase,"workerToken","remoteId","accountId","confirmation" FROM "PublishingJob"
      WHERE phase='CONFIRMED' AND "reportingPending" AND "availableAt"<=clock_timestamp() ORDER BY "updatedAt",id LIMIT ${limit}`);
  }
  async function markReported(id: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#markReported@322"); } /* end-canonical-integration-boundary */
 await query(Prisma.sql`UPDATE "PublishingJob" SET "reportingPending"=false WHERE id=${id} AND phase='CONFIRMED'`); }
  async function deferReporting(id: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#deferReporting@323"); } /* end-canonical-integration-boundary */
 await query(Prisma.sql`UPDATE "PublishingJob" SET "availableAt"=clock_timestamp()+interval '5 minutes' WHERE id=${id} AND phase='CONFIRMED' AND "reportingPending"`); }
  async function assertPublication(job: DurableJob, account: string, consumer?: ConsumerLease, requireAccountLease = false) {
    const rows = await query<{ valid: boolean }[]>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM "PublishingJob" j JOIN "CalendarPost" p ON p.id=j."postId"
      JOIN "SocialCalendar" c ON c.id=p."calendarId" WHERE j.id=${job.id} AND j."workerToken"=${job.workerToken} AND j.phase='EXTERNAL_PENDING'
      AND ${consumerGuard(consumer)} AND (NOT ${requireAccountLease} OR EXISTS(SELECT 1 FROM "PublishingAccountLease" a WHERE a.platform=j.platform AND a."accountId"=${account} AND a."jobId"=j.id AND a.token=j."workerToken" AND a."leaseUntil">clock_timestamp())) AND p."approvalStatus"='APPROVED' AND NOT p."isAiDraft" AND p.platform=j.platform AND p."updatedAt"=j.lease
      AND (EXISTS(SELECT 1 FROM "SocialConnection" s WHERE s."calendarId"=p."calendarId" AND s.platform=p.platform AND s."platformAccountId"=${account} AND s.status='CONNECTED')
        OR p.platform='INSTAGRAM' AND c."instagramAccountId"=${account} AND c."instagramAccessToken" IS NOT NULL)) AS valid`);
    if (!rows[0]?.valid) throw new PublishingDeferred("Publishing permission or account changed", "PUBLISHING_FENCED");
  }
  async function acquireConsumer(owner: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#acquireConsumer@332"); } /* end-canonical-integration-boundary */

    const rows = await query<ConsumerLease[]>(Prisma.sql`WITH free AS (SELECT id FROM "PublishingConsumerLease" WHERE owner IS NULL OR "leaseUntil"<=clock_timestamp() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE "PublishingConsumerLease" c SET owner=${owner},epoch=epoch+1,"leaseUntil"=clock_timestamp()+interval '90 seconds' FROM free f WHERE c.id=f.id RETURNING c.id,c.owner,c.epoch`);
    return rows[0] ?? null;
  }
  async function consumerValid(lease: ConsumerLease) {
    const rows = await query<{ valid: boolean }[]>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM "PublishingConsumerLease" WHERE id=${lease.id} AND owner=${lease.owner} AND epoch=${lease.epoch} AND "leaseUntil">clock_timestamp()) AS valid`);
    return !!rows[0]?.valid;
  }
  async function renewConsumer(lease: ConsumerLease) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#renewConsumer@341"); } /* end-canonical-integration-boundary */

    const rows = await query(Prisma.sql`UPDATE "PublishingConsumerLease" SET "leaseUntil"=clock_timestamp()+interval '90 seconds' WHERE id=${lease.id} AND owner=${lease.owner} AND epoch=${lease.epoch} AND "leaseUntil">clock_timestamp() RETURNING id`);
    return (rows as unknown[]).length === 1;
  }
  async function releaseConsumer(lease: ConsumerLease) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#releaseConsumer@345"); } /* end-canonical-integration-boundary */

    await query(Prisma.sql`UPDATE "PublishingConsumerLease" SET owner=NULL,"leaseUntil"=NULL WHERE id=${lease.id} AND owner=${lease.owner} AND epoch=${lease.epoch}`);
  }
  async function wakeNeeded() {
    const rows = await query<{ needed: boolean }[]>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM "PublishingJob" j WHERE "availableAt"<=clock_timestamp() AND (phase IN ('READY','PROVIDER_PENDING','OUTCOME_UNKNOWN') OR phase='CONFIRMED' AND "reportingPending" OR phase='PREPARED' AND "workerUntil"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PublishingConsumerLease" c WHERE c.id=j."consumerSlot" AND c.owner=j."consumerOwner" AND c.epoch=j."consumerEpoch" AND c."leaseUntil">clock_timestamp()))) AS needed`);
    return !!rows[0]?.needed;
  }
  async function requestWake() {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#requestWake@352"); } /* end-canonical-integration-boundary */

    await query(Prisma.sql`UPDATE "PublishingWake" SET pending=true,generation=generation+1 WHERE id=1`);
  }
  async function takeWake(owner: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#takeWake@355"); } /* end-canonical-integration-boundary */

    const rows = await query<{ generation: bigint }[]>(Prisma.sql`UPDATE "PublishingWake" SET "deliveryOwner"=${owner},"deliveryUntil"=clock_timestamp()+interval '10 seconds'
      WHERE id=1 AND pending AND "sendAt"<=clock_timestamp() AND ("deliveryOwner" IS NULL OR "deliveryUntil"<=clock_timestamp()) RETURNING generation`);
    return rows[0] ?? null;
  }
  async function dispatchedWake(owner: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#dispatchedWake@360"); } /* end-canonical-integration-boundary */

    // HTTP acknowledgement is not proof that a worker ran. Keep pending until
    // an actual admitted consumer acknowledges that generation.
    await query(Prisma.sql`UPDATE "PublishingWake" SET "deliveryOwner"=NULL,"deliveryUntil"=NULL,"sendAt"=clock_timestamp()+interval '1 minute',attempts=attempts+1 WHERE id=1 AND "deliveryOwner"=${owner}`);
  }
  async function acknowledgeWake(generation: bigint) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#acknowledgeWake@365"); } /* end-canonical-integration-boundary */

    await query(Prisma.sql`UPDATE "PublishingWake" SET pending=false WHERE id=1 AND generation=${generation}`);
  }
  async function cancelBeforeExternal(id: string, rescheduleAt?: Date) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#cancelBeforeExternal@368"); } /* end-canonical-integration-boundary */

    if (rescheduleAt && (!Number.isFinite(rescheduleAt.getTime()) || rescheduleAt.getTime() <= Date.now())) throw new Error("Future schedule required");
    // Resolve canonical platform first, then serialize on the same job row used
    // by beginExternal. Once the external boundary commits cancellation is unsafe.
    const job = await findJob(id);
    if (!job) return false;
    const status = field(job.platform);
    const rows = await budget("worker", tx => tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      WITH locked AS MATERIALIZED (SELECT * FROM "PublishingJob" WHERE id=${id} FOR UPDATE),
      cancelled AS (UPDATE "PublishingJob" j SET phase='CANCELLED',"updatedAt"=clock_timestamp()
        FROM locked l WHERE j.id=l.id AND l.phase IN ('READY','PREPARED') RETURNING j."postId",j.platform,j.lease),
      changed AS (UPDATE "CalendarPost" p SET ${status}=${rescheduleAt ? "SCHEDULED" : "NOT_SCHEDULED"}::${Prisma.raw(job.platform === "TIKTOK" ? '"TikTokPublishStatus"' : '"InstagramPublishStatus"')},
        "postDate"=COALESCE(${rescheduleAt ?? null}::timestamp,p."postDate"),"publishWorkerStartedAt"=NULL,
        "updatedAt"=GREATEST(date_trunc('milliseconds',clock_timestamp() AT TIME ZONE 'UTC'),p."updatedAt"+interval '1 millisecond')
        FROM cancelled c WHERE p.id=c."postId" AND p.platform=c.platform AND p."updatedAt"=c.lease
          AND p.${status}='PUBLISHING' AND p."publishWorkerStartedAt" IS NULL RETURNING p.id)
      SELECT id FROM changed`));
    return rows.length === 1;
  }
  async function recoverExpired() {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#recoverExpired@387"); } /* end-canonical-integration-boundary */

    // PREPARED is safe to resume: protocol forbids any provider call in that state.
    // EXTERNAL_PENDING is never returned to READY, even after a process crashes.
    await query(Prisma.sql`UPDATE "PublishingJob" SET phase='OUTCOME_UNKNOWN',"updatedAt"=clock_timestamp() WHERE phase='EXTERNAL_PENDING' AND "workerUntil"<=clock_timestamp()`);
    await query(Prisma.sql`WITH stale AS (UPDATE "PublishingJob" j SET phase='CANCELLED',"updatedAt"=clock_timestamp(),"lastError"='Post deleted, revised, unscheduled or approval changed before publishing'
      WHERE (j.phase='READY' OR j.phase='PREPARED' AND j."workerUntil"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PublishingConsumerLease" c WHERE c.id=j."consumerSlot" AND c.owner=j."consumerOwner" AND c.epoch=j."consumerEpoch" AND c."leaseUntil">clock_timestamp())) AND NOT EXISTS(
        SELECT 1 FROM "CalendarPost" p WHERE p.id=j."postId" AND p.platform=j.platform AND p."updatedAt"=j.lease AND p."approvalStatus"='APPROVED' AND NOT p."isAiDraft"
          AND p."publishWorkerStartedAt" IS NULL AND CASE WHEN p.platform='INSTAGRAM' THEN p."instagramPublishStatus"::text WHEN p.platform='TIKTOK' THEN p."tikTokPublishStatus"::text ELSE p."publishStatus"::text END='PUBLISHING')
      RETURNING j.id,j."postId",j.platform),
      revised AS (SELECT p.id,p.platform FROM "CalendarPost" p JOIN stale s ON s."postId"=p.id AND s.platform=p.platform
        WHERE p."publishWorkerStartedAt" IS NULL AND NOT EXISTS(SELECT 1 FROM "PublishingJob" j WHERE j."postId"=p.id AND j.platform=p.platform AND j.phase NOT IN ('CANCELLED','REJECTED') AND j.id NOT IN (SELECT id FROM stale)))
      UPDATE "CalendarPost" p SET "instagramPublishStatus"=CASE WHEN p.platform='INSTAGRAM' AND p."instagramPublishStatus"='PUBLISHING' THEN 'SCHEDULED'::"InstagramPublishStatus" ELSE p."instagramPublishStatus" END,
        "tikTokPublishStatus"=CASE WHEN p.platform='TIKTOK' AND p."tikTokPublishStatus"='PUBLISHING' THEN 'SCHEDULED'::"TikTokPublishStatus" ELSE p."tikTokPublishStatus" END,
        "publishStatus"=CASE WHEN p.platform NOT IN ('INSTAGRAM','TIKTOK') AND p."publishStatus"='PUBLISHING' THEN 'SCHEDULED'::"InstagramPublishStatus" ELSE p."publishStatus" END FROM revised r WHERE p.id=r.id`);
  }
  async function authorizeKnownRejectedRetry(postId: string, actor: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/reliableStore.ts#authorizeKnownRejectedRetry@402"); } /* end-canonical-integration-boundary */

    if (!actor || actor.length > 200) throw new Error("Authenticated retry actor required");
    // Only a definitive/preflight rejection can become a new intent. Neither a
    // pending operation nor an uncertain outcome can be cleared by a checkbox.
    return budget("worker", tx => tx.$queryRaw<{ id: string }[]>(Prisma.sql`UPDATE "PublishingJob" SET phase='CANCELLED',"lastError"=COALESCE("lastError",'')||${' | Explicit retry authorized by '+actor},"updatedAt"=clock_timestamp()
      WHERE "postId"=${postId} AND phase='REJECTED' AND "remoteId" IS NULL AND "confirmation" IS NULL
        AND NOT EXISTS(SELECT 1 FROM "PublishingJob" j WHERE j."postId"=${postId} AND j.phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN','CONFIRMED')) RETURNING id`));
  }
  async function backlog() {
    return query(Prisma.sql`SELECT platform,phase,count(*)::integer AS jobs,min("createdAt") AS "oldestAt" FROM "PublishingJob" GROUP BY platform,phase ORDER BY platform,phase`);
  }
  return { leader, scheduledWorkExists, recoverLeader, releaseLeader, budget, admit, recoverAdmission, ready, readyFair, readyFairAccounts, readLiveAuthorization, reserveTikTokRate, acquireAccount, releaseAccount, recoverAccountLeases, nextWorkDelay, prepare, prepareMany, recoverPrepared, releasePrepared, beginExternal, accept, failProvider, finish, unknown, reject, reconciliationJobs, claimReconciliation, releaseReconciliation, reportingJobs, markReported, deferReporting, assertPublication, acquireConsumer, consumerValid, renewConsumer, releaseConsumer, wakeNeeded, requestWake, takeWake, dispatchedWake, acknowledgeWake, cancelBeforeExternal, recoverExpired, authorizeKnownRejectedRetry, findJob, findJobs, backlog };
}
export type ReliablePublishingStore = ReturnType<typeof createReliablePublishingStore>;
