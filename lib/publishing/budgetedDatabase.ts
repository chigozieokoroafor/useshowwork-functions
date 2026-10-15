import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { ReliablePublishingStore } from "./reliableStore";
import { currentPublishingSignal, currentPublishingPostId, currentPublishingOwner } from "./executionContext";
import { PublishingDatabaseGate } from "./batchScheduler";

/** All native publisher reads/writes enter the same distributed budget. Joining
 * a short explicit unit of work saves round trips without holding slots over
 * provider publishing/media IO. The original TikTok refresh callback retains its
 * account lock and bounded 40s transaction; other platforms still have slots. */
export function createBudgetedPublishingDatabase(store: ReliablePublishingStore, profiling: { observe?: (event: { kind: string; durationMs: number }) => void } = {}) {
  type Frame = { tx: Prisma.TransactionClient; events: { model: PropertyKey; operation: string; value: unknown }[] };
  const current = new AsyncLocalStorage<Frame>();
  const entry = new PublishingDatabaseGate(2);
  const published = new Map<string, string>(), reported = new Set<string>();
  const intentions = new Map<string, Record<string, string>>();
  const transientFailures = new Set<string>();
  function committed(event: Frame["events"][number]) {
    const value = event.value as Record<string, unknown>;
    if (event.model === "calendarPost" && ["update", "upsert"].includes(event.operation) && typeof value?.id === "string") {
      const status = value.platform === "INSTAGRAM" ? value.instagramPublishStatus : value.platform === "TIKTOK" ? value.tikTokPublishStatus : value.publishStatus;
      const reference = value.platform === "INSTAGRAM" ? value.instagramMediaId : value.platform === "TIKTOK" ? value.tikTokPublishId : value.platformPostId;
      if (status === "PUBLISHED" && typeof reference === "string") published.set(value.id, reference);
    }
    if (event.model === "publishedSocialPost" && value?.status === "PUBLISHED" && typeof value.calendarPostId === "string") reported.add(value.calendarPostId);
  }
  async function transaction<T>(action: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T> {
    currentPublishingSignal()?.throwIfAborted();
    const joined = current.getStore();
    if (joined) return action(joined.tx);
    const events: Frame["events"] = [];
    const queuedAt = Date.now();
    const value = await entry.run(async () => {
      profiling.observe?.({ kind: "localEntryWait", durationMs: Date.now() - queuedAt });
      const deadline = Date.now() + 30_000;
      for (;;) {
        currentPublishingSignal()?.throwIfAborted();
        try { return await store.budget("worker", async tx => {
          const owner = currentPublishingOwner();
          if (owner) {
            const rows = await tx.$queryRaw(Prisma.sql`SELECT j.id FROM "PublishingJob" j JOIN "CalendarPost" p ON p.id=j."postId"
              WHERE j.id=${owner.id} AND j."workerToken"=${owner.token} AND j.phase IN ('PREPARED','EXTERNAL_PENDING')
                AND (j.phase<>'PREPARED' OR p."updatedAt"=j.lease) FOR SHARE OF j`);
            if (!(rows as unknown[]).length) throw Object.assign(new Error("Native publisher ownership changed"), { code: "PUBLISHING_FENCED" });
          }
          return current.run({ tx, events }, () => action(tx));
        }, undefined, { ...options, timeout: options?.timeout ?? 5000 }); }
        catch (error) {
          const postId = currentPublishingPostId(), code = (error as { code?: string }).code ?? "";
          // Retry only a slot refusal before the callback runs. Ambiguous commits
          // and native DB errors are never blindly replayed here.
          if (code !== "PUBLISHING_DEFERRED" || Date.now() >= deadline) {
            if (postId && (/^P\d{4}$/.test(code) || code === "PUBLISHING_DEFERRED")) transientFailures.add(postId);
            throw error;
          }
          const waitingAt = Date.now();
          await new Promise(resolve => setTimeout(resolve, 1000));
          profiling.observe?.({ kind: "capacityBackoff", durationMs: Date.now() - waitingAt });
        }
      }
    });
    for (const event of events) committed(event);
    return value;
  }
  const models = new Map<PropertyKey, unknown>();
  const database = new Proxy({}, {
    get(_target, model) {
      if (model === "$transaction") return (action: unknown, options?: { maxWait?: number; timeout?: number }) => {
        if (typeof action !== "function") throw new Error("Publishing requires callback transactions");
        return transaction(action as (tx: Prisma.TransactionClient) => Promise<unknown>, { ...options, timeout: options?.timeout ?? 5000 });
      };
      if (typeof model === "string" && model.startsWith("$")) {
        if (!["$queryRaw", "$executeRaw"].includes(model)) throw new Error("Unsupported publishing database operation");
        return (...args: unknown[]) => transaction(tx => (tx[model as "$queryRaw"] as Function)(...args));
      }
      if (!models.has(model)) models.set(model, new Proxy({}, { get(_delegate, operation) {
        if (typeof operation !== "string" || !/^(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|count|create|createMany|update|updateMany|upsert|delete|deleteMany|aggregate|groupBy)$/.test(operation)) throw new Error("Unsupported publishing model operation");
        return (...args: unknown[]) => {
          currentPublishingSignal()?.throwIfAborted();
          if (model === "calendarPost" && operation === "update") {
            const input = args[0] as { where?: { id?: string }; data?: Record<string, unknown> };
            if (input.where?.id && Object.entries(input.data ?? {}).some(([key,value]) => /PublishStatus$|^publishStatus$/.test(key) && value === "PUBLISHED")) {
              const keys = new Set(["instagramPublishStatus","instagramPublishedAt","instagramMediaId","instagramPermalink","tikTokPublishStatus","tikTokPublishedAt","tikTokPublishId","publishStatus","publishedAt","platformPostId","publishPermalink"]);
              const data = Object.fromEntries(Object.entries(input.data!).filter(([key,value]) => keys.has(key) && (typeof value === "string" || value instanceof Date)).map(([key,value])=>[key,value instanceof Date?value.toISOString():value as string]));
              intentions.set(input.where.id, data);
            }
          }
          return transaction(async tx => {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/budgetedDatabase.ts#transaction:callback@88"); } /* end-canonical-integration-boundary */

          currentPublishingSignal()?.throwIfAborted();
          const delegate = (tx as unknown as Record<PropertyKey, Record<string, Function>>)[model];
          if (!delegate || typeof delegate[operation] !== "function") throw new Error("Unknown publishing model");
          const value = await delegate[operation](...args);
          const owner = currentPublishingOwner(), row = value as { id?: string; updatedAt?: Date };
          if (owner && model === "calendarPost" && operation === "update" && row?.id === currentPublishingPostId() && row.updatedAt instanceof Date) {
            // Native pre-send error/status writes advance Prisma's updatedAt.
            // Keep that owned prepared intent synchronized in the same TX so a
            // safe temporary failure can retry rather than silently stranding it.
            await tx.$executeRaw(Prisma.sql`UPDATE "PublishingJob" SET lease=${row.updatedAt} WHERE id=${owner.id} AND "workerToken"=${owner.token} AND phase='PREPARED'`);
          }
          current.getStore()!.events.push({ model, operation, value });
          return value;
          });
        };
      } }));
      return models.get(model);
    },
  }) as PrismaClient;
  async function reportingUnit<T>(operation: () => Promise<T>): Promise<T> {
    if (!current.getStore()) return transaction(() => reportingUnit(operation));
    const frame = current.getStore()!, before = frame.events.length;
    await frame.tx.$executeRaw`SAVEPOINT publishing_reporting`;
    try { return await operation(); }
    catch (error) { await frame.tx.$executeRaw`ROLLBACK TO SAVEPOINT publishing_reporting`; frame.events.length = before; throw error; }
    finally { await frame.tx.$executeRaw`RELEASE SAVEPOINT publishing_reporting`; }
  }
  return { database, unitOfWork: <T,>(operation: () => Promise<T>) => transaction(() => operation()), reportingUnit, publishedReference: (id: string) => published.get(id), reportingComplete: (id: string) => reported.has(id), confirmationData: (id: string) => intentions.get(id), hadTransientFailure: (id: string) => transientFailures.has(id), forget(id: string) { published.delete(id); reported.delete(id); intentions.delete(id); transientFailures.delete(id); } };
}
