/** Stage 3A only: no global DB import, timers, provider calls or live wiring. */
export type OwnerState = "NETLIFY" | "DRAINING" | "VPS";
export type Outcome = "AUTHORIZED" | "ACCEPTED" | "CONFIRMED" | "REJECTED" | "UNKNOWN";
export class OwnershipError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OwnershipError"; }
}
export function transitionAllowed(from: OwnerState, to: OwnerState): boolean {
  return from !== to && (from === "DRAINING" || to === "DRAINING")
    && ["NETLIFY", "DRAINING", "VPS"].includes(from) && ["NETLIFY", "DRAINING", "VPS"].includes(to);
}
export function outcomeAllowed(from: Outcome, to: Outcome): boolean {
  return ["AUTHORIZED", "ACCEPTED", "UNKNOWN"].includes(from)
    && ["ACCEPTED", "CONFIRMED", "REJECTED", "UNKNOWN"].includes(to);
}
type Row = Record<string, any>;
export interface OwnershipTransaction { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }> }
// The adapter MUST resolve only after COMMIT. Errors must not be automatically retried.
export interface OwnershipDatabase {
  transaction<T>(run: (tx: OwnershipTransaction) => Promise<T>): Promise<T>;
}
function requireValue(ok: unknown, code: string): asserts ok { if (!ok) throw new OwnershipError(code); }
function identifier(value: string) { requireValue(typeof value === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(value), "INVALID_IDENTIFIER"); }

export function createPublishingOwnership(database: OwnershipDatabase) {
  async function atomic<T>(run: (tx: OwnershipTransaction) => Promise<T>) {
    try { return await database.transaction(run); }
    catch (error) { if (error instanceof OwnershipError) throw error; throw new OwnershipError("OWNERSHIP_TRANSACTION_UNCONFIRMED"); }
  }
  async function transition(input: { operationId: string; actor: string; expectedEpoch: bigint; to: OwnerState; activate?: boolean }) {
    identifier(input.operationId); identifier(input.actor);
    return atomic(async tx => {
      const owner = (await tx.query('SELECT * FROM "PublishingOwnership" WHERE id=1 FOR UPDATE')).rows[0];
      const previous = (await tx.query('SELECT * FROM "PublishingOwnershipEvent" WHERE "operationId"=$1', [input.operationId])).rows[0];
      if (previous) {
        requireValue(previous.actor === input.actor && previous.toState === input.to && BigInt(previous.epoch) === input.expectedEpoch + BigInt(1), "OPERATION_CONFLICT");
        return { epoch: BigInt(previous.epoch), replay: true };
      }
      requireValue(owner && BigInt(owner.epoch) === input.expectedEpoch, "STALE_EPOCH");
      requireValue(transitionAllowed(owner.state, input.to), "INVALID_TRANSITION");
      requireValue(owner.enabled || input.activate === true && owner.state === "DRAINING" && input.to === "NETLIFY", "OWNERSHIP_INACTIVE");
      if (input.to !== "DRAINING") {
        const unresolved = await tx.query(`SELECT id FROM "PublishingExternalAttempt" WHERE outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN') LIMIT 1`);
        requireValue(!unresolved.rows.length, "UNRESOLVED_ATTEMPTS");
        if (owner.enabled) {
          const legacy = await tx.query(`SELECT id FROM "PublishingJob" WHERE "intentId" IS NULL AND phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN') LIMIT 1`);
          requireValue(!legacy.rows.length, "UNRESOLVED_LEGACY_JOBS");
        }
      }
      const epoch = input.expectedEpoch + BigInt(1);
      await tx.query('UPDATE "PublishingOwnership" SET state=$1,epoch=$2,enabled=true WHERE id=1', [input.to, epoch.toString()]);
      await tx.query('INSERT INTO "PublishingOwnershipEvent" ("operationId","fromState","toState",epoch,actor) VALUES($1,$2,$3,$4,$5)', [input.operationId, owner.state, input.to, epoch.toString(), input.actor]);
      return { epoch, replay: false };
    });
  }
  async function createIntent(input: { id: string; postId: string; platform: string; dueAt: Date }) {
    identifier(input.id); identifier(input.postId);
    requireValue(["INSTAGRAM", "TIKTOK", "FACEBOOK", "LINKEDIN", "X"].includes(input.platform) && Number.isFinite(input.dueAt?.getTime()), "INVALID_INTENT");
    return atomic(async tx => {
      await tx.query('INSERT INTO "PublishingIntent" (id,"postId",platform,"currentRevision") VALUES($1,$2,$3,1)', [input.id, input.postId, input.platform]);
      await tx.query('INSERT INTO "PublishingIntentRevision" ("intentId",revision,"dueAt") VALUES($1,1,$2)', [input.id, input.dueAt]);
      return { id: input.id, revision: 1 };
    });
  }
  async function reviseIntent(id: string, expectedRevision: number, dueAt: Date) {
    identifier(id); requireValue(Number.isSafeInteger(expectedRevision) && expectedRevision > 0 && expectedRevision < 2147483647 && Number.isFinite(dueAt?.getTime()), "INVALID_REVISION");
    return atomic(async tx => {
      const intent = (await tx.query('SELECT * FROM "PublishingIntent" WHERE id=$1 FOR UPDATE', [id])).rows[0];
      requireValue(intent?.state === "ACTIVE" && intent.currentRevision === expectedRevision, "STALE_REVISION");
      requireValue(!(await tx.query('SELECT id FROM "PublishingExternalAttempt" WHERE "intentId"=$1', [id])).rows.length, "ATTEMPT_EXISTS");
      await tx.query('INSERT INTO "PublishingIntentRevision" ("intentId",revision,"dueAt") VALUES($1,$2,$3)', [id, expectedRevision + 1, dueAt]);
      await tx.query('UPDATE "PublishingIntent" SET "currentRevision"=$2 WHERE id=$1', [id, expectedRevision + 1]);
      return expectedRevision + 1;
    });
  }
  async function authorize(input: { attemptId: string; intentId: string; revision: number; jobId: string; owner: "NETLIFY" | "VPS"; epoch: bigint; actor: string }) {
    for (const value of [input.attemptId, input.intentId, input.jobId, input.actor]) identifier(value);
    requireValue(["NETLIFY", "VPS"].includes(input.owner), "INVALID_OWNER");
    return atomic(async tx => {
      const owner = (await tx.query('SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE')).rows[0];
      requireValue(owner?.enabled && owner.state === input.owner && BigInt(owner.epoch) === input.epoch, "OWNERSHIP_FENCED");
      const intent = (await tx.query('SELECT * FROM "PublishingIntent" WHERE id=$1 FOR UPDATE', [input.intentId])).rows[0];
      requireValue(intent?.state === "ACTIVE" && intent.currentRevision === input.revision, "STALE_REVISION");
      const existing = (await tx.query('SELECT * FROM "PublishingExternalAttempt" WHERE "intentId"=$1', [input.intentId])).rows[0];
      if (existing) {
        requireValue(existing.id === input.attemptId && existing.jobId === input.jobId && existing.actor === input.actor && existing.owner === input.owner && BigInt(existing.epoch) === input.epoch, "ATTEMPT_EXISTS");
        return { attemptId: existing.id as string, maySend: false as boolean };
      }
      const job = (await tx.query(`SELECT j.id FROM "PublishingJob" j JOIN "PublishingIntentRevision" r ON r."intentId"=j."intentId" AND r.revision=j."intentRevision"
        WHERE j.id=$1 AND j."intentId"=$2 AND j."intentRevision"=$3 AND j."ownershipEpoch"=$4 AND j.phase='PREPARED'
        AND j."postId"=$5 AND j.platform=$6 AND r."dueAt"<=clock_timestamp() FOR UPDATE OF j`, [input.jobId, input.intentId, input.revision, input.epoch.toString(), intent.postId, intent.platform])).rows[0];
      requireValue(job, "JOB_NOT_ELIGIBLE");
      await tx.query('INSERT INTO "PublishingExternalAttempt" (id,"intentId",revision,"jobId",owner,epoch,actor) VALUES($1,$2,$3,$4,$5,$6,$7)', [input.attemptId, input.intentId, input.revision, input.jobId, input.owner, input.epoch.toString(), input.actor]);
      await tx.query(`UPDATE "PublishingJob" SET phase='EXTERNAL_PENDING' WHERE id=$1`, [input.jobId]);
      return { attemptId: input.attemptId, maySend: true };
    });
  }
  async function recordOutcome(input: { operationId: string; attemptId: string; actor: string; outcome: Exclude<Outcome, "AUTHORIZED">; remoteReference?: string }) {
    for (const value of [input.operationId, input.attemptId, input.actor]) identifier(value);
    requireValue(input.remoteReference === undefined || typeof input.remoteReference === "string" && input.remoteReference.length > 0 && input.remoteReference.length <= 500, "INVALID_REFERENCE");
    return atomic(async tx => {
      const attempt = (await tx.query('SELECT * FROM "PublishingExternalAttempt" WHERE id=$1 FOR UPDATE', [input.attemptId])).rows[0];
      requireValue(attempt, "ATTEMPT_MISSING");
      const previous = (await tx.query('SELECT * FROM "PublishingAttemptEvent" WHERE "operationId"=$1', [input.operationId])).rows[0];
      if (previous) {
        requireValue(previous.attemptId === input.attemptId && previous.actor === input.actor && previous.outcome === input.outcome && previous.remoteReference === (input.remoteReference ?? null), "OPERATION_CONFLICT");
        return;
      }
      requireValue(outcomeAllowed(attempt.outcome, input.outcome), "OUTCOME_TERMINAL");
      requireValue(!attempt.remoteReference || !input.remoteReference || attempt.remoteReference === input.remoteReference, "REFERENCE_CONFLICT");
      requireValue(!["ACCEPTED", "CONFIRMED"].includes(input.outcome) || input.remoteReference || attempt.remoteReference, "REFERENCE_REQUIRED");
      await tx.query('INSERT INTO "PublishingAttemptEvent" ("operationId","attemptId",outcome,"remoteReference",actor) VALUES($1,$2,$3,$4,$5)', [input.operationId, input.attemptId, input.outcome, input.remoteReference ?? null, input.actor]);
      await tx.query('UPDATE "PublishingExternalAttempt" SET outcome=$2,"remoteReference"=COALESCE("remoteReference",$3) WHERE id=$1', [input.attemptId, input.outcome, input.remoteReference ?? null]);
    });
  }
  async function recoverAttempt(id: string) {
    identifier(id);
    return atomic(async tx => ({ record: (await tx.query('SELECT * FROM "PublishingExternalAttempt" WHERE id=$1', [id])).rows[0] ?? null, maySend: false as const }));
  }
  return { transition, createIntent, reviseIntent, authorize, recordOutcome, recoverAttempt };
}
