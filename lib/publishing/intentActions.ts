/** Stage 4A: inert, injected, top-level PostgreSQL transactions only. No route/provider imports. */
import { createHash, randomUUID } from 'node:crypto';
import type { OwnershipDatabase, OwnershipTransaction } from './ownership';
type Tx = OwnershipTransaction;
type Row = Record<string, any>;
export type IntentAction = 'schedule' | 'cancel' | 'reschedule' | 'edit' | 'retry';
export interface IntentRequest {
  operationId: string; actor: string; intentId: string; postId: string; platform: string;
  expectedRevision: number; dueAt?: Date; edit?: unknown; evidenceId?: string;
  /** Used only by the inactive canonical extension; included in replay identity. */
  destination?: { accountBindingId: string; accountVersion: number };
}
export type IntentActionResult = {
  outcome: 'APPLIED' | 'CONFLICT' | 'PENDING_RECONCILIATION' | 'NEW_AUTHORIZED_INTENT_REQUIRED';
  intentId: string; revision?: number; jobId?: string; generationId?: string; code?: string;
};
export class IntentActionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'IntentActionError'; }
}
export interface IntentActionDependencies {
  database: OwnershipDatabase;
  /** Optional inert extension: append canonical binding in this same transaction.
   * No existing caller supplies this hook. Must perform database work only. */
  bindRevision?(tx: Tx, input: IntentRequest, revision: number, jobId: string): Promise<void>;
  /** Lock the intended post row and validate existence, platform, approval, permissions,
   * entitlement and eligibility using this tx. Must throw on denial. No network side effects.
   * All post mutations must eventually use the same post lock. Replay is permission-checked too. */
  lockAndValidatePost(tx: Tx, input: IntentRequest, action: IntentAction): Promise<void>;
  /** Persist content only; cannot alter publishing status/evidence. Called after all intent locks. */
  applyEdit(tx: Tx, input: IntentRequest): Promise<void>;
  /** Validate due-time policy against the locked post. Mandatory for new revisions. */
  validateDueTime(tx: Tx, input: IntentRequest, action: IntentAction): Promise<void>;
  /** Trusted verifier only, never a client boolean. Validate actor fencing/stoppage,
   * durable evidence, definitive classification and explicit retry approval. */
  verifyRetryEvidence(tx: Tx, input: {
    actor: string; intentId: string; predecessorId: string; evidenceReference: string;
  }): Promise<{ kind: 'NOT_SENT' | 'PROVIDER_REJECTED'; actorStopped: true; verified: true; retryable: true }>;
}
const platforms = ['INSTAGRAM','TIKTOK','FACEBOOK','LINKEDIN','X'];
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new IntentActionError(code); }
function id(value: string) { check(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value), 'INVALID_IDENTIFIER'); }
function fingerprint(value: unknown): string {
  function stable(v: any): any {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function createPublishingIntentActions(deps: IntentActionDependencies) {
  async function atomic<T>(run: (tx: Tx) => Promise<T>) {
    try { return await deps.database.transaction(async tx => {
      // Locks followed by fresh statements must see the winning authorization commit.
      const isolation=(await tx.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
      check(isolation==='read committed','ACTION_REQUIRES_READ_COMMITTED');
      return run(tx);
    }); }
    catch (e) { if (e instanceof IntentActionError) throw e; throw new IntentActionError('ACTION_TRANSACTION_UNCONFIRMED'); }
  }
  async function latest(tx: Tx, intentId: string): Promise<Row | undefined> {
    return (await tx.query(`SELECT id,outcome,generation,"remoteReference","jobId" FROM "PublishingRetryGeneration" WHERE "intentId"=$1 ORDER BY generation DESC LIMIT 1`, [intentId])).rows[0]
      ?? (await tx.query(`SELECT *,1 AS generation FROM "PublishingExternalAttempt" WHERE "intentId"=$1`, [intentId])).rows[0];
  }
  function blocked(attempt?: Row): IntentActionResult['outcome'] | undefined {
    if (attempt?.outcome === 'CONFIRMED') return 'NEW_AUTHORIZED_INTENT_REQUIRED';
    if (attempt && ['AUTHORIZED','ACCEPTED','UNKNOWN'].includes(attempt.outcome)) return 'PENDING_RECONCILIATION';
  }
  async function invalidate(tx: Tx, i: Row, operationId: string, reason: IntentAction) {
    await tx.query(`INSERT INTO "PublishingRevisionInvalidation"("intentId",revision,"operationId",reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [i.id,i.currentRevision,operationId,reason]);
    const generations = (await tx.query(`UPDATE "PublishingRetryGeneration" SET outcome='CANCELLED' WHERE "intentId"=$1 AND outcome='READY' RETURNING id`, [i.id])).rows;
    for (const g of generations) await tx.query(`INSERT INTO "PublishingRetryEvent"("operationId","generationId",outcome,actor) VALUES($1,$2,'CANCELLED','intent-action')`, [randomUUID(),g.id]);
    await tx.query(`UPDATE "PublishingJob" SET phase='CANCELLED',"workerToken"=NULL,"workerUntil"=NULL,"updatedAt"=clock_timestamp() WHERE "intentId"=$1 AND "intentRevision"=$2 AND phase IN ('READY','PREPARED')`, [i.id,i.currentRevision]);
  }
  async function revision(tx: Tx, i: Row | undefined, input: IntentRequest, action: IntentAction) {
    check(input.dueAt instanceof Date && Number.isFinite(input.dueAt.getTime()), 'INVALID_DUE_TIME');
    await deps.validateDueTime(tx,input,action);
    const next = i ? i.currentRevision + 1 : 1;
    check(Number.isSafeInteger(next) && next < 2147483647, 'REVISION_EXHAUSTED');
    if (!i) await tx.query(`INSERT INTO "PublishingIntent"(id,"postId",platform,"currentRevision") VALUES($1,$2,$3,1)`, [input.intentId,input.postId,input.platform]);
    await tx.query(`INSERT INTO "PublishingIntentRevision"("intentId",revision,"dueAt") VALUES($1,$2,$3)`, [input.intentId,next,input.dueAt]);
    if (i) await tx.query(`UPDATE "PublishingIntent" SET state='ACTIVE',"currentRevision"=$2 WHERE id=$1`, [i.id,next]);
    const jobId=randomUUID(), admissionId=randomUUID();
    await tx.query(`INSERT INTO "PublishingAdmission"(id,platform) VALUES($1,$2)`, [admissionId,input.platform]);
    // Legacy lease is a unique synthetic identity, not the due time. Allocate under post lock.
    await tx.query(`INSERT INTO "PublishingJob"(id,"admissionId","postId",platform,lease,phase,"availableAt","intentId","intentRevision")
      SELECT $1,$2,$3,$4,GREATEST(clock_timestamp()::timestamp(3),COALESCE(max(lease)+interval '1 millisecond',clock_timestamp()::timestamp(3))),'READY',$5,$6,$7
      FROM "PublishingJob" WHERE "postId"=$3 AND platform=$4`, [jobId,admissionId,input.postId,input.platform,input.dueAt,input.intentId,next]);
    await deps.bindRevision?.(tx,input,next,jobId);
    return {next,jobId};
  }
  async function perform(action: IntentAction, input: IntentRequest): Promise<IntentActionResult> {
    for (const v of [input.operationId,input.actor,input.intentId,input.postId]) id(v);
    check(platforms.includes(input.platform) && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision>=0 && input.expectedRevision<2147483647, 'INVALID_REQUEST');
    if (input.dueAt !== undefined) check(input.dueAt instanceof Date && Number.isFinite(input.dueAt.getTime()),'INVALID_DUE_TIME');
    const hash=fingerprint({...input,action});
    return atomic(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.operationId]);
      await deps.lockAndValidatePost(tx,input,action);
      const prior=(await tx.query(`SELECT * FROM "PublishingAction" WHERE "operationId"=$1`,[input.operationId])).rows[0];
      if (prior) { check(prior.actor===input.actor && prior.requestHash===hash,'OPERATION_CONFLICT'); return prior.result; }
      const i=(await tx.query(`SELECT * FROM "PublishingIntent" WHERE "postId"=$1 ORDER BY id FOR UPDATE`,[input.postId])).rows;
      const current=i.find(x=>x.id===input.intentId);
      const result: IntentActionResult={outcome:'APPLIED',intentId:input.intentId};
      check(!current || current.platform===input.platform,'INTENT_IDENTITY_CONFLICT');
      if (!current) {
        check(action==='schedule' && input.expectedRevision===0 && !i.some(x=>x.platform===input.platform),'INTENT_MISSING_OR_CONFLICT');
        const r=await revision(tx,undefined,input,action); result.revision=r.next;result.jobId=r.jobId;
      } else {
        result.revision=current.currentRevision;
        if (current.currentRevision!==input.expectedRevision) { result.outcome='CONFLICT';result.code='STALE_REVISION'; }
        else {
          const affected=action==='edit'?i:[current];
          for (const item of affected) {
            let busy=blocked(await latest(tx,item.id));
            const jobEvidence=(await tx.query(`SELECT phase,"remoteId",confirmation FROM "PublishingJob" WHERE "intentId"=$1 AND (phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN','CONFIRMED') OR "remoteId" IS NOT NULL OR confirmation IS NOT NULL) LIMIT 1`,[item.id])).rows[0];
            if(jobEvidence && busy!=='NEW_AUTHORIZED_INTENT_REQUIRED') busy=jobEvidence.phase==='CONFIRMED'?'NEW_AUTHORIZED_INTENT_REQUIRED':'PENDING_RECONCILIATION';
            if (busy) { result.outcome=busy;result.code='EXTERNAL_ATTEMPT_EXISTS';break; }
          }
          if (result.outcome==='APPLIED') {
            const predecessor=await latest(tx,current.id);
            if (action==='retry') {
              check(current.state==='ACTIVE' && predecessor?.outcome==='REJECTED','RETRY_NOT_ELIGIBLE');
              id(input.evidenceId!);
              const proof=(await tx.query(`SELECT * FROM "PublishingRetryEvidence" WHERE id=$1 AND "intentId"=$2`,[input.evidenceId,current.id])).rows[0];
              check(proof && (predecessor.generation===1?proof.rootAttemptId:proof.predecessorGenerationId)===predecessor.id,'RETRY_EVIDENCE_MISSING');
              // A predecessor has only one successor, including cancelled generations.
              const successor=(await tx.query(`SELECT id FROM "PublishingRetryGeneration" WHERE "rootAttemptId"=$1 OR "predecessorGenerationId"=$1`,[predecessor.id])).rows[0];
              if (successor) { result.outcome='CONFLICT';result.code='RETRY_ALREADY_CREATED'; }
              else {
                await invalidate(tx,current,input.operationId,action);
                const r=await revision(tx,current,input,action),generationId=randomUUID();
                await tx.query(`INSERT INTO "PublishingRetryGeneration"(id,"intentId",revision,generation,"rootAttemptId","predecessorGenerationId","evidenceId","jobId","operationId","approvedBy") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[generationId,current.id,r.next,predecessor.generation+1,predecessor.generation===1?predecessor.id:null,predecessor.generation===1?null:predecessor.id,proof.id,r.jobId,input.operationId,input.actor]);
                Object.assign(result,{revision:r.next,jobId:r.jobId,generationId});
              }
            } else if (action==='schedule' || action==='reschedule') {
              if (predecessor) { result.outcome='CONFLICT';result.code='EXPLICIT_RETRY_REQUIRED'; }
              else if (action==='schedule' && current.state==='ACTIVE' || action==='reschedule' && current.state!=='ACTIVE') {result.outcome='CONFLICT';result.code='INTENT_STATE_CONFLICT';}
              else { await invalidate(tx,current,input.operationId,action); const r=await revision(tx,current,input,action);Object.assign(result,{revision:r.next,jobId:r.jobId}); }
            } else {
              for (const item of affected) {
                await invalidate(tx,item,input.operationId,action);
                await tx.query(`UPDATE "PublishingIntent" SET state='CANCELLED' WHERE id=$1`,[item.id]);
              }
              if (action==='edit') await deps.applyEdit(tx,input);
            }
          }
        }
      }
      await tx.query(`INSERT INTO "PublishingAction"("operationId",actor,"requestHash","intentId",action,result) VALUES($1,$2,$3,$4,$5,$6)`,[input.operationId,input.actor,hash,input.intentId,action,result]);
      return result;
    });
  }
  /** Separate trusted reconciliation operation: no evidence booleans accepted from request. */
  async function recordRetryEvidence(input: {id:string;actor:string;intentId:string;predecessorId:string;evidenceReference:string}) {
    for(const v of [input.id,input.actor,input.intentId,input.predecessorId]) id(v);
    check(typeof input.evidenceReference==='string' && input.evidenceReference.length>0 && input.evidenceReference.length<=200,'INVALID_EVIDENCE');
    return atomic(async tx=>{
      await tx.query(`SELECT id FROM "PublishingIntent" WHERE id=$1 FOR UPDATE`,[input.intentId]);
      const old=(await tx.query(`SELECT * FROM "PublishingRetryEvidence" WHERE id=$1`,[input.id])).rows[0];
      if(old) {check(old.intentId===input.intentId && (old.rootAttemptId??old.predecessorGenerationId)===input.predecessorId && old.verifiedBy===input.actor && old.evidenceReference===input.evidenceReference,'OPERATION_CONFLICT');return {evidenceId:old.id};}
      const p=await latest(tx,input.intentId);check(p?.id===input.predecessorId,'PREDECESSOR_NOT_CURRENT');
      check(p.outcome!=='CONFIRMED' && !p.remoteReference && p.outcome!=='ACCEPTED','PUBLICATION_EVIDENCE_CONFLICT');
      const job=(await tx.query(`SELECT * FROM "PublishingJob" WHERE id=$1 FOR UPDATE`,[p.jobId])).rows[0];
      check(job && !job.remoteId && job.confirmation===null && job.phase!=='CONFIRMED','PUBLICATION_EVIDENCE_CONFLICT');
      const proof=await deps.verifyRetryEvidence(tx,input);
      check(proof.actorStopped===true && proof.verified===true && proof.retryable===true && ['NOT_SENT','PROVIDER_REJECTED'].includes(proof.kind),'EVIDENCE_DENIED');
      check(proof.kind==='NOT_SENT' || p.outcome==='REJECTED','REJECTION_NOT_DEFINITIVE');
      if(p.outcome!=='REJECTED') {
        check(['AUTHORIZED','UNKNOWN'].includes(p.outcome),'EVIDENCE_DENIED');
        if(p.generation===1) {
          await tx.query(`INSERT INTO "PublishingAttemptEvent"("operationId","attemptId",outcome,actor) VALUES($1,$2,'REJECTED',$3)`,[randomUUID(),p.id,input.actor]);
          await tx.query(`UPDATE "PublishingExternalAttempt" SET outcome='REJECTED' WHERE id=$1`,[p.id]);
        } else {
          await tx.query(`INSERT INTO "PublishingRetryEvent"("operationId","generationId",outcome,actor) VALUES($1,$2,'REJECTED',$3)`,[randomUUID(),p.id,input.actor]);
          await tx.query(`UPDATE "PublishingRetryGeneration" SET outcome='REJECTED' WHERE id=$1`,[p.id]);
        }
      }
      await tx.query(`UPDATE "PublishingJob" SET phase='REJECTED',"updatedAt"=clock_timestamp() WHERE id=$1`,[job.id]);
      await tx.query(`INSERT INTO "PublishingRetryEvidence"(id,"intentId","rootAttemptId","predecessorGenerationId",kind,"actorStopped",verified,retryable,"evidenceReference","verifiedBy") VALUES($1,$2,$3,$4,$5,true,true,true,$6,$7)`,[input.id,input.intentId,p.generation===1?p.id:null,p.generation===1?null:p.id,proof.kind,input.evidenceReference,input.actor]);
      return {evidenceId:input.id};
    });
  }
  return {
    schedule:(i:IntentRequest)=>perform('schedule',i), cancel:(i:IntentRequest)=>perform('cancel',i),
    reschedule:(i:IntentRequest)=>perform('reschedule',i), edit:(i:IntentRequest)=>perform('edit',i),
    retry:(i:IntentRequest)=>perform('retry',i), recordRetryEvidence,
  };
}
