/** Stage 4C.1 only: binding/admission/preparation. No external send operation. */
import { createHash, randomUUID } from 'node:crypto';
import { createPublishingIntentActions, type IntentActionDependencies, type IntentRequest } from './intentActions';
import type { OwnershipDatabase, OwnershipTransaction } from './ownership';
import { publicationKey, legacyProjection, type CanonicalJob, type PublicationIdentity, type RevisionDestination } from './canonicalContract';
type Tx=OwnershipTransaction;
export class CanonicalPublishingError extends Error {
  constructor(readonly code:string){super(code);this.name='CanonicalPublishingError';}
}
function requireValue(ok:unknown,code:string):asserts ok{if(!ok)throw new CanonicalPublishingError(code);}
function identifier(v:string){requireValue(typeof v==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(v),'INVALID_IDENTIFIER');}
function hash(v:unknown){
  const stable=(value:any):any=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
  return createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
}
export function createCanonicalIntentActions(deps:IntentActionDependencies & {
  /** Trusted snapshot of the locked post; exact requested destination, no tokens.
   * Implement using the same transaction, without remote IO. */
  captureRevision(tx:Tx,input:IntentRequest):Promise<RevisionDestination>;
}) {
  requireValue(!deps.bindRevision,'CANONICAL_BINDING_HOOK_RESERVED');
  return createPublishingIntentActions({...deps,async bindRevision(tx,input,revision,jobId){
    requireValue(input.destination,'EXPLICIT_DESTINATION_REQUIRED');
    const d=await deps.captureRevision(tx,input);
    requireValue(input.destination.accountBindingId===d.accountBindingId&&input.destination.accountVersion===d.accountVersion,'EXPLICIT_DESTINATION_MISMATCH');
    identifier(d.accountBindingId);identifier(d.calendarId);
    requireValue(Number.isSafeInteger(d.accountVersion)&&d.accountVersion>0&&/^[0-9a-f]{64}$/.test(d.contentHash),'INVALID_REVISION_BINDING');
    const a=(await tx.query(`SELECT * FROM "PublishingAccountBinding" WHERE id=$1 FOR SHARE`,[d.accountBindingId])).rows[0];
    requireValue(a&&a.calendarId===d.calendarId&&a.platform===input.platform&&a.state==='CONNECTED'&&a.currentVersion===d.accountVersion,'ACCOUNT_BINDING_CHANGED');
    await tx.query(`INSERT INTO "PublishingCanonicalRevision"("intentId",revision,"jobId","accountBindingId","accountVersion","contentHash","operationId") VALUES($1,$2,$3,$4,$5,$6,$7)`,[input.intentId,revision,jobId,d.accountBindingId,d.accountVersion,d.contentHash,input.operationId]);
  }});
}
export interface CanonicalStoreDependencies {
  database:OwnershipDatabase;
  /** Inactive worker/test override; original three-minute default is preserved. */
  preparedLeaseMs?:number;
  /** Must lock the intended post and validate calendar/platform/contentHash,
   * approval, permission and entitlement in tx. It must NOT inspect updatedAt
   * or require the CalendarPost UI status to be PUBLISHING. No remote IO. */
  lockAndValidate(tx:Tx,job:CanonicalJob,action:'admit'|'prepare'):Promise<void>;
}
export interface CanonicalOperation {operationId:string;actor:string;jobId:string;owner:'NETLIFY'|'VPS';epoch:bigint}
export interface CanonicalReceipt {
  outcome:'ADMITTED'|'PREPARED';jobId:string;identity:PublicationIdentity;workerToken?:string;maySend:false;
}
const selection=`SELECT j.id,j."postId",j.platform,j.phase,j."workerToken",j."remoteId",j."workerUntil",j."ownershipEpoch",
 j."intentId",j."intentRevision" AS revision,r."dueAt",b."accountBindingId",b."accountVersion",b."contentHash",a."calendarId",
 v."providerAccountId",v."connectionId",COALESCE(g.generation,1) AS generation
 FROM "PublishingJob" j JOIN "PublishingCanonicalRevision" b ON b."jobId"=j.id
 JOIN "PublishingIntentRevision" r ON r."intentId"=j."intentId" AND r.revision=j."intentRevision"
 JOIN "PublishingAccountBinding" a ON a.id=b."accountBindingId"
 JOIN "PublishingAccountVersion" v ON v."bindingId"=a.id AND v.version=b."accountVersion"
 LEFT JOIN "PublishingRetryGeneration" g ON g."jobId"=j.id WHERE j.id=$1`;
export function createCanonicalPublishingStore(deps:CanonicalStoreDependencies) {
  const db=deps.database,leaseMs=deps.preparedLeaseMs??180_000;
  requireValue(Number.isSafeInteger(leaseMs)&&leaseMs>0&&leaseMs<=180_000,'INVALID_PREPARED_LEASE');
  async function read(tx:Tx,id:string):Promise<CanonicalJob>{
    const j=(await tx.query(selection,[id])).rows[0];requireValue(j,'CANONICAL_JOB_UNBOUND');publicationKey({intentId:j.intentId,revision:j.revision,generation:j.generation});return j as CanonicalJob;
  }
  async function atomic<T>(run:(tx:Tx)=>Promise<T>){
    return db.transaction(async tx=>{requireValue((await tx.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation==='read committed','CANONICAL_ISOLATION_REQUIRED');return run(tx);});
  }
  async function change(action:'admit'|'prepare',input:CanonicalOperation):Promise<CanonicalReceipt>{
    for(const v of [input.operationId,input.actor,input.jobId])identifier(v);
    requireValue(['NETLIFY','VPS'].includes(input.owner)&&input.epoch>BigInt(0),'INVALID_OWNER');
    const digest=hash({...input,epoch:String(input.epoch),action});
    return atomic(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`canonical:${input.operationId}`]);
      const old=(await tx.query(`SELECT * FROM "PublishingCanonicalOperation" WHERE "operationId"=$1`,[input.operationId])).rows[0];
      // Immutable receipts are historical facts, never authority to send or renew a lease.
      if(old){requireValue(old.requestHash===digest&&old.actor===input.actor,'OPERATION_CONFLICT');return old.result;}
      const owner=(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0];
      requireValue(owner?.enabled&&owner.state===input.owner&&BigInt(owner.epoch)===input.epoch,'OWNERSHIP_FENCED');
      const snapshot=await read(tx,input.jobId);await deps.lockAndValidate(tx,snapshot,action);
      const a=(await tx.query(`SELECT * FROM "PublishingAccountBinding" WHERE id=$1 FOR SHARE`,[snapshot.accountBindingId])).rows[0];
      requireValue(a?.state==='CONNECTED'&&a.currentVersion===snapshot.accountVersion,'ACCOUNT_BINDING_CHANGED');
      const i=(await tx.query(`SELECT * FROM "PublishingIntent" WHERE id=$1 FOR UPDATE`,[snapshot.intentId])).rows[0];
      requireValue(i?.state==='ACTIVE'&&i.currentRevision===snapshot.revision,'INTENT_FENCED');
      const j=(await tx.query(`SELECT *,"availableAt"<=clock_timestamp() AS available,"workerUntil"<=clock_timestamp() AS expired FROM "PublishingJob" WHERE id=$1 FOR UPDATE`,[snapshot.id])).rows[0];
      requireValue(!(await tx.query(`SELECT 1 FROM "PublishingRevisionInvalidation" WHERE "intentId"=$1 AND revision=$2`,[i.id,snapshot.revision])).rows.length,'REVISION_INVALIDATED');
      requireValue(j.available&&(await tx.query(`SELECT "dueAt"<=clock_timestamp() AS due FROM "PublishingIntentRevision" WHERE "intentId"=$1 AND revision=$2`,[i.id,snapshot.revision])).rows[0]?.due,'JOB_NOT_DUE');
      requireValue(j.phase==='READY'||action==='prepare'&&j.phase==='PREPARED'&&j.expired,'JOB_NOT_ELIGIBLE');
      if(action==='admit')await tx.query(`INSERT INTO "PublishingCanonicalExecution"("jobId","intentId",revision,generation) VALUES($1,$2,$3,$4) ON CONFLICT("jobId") DO NOTHING`,[j.id,i.id,snapshot.revision,snapshot.generation]);
      const result:CanonicalReceipt={outcome:action==='admit'?'ADMITTED':'PREPARED',jobId:j.id,identity:{intentId:i.id,revision:snapshot.revision,generation:snapshot.generation},maySend:false};
      if(action==='prepare'){
        requireValue((await tx.query(`SELECT 1 FROM "PublishingCanonicalExecution" WHERE "jobId"=$1`,[j.id])).rows.length,'JOB_NOT_ADMITTED');
        result.workerToken=randomUUID();
        await tx.query(`UPDATE "PublishingJob" SET phase='PREPARED',"workerToken"=$2,"workerUntil"=clock_timestamp()+$5*interval '1 millisecond',"ownershipEpoch"=$3,"accountId"=$4,"updatedAt"=clock_timestamp() WHERE id=$1`,[j.id,result.workerToken,String(input.epoch),snapshot.providerAccountId,leaseMs]);
      }
      await tx.query(`INSERT INTO "PublishingCanonicalOperation"("operationId","jobId",action,actor,"requestHash",result) VALUES($1,$2,$3,$4,$5,$6)`,[input.operationId,j.id,action,input.actor,digest,result]);return result;
    });
  }
  async function changeAccount(input:{operationId:string;actor:string;bindingId:string;calendarId:string;platform:string;expectedVersion:number;providerAccountId:string;connectionId:string;authorizationHash:string;state:'CONNECTED'|'DISCONNECTED'}){
    for(const v of [input.operationId,input.actor,input.bindingId,input.calendarId,input.connectionId])identifier(v);
    requireValue(['INSTAGRAM','TIKTOK','FACEBOOK','LINKEDIN','X'].includes(input.platform)&&['CONNECTED','DISCONNECTED'].includes(input.state)&&Number.isSafeInteger(input.expectedVersion)&&input.expectedVersion>=0&&input.expectedVersion<2147483647&&typeof input.providerAccountId==='string'&&input.providerAccountId.length>0&&input.providerAccountId.length<=500&&/^[0-9a-f]{64}$/.test(input.authorizationHash),'INVALID_ACCOUNT');
    return atomic(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`account:${input.calendarId}:${input.platform}`]);
      const digest=hash(input),old=(await tx.query(`SELECT * FROM "PublishingAccountEvent" WHERE "operationId"=$1`,[input.operationId])).rows[0];
      if(old){requireValue(old.requestHash===digest&&old.actor===input.actor,'OPERATION_CONFLICT');return {version:old.version};}
      const a=(await tx.query(`SELECT * FROM "PublishingAccountBinding" WHERE id=$1 FOR UPDATE`,[input.bindingId])).rows[0];
      requireValue(a?a.currentVersion===input.expectedVersion&&a.calendarId===input.calendarId&&a.platform===input.platform:input.expectedVersion===0,'ACCOUNT_VERSION_CONFLICT');
      const version=input.expectedVersion+1;
      if(!a)await tx.query(`INSERT INTO "PublishingAccountBinding"(id,"calendarId",platform,"currentVersion",state) VALUES($1,$2,$3,1,$4)`,[input.bindingId,input.calendarId,input.platform,input.state]);
      await tx.query(`INSERT INTO "PublishingAccountVersion"("bindingId",version,"providerAccountId","connectionId","authorizationHash") VALUES($1,$2,$3,$4,$5)`,[input.bindingId,version,input.providerAccountId,input.connectionId,input.authorizationHash]);
      if(a)await tx.query(`UPDATE "PublishingAccountBinding" SET "currentVersion"=$2,state=$3 WHERE id=$1`,[input.bindingId,version,input.state]);
      await tx.query(`INSERT INTO "PublishingAccountEvent"("operationId","bindingId",version,state,actor,"requestHash") VALUES($1,$2,$3,$4,$5,$6)`,[input.operationId,input.bindingId,version,input.state,input.actor,digest]);return {version};
    });
  }
  return {
    admit:(i:CanonicalOperation)=>change('admit',i),prepare:(i:CanonicalOperation)=>change('prepare',i),changeAccount,
    findJob:(id:string)=>{identifier(id);return atomic(tx=>read(tx,id));},
    projection:async(id:string)=>legacyProjection((await atomic(tx=>read(tx,id))).phase),
  };
}
