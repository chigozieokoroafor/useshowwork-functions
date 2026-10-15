import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import type { Prisma, PrismaClient, SocialConnection } from "@prisma/client";
import { createInstagramPublisher } from "@/lib/instagramPublishing";
import { createTikTokPublisher } from "@/lib/tiktokPublishing";
import { freshTikTokConnection, reserveTikTokRequest } from "@/lib/tiktokConnection";
import { freshConnection, requireScopes } from "@/lib/socialTokens";
import { recordPublishedSocialPost } from "@/lib/socialReporting";
import { canAccessCalendarById } from "@/lib/calendarPermissions";
import { checkTikTokPublishStatus } from "@/lib/tiktok";
import { getMediaPermalink } from "@/lib/instagram";
import { publishFacebook, publishLinkedIn, publishX } from "./providers";
import { buildCaption, publishingStatus, validatePublishContent } from "./state";
import { withPublishingExecution } from "./executionContext";
import type { DurableJob, PublicationProof, ReliablePublishingStore } from "./reliableStore";
import type { PublishingProviderResult } from "./reliableWorker";

type Post = Prisma.CalendarPostGetPayload<{ include: { assets: true; calendar: { include: { socialConnections: true } } } }>;
type Port = { database: PrismaClient; unitOfWork: <T>(operation: () => Promise<T>) => Promise<T>; reportingUnit: <T>(operation: () => Promise<T>) => Promise<T>; publishedReference: (id: string) => string | undefined; reportingComplete: (id: string) => boolean; confirmationData: (id: string) => Record<string,string> | undefined; hadTransientFailure: (id: string) => boolean; forget: (id: string) => void };
const transient = (error: unknown) => /^P\d{4}$/.test((error as { code?: string })?.code ?? "") || (error as { code?: string })?.code === "PUBLISHING_DEFERRED";
export class UncertainPublication extends Error {
  readonly code = "PUBLISHING_UNCERTAIN";
  constructor(readonly reference: string | null, readonly proof?: PublicationProof) { super("External publishing outcome requires reconciliation"); }
}

/** Same native publishing functions, with an explicit budgeted database. No
 * deployed handler imports this integration. No production credentials are read
 * from the port or returned to a caller. */
export function createPlatformIntegration(port: Port, options: { verifyPublication?: (job: DurableJob, account: string) => Promise<void>; beginPublication?: (job: DurableJob, account: string, tikTokInit: boolean) => Promise<boolean>; performance?: boolean; readAuthorization?: ReliablePublishingStore["readLiveAuthorization"]; reserveRate?: (account: string, kind: "creator" | "init" | "status") => Promise<void>; journal?: (job: DurableJob, reference: string, proof?: PublicationProof) => Promise<void> } = {}) {
  const db = port.database;
  const reconciliationSnapshots = new Map<string,{post:Post;expires:number}>();
  const snapshots = new Map<string, { post: Post; expires: number }>();
  const confirmedResults = new Map<string, Record<string, string>>();
  const prepared = new Map<string, { post: Post; connection?: SocialConnection }>();
  const executions = new Map<string, { snapshot: { post: Post; connection?: SocialConnection }; state: () => { attempted: boolean; rejected: boolean; reference: string | null } }>();
  const report = (input: Parameters<typeof recordPublishedSocialPost>[0]) => port.reportingUnit(() => recordPublishedSocialPost(input, db));
  async function readPost(id: string, platform: DurableJob["platform"]) {
    return db.calendarPost.findUniqueOrThrow({ where: { id }, include: { assets: { orderBy: { displayOrder: "asc" } }, calendar: { include: { socialConnections: { where: { platform, status: "CONNECTED" } } } } } });
  }
  async function preflight(job: DurableJob) {
    prepared.delete(job.id);
    const cachedSnapshot = snapshots.get(job.id);
    const loadSnapshot = async () => {
      const cached = snapshots.get(job.id); snapshots.delete(job.id);
      const post = cached && cached.expires > Date.now() ? cached.post : await readPost(job.postId, job.platform);
      if (post.platform !== job.platform || post.updatedAt.getTime() !== job.lease.getTime() || post.approvalStatus !== "APPROVED" || post.isAiDraft || publishingStatus(post) !== "PUBLISHING") throw new Error("Publishing approval or lease changed");
      validatePublishContent(job.platform, post.assets, buildCaption(post), post.postType);
      if (job.platform === "TIKTOK" && post.tikTokInitStartedAt && !post.tikTokPublishId) throw new UncertainPublication(null);
      if ((!cached || cached.expires <= Date.now()) && !await canAccessCalendarById(post.calendarId, db)) throw new Error("This workspace is no longer active. Renew access before publishing.");
      return { post, connection: post.calendar.socialConnections.find(c => c.platform === job.platform && c.status === "CONNECTED") };
    };
    const snapshot = cachedSnapshot && cachedSnapshot.expires > Date.now() ? await loadSnapshot() : await port.unitOfWork(loadSnapshot);
    if (!["INSTAGRAM", "TIKTOK"].includes(job.platform)) {
      if (!snapshot.connection) throw new Error("Connect this channel before publishing.");
      // OAuth IO happens after releasing the read snapshot transaction.
      snapshot.connection = await freshConnection(snapshot.connection, db);
    }
    prepared.set(job.id, snapshot);
    const accountId = job.platform === "TIKTOK" ? snapshot.post.tikTokConsentAccountId : snapshot.connection?.platformAccountId ?? snapshot.post.calendar.instagramAccountId;
    if (!accountId) throw new Error("Publishing account unavailable");
    return { accountId };
  }
  async function preflightMany(jobs: DurableJob[]) {
    if (!options.performance || !jobs.length || jobs.length > 5) return;
    const posts = await port.unitOfWork(async () => {
      const rows = await db.calendarPost.findMany({ where: { id: { in: jobs.map(j=>j.postId) } },
        include: { assets: { orderBy: { displayOrder: "asc" } }, calendar: { include: { socialConnections: { where: { status: "CONNECTED" } } } } } });
      const permitted = new Set<string>();
      for (const calendarId of new Set(rows.map(p=>p.calendarId))) if (await canAccessCalendarById(calendarId,db)) permitted.add(calendarId);
      return rows.filter(p=>permitted.has(p.calendarId));
    });
    for (const job of jobs) { const post = posts.find(p=>p.id===job.postId); if (post) snapshots.set(job.id,{post:{...post,calendar:{...post.calendar,socialConnections:post.calendar.socialConnections.filter(c=>c.platform===job.platform)}},expires:Date.now()+30_000}); }
  }
  async function publish(job: DurableJob, signal: AbortSignal): Promise<PublishingProviderResult> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/platformIntegration.ts#publish@72"); } /* end-canonical-integration-boundary */

    const snapshot = prepared.get(job.id);
    if (!snapshot) throw new Error("Platform preflight required");
    let attempted = false, rejected = false, reference: string | null = null;
    let begun = false, beginDeferred = false;
    let journaled: PublishingProviderResult | undefined;
    async function complete(operation: () => Promise<void>) {
      if (!options.performance || !options.journal) return port.unitOfWork(operation);
      const proof = knownProof(job);
      if (!proof) throw new UncertainPublication(reference);
      await options.journal(job, proof.reference, proof);
      journaled = { state: "finalization-pending", reference: proof.reference };
    }
    const account = job.platform === "TIKTOK" ? snapshot.post.tikTokConsentAccountId : snapshot.connection?.platformAccountId ?? snapshot.post.calendar.instagramAccountId;
    async function begin(tikTokInit = false) {
      if (begun || !options.beginPublication) return true;
      try {
        if (!account || !await options.beginPublication(job, account, tikTokInit)) throw Object.assign(new Error("Publishing lease changed before sending"), { code: "PUBLISHING_FENCED" });
      } catch (error) { beginDeferred = (error as { code?: string }).code === "PUBLISHING_DEFERRED"; throw error; }
      begun = true; return true;
    }
    executions.set(job.id, { snapshot, state: () => ({ attempted, rejected, reference }) });
    try {
      return await withPublishingExecution({ signal, postId: job.postId, jobId: job.id, workerToken: job.workerToken, async beforePublication() {
        if (!account) throw new Error("Publishing account unavailable");
        if (options.performance) {
          // Snapshot data is never authority to send. Recheck real workspace
          // policy and the exact connection immediately before the create/init.
          const live = options.readAuthorization ? await options.readAuthorization(job,snapshot.connection?.id) : null;
          if (live && live.calendarId !== snapshot.post.calendarId) throw new Error("Publishing workspace changed");
          const validate = async () => {
            // Evaluate the SAME entitlement policy against the current fixed
            // snapshot, including trial/complimentary expiry and workspace rank.
            const authorizationDb = live ? {socialCalendar:{
              findUnique:async()=>({managerId:live.manager.id,manager:live.manager}),
              findMany:async(input:{take:number})=>live.workspaceOrdinal<=input.take?[{id:live.calendarId}]:[],
            }} as unknown as PrismaClient : db;
            if (!await canAccessCalendarById(snapshot.post.calendarId,authorizationDb)) throw new Error("Workspace access revoked before publishing");
            if (snapshot.connection) {
              const current = live ? live.connection as unknown as SocialConnection | null : await db.socialConnection.findUniqueOrThrow({where:{id:snapshot.connection.id}});
              if (!current) throw new Error("Publishing connection removed");
              if (current.status !== "CONNECTED" || current.platformAccountId !== account || current.calendarId !== snapshot.post.calendarId || current.platform !== job.platform) throw new Error("Publishing connection changed");
              if (job.platform !== "TIKTOK" && (current.accessToken !== snapshot.connection.accessToken || current.tokenScopes !== snapshot.connection.tokenScopes)) throw Object.assign(new Error("Publishing token changed; refresh preflight"),{code:"PUBLISHING_DEFERRED"});
              if (job.platform === "TIKTOK") requireScopes(current,["video.publish"]);
              if (!current.accessToken || current.accessTokenExpiresAt && current.accessTokenExpiresAt.getTime() <= Date.now()) throw new Error("Publishing token expired");
            } else {
              const current = live ? live.legacy as unknown as Post["calendar"] : await db.socialCalendar.findUniqueOrThrow({where:{id:snapshot.post.calendarId}});
              if (job.platform !== "INSTAGRAM" || current.instagramAccountId !== account || current.instagramAccessToken !== snapshot.post.calendar.instagramAccessToken || current.instagramTokenExpiresAt && current.instagramTokenExpiresAt.getTime() <= Date.now()) throw new Error("Instagram connection changed");
            }
          };
          if (live) await validate(); else await port.unitOfWork(validate);
        }
        await begin();
        await options.verifyPublication?.(job, account);
        signal.throwIfAborted(); attempted = true; rejected = false;
      }, publicationResponse(value) { rejected = value.rejected; if (value.reference && !value.rejected && value.status < 300) reference = value.reference; } }, async () => {
        const post = snapshot.post;
        if (job.platform === "INSTAGRAM") {
          await createInstagramPublisher(db, report, async () => post, complete, data => confirmedResults.set(job.id, data))(post.id);
        } else if (job.platform === "TIKTOK") {
          await createTikTokPublisher(db, {
            freshTikTokConnection: connection => freshTikTokConnection(connection, db, true),
            reserveTikTokRequest: options.reserveRate ?? ((account, kind) => reserveTikTokRequest(account, kind, db, true)),
            recordPublishedSocialPost: report,
            complete,
            preloadedConnection: options.performance ? snapshot.connection : undefined,
            liveConnectionGuard: !!options.performance,
            deferAcceptance: options.performance && options.journal ? async id => {
              reference = id; await options.journal!(job,id);
              journaled = { state: "accepted", reference: id, durable: true };
            } : undefined,
            onConfirmed: data => confirmedResults.set(job.id, data),
            claimInit: options.beginPublication ? () => begin(true) : undefined,
          }, async () => post)(post.id);
        } else {
          const connection = snapshot.connection!;
          const execute = job.platform === "FACEBOOK" ? publishFacebook : job.platform === "LINKEDIN" ? publishLinkedIn : publishX;
          const result = await execute(post, connection, async id => { await db.calendarPost.update({ where: { id: post.id }, data: { platformPostId: id } }); });
          reference = result.id;
          const publishedAt = new Date();
          confirmedResults.set(job.id, { publishStatus: "PUBLISHED", publishedAt: publishedAt.toISOString(), platformPostId: result.id, ...(result.permalink ? { publishPermalink: result.permalink } : {}) });
          await complete(async () => {
            await db.calendarPost.update({ where: { id: post.id }, data: { publishStatus: "PUBLISHED", publishedAt, platformPostId: result.id, publishPermalink: result.permalink, publishError: null } });
            try { await report({ calendarId: post.calendarId, calendarPostId: post.id, platform: job.platform, platformAccountId: connection.platformAccountId, platformPostId: result.id, permalink: result.permalink, publishedAt, platformPostType: post.postType }); }
            catch { /* Savepoint protects confirmed status from reporting failure. */ }
          });
        }
        if (journaled) return journaled;
        const committedReference = port.publishedReference(post.id);
        if (committedReference) return { state: "published", reference: committedReference, reportingComplete: port.reportingComplete(post.id) };
        const saved = await db.calendarPost.findUniqueOrThrow({ where: { id: post.id } });
        if (publishingStatus(saved) === "PUBLISHED") {
          const id = job.platform === "INSTAGRAM" ? saved.instagramMediaId : job.platform === "TIKTOK" ? saved.tikTokPublishId : saved.platformPostId;
          if (!id) throw new UncertainPublication(reference);
          return { state: "published", reference: id, reportingComplete: port.reportingComplete(post.id) };
        }
        if (job.platform === "TIKTOK" && (saved.tikTokPublishId || reference)) {
          const proof = knownProof(job);
          if (proof) throw new UncertainPublication(saved.tikTokPublishId ?? reference, proof);
          return { state: "accepted", reference: saved.tikTokPublishId ?? reference! };
        }
        if (!attempted || rejected) return { state: beginDeferred || transientFailure(saved) || port.hadTransientFailure(job.postId) ? "retryable" : "rejected", resetTikTokInit: job.platform === "TIKTOK" && !snapshot.post.tikTokInitStartedAt && !snapshot.post.tikTokPublishId, reason: (job.platform === "TIKTOK" ? saved.tikTokPublishError : job.platform === "INSTAGRAM" ? saved.instagramPublishError : saved.publishError) ?? "Native publisher did not confirm publication" };
        throw new UncertainPublication(reference);
      });
    } catch (error) {
      if (!attempted || rejected) return { state: transient(error) || port.hadTransientFailure(job.postId) ? "retryable" : "rejected", resetTikTokInit: job.platform === "TIKTOK" && !snapshot.post.tikTokInitStartedAt && !snapshot.post.tikTokPublishId, reason: error instanceof Error ? error.message : "Native publishing failed" };
      throw new UncertainPublication(reference, knownProof(job));
    } finally { prepared.delete(job.id); }
  }
  function transientFailure(post: Awaited<ReturnType<typeof db.calendarPost.findUniqueOrThrow>>) {
    return post.platform === "TIKTOK" && post.tikTokPublishStatus === "SCHEDULED";
  }
  async function prepareReconciliation(jobs: DurableJob[]) {
    if (!jobs.length || jobs.length>5) throw new Error("Invalid reconciliation snapshot bound");
    const posts = await port.unitOfWork(()=>db.calendarPost.findMany({where:{id:{in:jobs.map(j=>j.postId)}},
      include:{assets:{orderBy:{displayOrder:"asc"}},calendar:{include:{socialConnections:{where:{status:"CONNECTED"}}}}}}));
    for(const job of jobs){const post=posts.find(p=>p.id===job.postId);if(post)reconciliationSnapshots.set(job.id,{post,expires:Date.now()+30_000});}
  }
  async function reconcile(job: DurableJob): Promise<string | { reference: string; reportingComplete: boolean } | { state: "failed"; reference: string; reason: string } | null> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/platformIntegration.ts#reconcile@190"); } /* end-canonical-integration-boundary */

    port.forget(job.postId); // Never carry a reporting receipt from an earlier job/version.
    const cached = reconciliationSnapshots.get(job.id); reconciliationSnapshots.delete(job.id);
    const post = cached && cached.expires>Date.now() ? cached.post : await readPost(job.postId, job.platform);
    if (job.confirmation && job.remoteId && job.confirmation.reference === job.remoteId && job.confirmation.accountId === job.accountId) {
      // Native PUBLISHED write intent is emitted only after the existing helper
      // confirms the remote result. Restore that metadata; never send a create.
      const keys = new Set(["instagramPublishStatus","instagramPublishedAt","instagramMediaId","instagramPermalink","tikTokPublishStatus","tikTokPublishedAt","tikTokPublishId","publishStatus","publishedAt","platformPostId","publishPermalink"]);
      const data = Object.fromEntries(Object.entries(job.confirmation.data).filter(([key,value])=>keys.has(key)&&typeof value==='string')) as Prisma.CalendarPostUpdateInput;
      if (job.platform === "TIKTOK") data.tikTokPublishId = job.remoteId;
      await port.unitOfWork(async () => {
        await db.calendarPost.update({ where: { id: post.id }, data });
        try { await report({ calendarId: post.calendarId, calendarPostId: post.id, platform: job.platform, platformAccountId: job.confirmation!.accountId, platformPostId: job.platform === "TIKTOK" ? null : job.remoteId, providerReference: job.platform === "TIKTOK" ? job.remoteId : null, permalink: data.instagramPermalink as string ?? data.publishPermalink as string, publishedAt: new Date((data.instagramPublishedAt ?? data.tikTokPublishedAt ?? data.publishedAt ?? new Date()) as string | Date), platformPostType: post.postType }); } catch { /* durable reporting retry is separate */ }
      });
      return { reference: job.remoteId, reportingComplete: port.reportingComplete(post.id) };
    }
    const existing = job.platform === "INSTAGRAM" ? post.instagramMediaId : job.platform === "TIKTOK" ? post.tikTokPublishId ?? job.remoteId : post.platformPostId ?? job.remoteId;
    if (!existing) return null;
    if (publishingStatus(post) === "PUBLISHED") return { reference: existing, reportingComplete: port.reportingComplete(post.id) };
    const connection = post.calendar.socialConnections.find(c => c.platform === job.platform && c.status === "CONNECTED");
    if (!connection?.accessToken) return null;
    // Recovery checks only known operations. There is no new init/create here.
    if (job.platform === "TIKTOK") {
      const current = await freshTikTokConnection(connection, db, true);
      if (options.reserveRate) await options.reserveRate(current.platformAccountId,"status");
      else await reserveTikTokRequest(current.platformAccountId, "status", db, true);
      const result = await checkTikTokPublishStatus(current.accessToken!, existing);
      if (result.status === "FAILED") return {state:"failed",reference:existing,reason:`TikTok could not publish this post (${result.fail_reason || "unknown_error"}). Correct the content and create a new post.`};
      if (result.status !== "PUBLISH_COMPLETE") return null;
      await port.unitOfWork(async () => {
      await db.calendarPost.update({ where: { id: post.id }, data: { tikTokPublishStatus: "PUBLISHED", tikTokPublishedAt: new Date(), tikTokPublishId: existing, tikTokPublishError: null } });
      try { await report({ calendarId: post.calendarId, calendarPostId: post.id, platform: "TIKTOK", platformAccountId: current.platformAccountId, platformPostId: result.publicaly_available_post_id?.[0] != null ? String(result.publicaly_available_post_id[0]) : null, providerReference: existing, publishedAt: new Date(), platformPostType: post.postType }); } catch { /* reporting recovery is independent */ }
      });
      return { reference: existing, reportingComplete: port.reportingComplete(post.id) };
    }
    if (job.platform === "INSTAGRAM") {
      const permalink = await getMediaPermalink(existing, connection.accessToken);
      if (!permalink) return null;
      await db.calendarPost.update({ where: { id: post.id }, data: { instagramPublishStatus: "PUBLISHED", instagramMediaId: existing, instagramPermalink: permalink, instagramPublishedAt: new Date(), instagramPublishError: null } });
      try { await report({ calendarId: post.calendarId, calendarPostId: post.id, platform: "INSTAGRAM", platformAccountId: connection.platformAccountId, platformPostId: existing, permalink, publishedAt: new Date(), platformPostType: post.postType }); } catch { /* reporting repair must not republish */ }
      return { reference: existing, reportingComplete: port.reportingComplete(post.id) };
    }
    // Facebook/LinkedIn/X ambiguous operations require a platform-specific
    // verified existing-result lookup; never call their create helpers here.
    return null;
  }
  async function repairReporting(job: DurableJob) {
    if (!job.accountId || !job.remoteId) return false;
    const post = await readPost(job.postId, job.platform);
    if (publishingStatus(post) !== "PUBLISHED") return false;
    await report({ calendarId: post.calendarId, calendarPostId: post.id, platform: job.platform, platformAccountId: job.accountId,
      platformPostId: job.platform === "TIKTOK" ? null : job.remoteId, providerReference: job.platform === "TIKTOK" ? job.remoteId : null,
      permalink: job.platform === "INSTAGRAM" ? post.instagramPermalink : post.publishPermalink,
      publishedAt: post.instagramPublishedAt ?? post.tikTokPublishedAt ?? post.publishedAt ?? new Date(), platformPostType: post.postType });
    return true;
  }
  function knownReference(job: DurableJob) { return executions.get(job.id)?.state().reference ?? undefined; }
  function knownProof(job: DurableJob): PublicationProof | undefined {
    const execution = executions.get(job.id), data = port.confirmationData(job.postId) ?? confirmedResults.get(job.id), reference = knownReference(job) ?? port.publishedReference(job.postId);
    if (!execution || !data || !reference) return undefined;
    const accountId = job.platform === "TIKTOK" ? execution.snapshot.post.tikTokConsentAccountId : execution.snapshot.connection?.platformAccountId ?? execution.snapshot.post.calendar.instagramAccountId;
    return accountId ? { accountId, reference, data } : undefined;
  }
  function abortOutcome(job: DurableJob): PublishingProviderResult | undefined {
    const execution = executions.get(job.id);
    if (!execution || execution.state().attempted || job.platform === "TIKTOK" && execution.snapshot.post.tikTokInitStartedAt) return undefined;
    if (job.platform === "TIKTOK" && execution.snapshot.post.tikTokPublishId) return { state: "accepted", reference: execution.snapshot.post.tikTokPublishId };
    return { state: "retryable", reason: "Worker stopped before a publishing request", resetTikTokInit: job.platform === "TIKTOK" };
  }
  function forget(job: DurableJob) { snapshots.delete(job.id); prepared.delete(job.id); executions.delete(job.id); confirmedResults.delete(job.id); port.forget(job.postId); }
  return { preflight, preflightMany, prepareReconciliation, publish, reconcile, repairReporting, knownProof, knownReference, abortOutcome, forget, close() { reconciliationSnapshots.clear(); snapshots.clear(); prepared.clear(); executions.clear(); confirmedResults.clear(); } };
}
