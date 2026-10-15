/** Stage 4C.3: inactive, injected, no provider/global DB/context-fallback imports. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createPublishingOwnership, outcomeAllowed, type OwnershipDatabase, type OwnershipTransaction, type Outcome } from './ownership';
import type { CanonicalJob, PublicationIdentity, PublishingPlatform } from './canonicalContract';
import type { createPublishingValidationAdapters } from './validationAdapters';
import { policyHash, publishingContentHash } from './eligibilityPolicy';
const providerInvocations=new WeakMap<object,{targetHash:string;request?:{operation:string;payloadHash:string}}>();
/** Opaque driver context, registered only after acknowledged consumption COMMIT. */
export function isPublicationInvocationAuthorization(value:unknown){return typeof value==='object'&&value!==null&&providerInvocations.has(value);}
export function registerProviderExecutionRequest(auth:object,target:PublicationTarget,operation:string,payload:Record<string,unknown>){
 const entry=providerInvocations.get(auth);if(!entry||entry.targetHash!==policyHash(target)||entry.request)throw new PublicationAuthorizationError('PROVIDER_CONTEXT_NOT_FRESH');entry.request={operation,payloadHash:policyHash(payload)};
}
export function matchesProviderExecutionRequest(auth:object,target:PublicationTarget,operation:string,payload:Record<string,unknown>){const entry=providerInvocations.get(auth);return !!entry&&entry.targetHash===policyHash(target)&&entry.request?.operation===operation&&entry.request.payloadHash===policyHash(payload);}
type Tx=OwnershipTransaction;type Validators=Pick<ReturnType<typeof createPublishingValidationAdapters>,'validateBeforeExternal'|'validateExecution'>;
export class PublicationAuthorizationError extends Error {constructor(readonly code:string){super(code);this.name='PublicationAuthorizationError';}}
function ensure(ok:unknown,code:string):asserts ok{if(!ok)throw new PublicationAuthorizationError(code);}
function identifier(s:string){ensure(typeof s==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(s),'INVALID_IDENTIFIER');}
export interface PublicationTarget extends PublicationIdentity {
 jobId:string;platform:PublishingPlatform;accountBindingId:string;accountVersion:number;
 providerAccountId:string;connectionId:string;contentHash:string;
}
export interface AuthorizationRequest extends PublicationTarget {operationId:string;actor:string;owner:'NETLIFY'|'VPS';epoch:bigint;workerToken:string}
declare const capabilityBrand:unique symbol;
export type PublicationCapability=Readonly<{[capabilityBrand]:true}>;
export type AuthorizationReceipt={outcome:'AUTHORIZED';authorizationId:string;maySend:true;capability:PublicationCapability}|{outcome:'REPLAY'|'PENDING_RECONCILIATION';authorizationId:string;maySend:false;capability?:never};
export type ProviderObservation={outcome:'ACCEPTED'|'CONFIRMED';reference:string}|{outcome:'REJECTED'}|{outcome:'UNKNOWN';reference?:string};
export interface ProviderSubmission {readonly target:Readonly<PublicationTarget>;readonly post:Readonly<Record<string,unknown>>;readonly assets:readonly Readonly<Record<string,unknown>>[];readonly authorization:Readonly<{id:string;actor:string;owner:string;epoch:string;rootAttemptId:string|null;retryGenerationId:string|null;expiresAt:string}>}
export type SyntheticPublicationDriver=(submission:ProviderSubmission)=>Promise<ProviderObservation>;
function target(job:CanonicalJob):PublicationTarget{return {jobId:job.id,intentId:job.intentId,revision:job.revision,generation:job.generation,platform:job.platform,accountBindingId:job.accountBindingId,accountVersion:job.accountVersion,providerAccountId:job.providerAccountId,connectionId:job.connectionId,contentHash:job.contentHash};}
function validTarget(t:PublicationTarget){
 ensure(t&&typeof t==='object','PUBLICATION_TARGET_REQUIRED');
 for(const s of [t.jobId,t.intentId,t.accountBindingId,t.connectionId])identifier(s);
 ensure([t.revision,t.generation,t.accountVersion].every(n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647)&&['INSTAGRAM','TIKTOK','FACEBOOK','LINKEDIN','X'].includes(t.platform)&&typeof t.providerAccountId==='string'&&t.providerAccountId.length>0&&/^[a-f0-9]{64}$/.test(t.contentHash),'INVALID_TARGET');
}
function seal<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))seal(x);Object.freeze(v);}return v;}
async function readJob(tx:Tx,jobId:string):Promise<CanonicalJob>{
 const j=(await tx.query(`SELECT j.id,j."postId",j.platform,j.phase,j."workerToken",j."remoteId",j."intentId",j."intentRevision" AS revision,
 r."dueAt",b."accountBindingId",b."accountVersion",b."contentHash",a."calendarId",v."providerAccountId",v."connectionId",COALESCE(g.generation,1) AS generation
 FROM "PublishingJob" j JOIN "PublishingCanonicalRevision" b ON b."jobId"=j.id JOIN "PublishingIntentRevision" r ON r."intentId"=j."intentId" AND r.revision=j."intentRevision"
 JOIN "PublishingAccountBinding" a ON a.id=b."accountBindingId" JOIN "PublishingAccountVersion" v ON v."bindingId"=a.id AND v.version=b."accountVersion"
 LEFT JOIN "PublishingRetryGeneration" g ON g."jobId"=j.id WHERE j.id=$1`,[jobId])).rows[0];ensure(j,'CANONICAL_JOB_MISSING');return j as CanonicalJob;
}
export function createExternalPublicationAuthorization(deps:{database:OwnershipDatabase;validation:Validators;capabilityTtlMs?:number}){
 const ttl=deps.capabilityTtlMs??15_000;ensure(Number.isSafeInteger(ttl)&&ttl>0&&ttl<=30_000,'INVALID_CAPABILITY_TTL');
 const registry=new WeakMap<object,{id:string;secret:string;target:PublicationTarget;used:boolean}>();
 async function atomic<T>(fn:(tx:Tx)=>Promise<T>){return deps.database.transaction(async tx=>{ensure((await tx.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation==='read committed','AUTHORIZATION_ISOLATION_REQUIRED');return fn(tx);});}
 async function authorize(input:AuthorizationRequest):Promise<AuthorizationReceipt>{
  input=Object.freeze({...input});
  validTarget(input);identifier(input.operationId);identifier(input.actor);identifier(input.workerToken);ensure(['NETLIFY','VPS'].includes(input.owner)&&typeof input.epoch==='bigint'&&input.epoch>BigInt(0),'INVALID_OWNER');
  const requestHash=policyHash({...input,epoch:String(input.epoch)});
  const committed=await atomic(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`external-auth:${input.operationId}`]);
   const old=(await tx.query(`SELECT * FROM "PublishingAuthorizationOperation" WHERE "operationId"=$1`,[input.operationId])).rows[0];
   if(old){ensure(old.actor===input.actor&&old.requestHash===requestHash,'OPERATION_CONFLICT');return {receipt:{outcome:'REPLAY',authorizationId:old.authorizationId,maySend:false} as AuthorizationReceipt};}
   const job=await readJob(tx,input.jobId);ensure(policyHash(target(job))===policyHash({jobId:input.jobId,intentId:input.intentId,revision:input.revision,generation:input.generation,platform:input.platform,accountBindingId:input.accountBindingId,accountVersion:input.accountVersion,providerAccountId:input.providerAccountId,connectionId:input.connectionId,contentHash:input.contentHash}),'PUBLICATION_IDENTITY_CONFLICT');
   // Any existing authorization is a durable fact, never a new send grant.
   const existing=(await tx.query(`SELECT id FROM "PublishingSendCapability" WHERE "jobId"=$1`,[job.id])).rows[0];
   if(existing)return {receipt:{outcome:'PENDING_RECONCILIATION',authorizationId:existing.id,maySend:false} as AuthorizationReceipt};
   ensure(job.workerToken===input.workerToken,'WORKER_CLAIM_FENCED');
   const proof=await deps.validation.validateBeforeExternal(tx,{job,owner:input.owner,epoch:input.epoch});
   const authorizationId=randomUUID(),attemptId=randomUUID();let rootAttemptId:string|null=null,retryGenerationId:string|null=null;
   if(job.generation===1){
    const scoped=createPublishingOwnership({transaction:fn=>fn(tx)});
    const r=await scoped.authorize({attemptId,intentId:job.intentId,revision:job.revision,jobId:job.id,owner:input.owner,epoch:input.epoch,actor:input.actor});
    ensure(r.maySend,'INITIAL_ATTEMPT_ALREADY_EXISTS');rootAttemptId=attemptId;
   }else{
    const g=(await tx.query(`SELECT * FROM "PublishingRetryGeneration" WHERE "jobId"=$1 FOR UPDATE`,[job.id])).rows[0];
    ensure(g&&g.generation===job.generation&&g.revision===job.revision&&g.intentId===job.intentId&&g.outcome==='READY','RETRY_GENERATION_NOT_ELIGIBLE');
    const e=(await tx.query(`SELECT * FROM "PublishingRetryEvidence" WHERE id=$1`,[g.evidenceId])).rows[0];
    ensure(e&&e.actorStopped&&e.verified&&e.retryable&&e.intentId===job.intentId&&e.rootAttemptId===g.rootAttemptId&&e.predecessorGenerationId===g.predecessorGenerationId,'TRUSTED_RETRY_EVIDENCE_REQUIRED');
    await tx.query(`UPDATE "PublishingRetryGeneration" SET outcome='AUTHORIZED',owner=$2,epoch=$3,"authorizationId"=$4 WHERE id=$1`,[g.id,input.owner,String(input.epoch),authorizationId]);
    await tx.query(`INSERT INTO "PublishingRetryEvent"("operationId","generationId",outcome,actor) VALUES($1,$2,'AUTHORIZED',$3)`,[randomUUID(),g.id,input.actor]);
    await tx.query(`UPDATE "PublishingJob" SET phase='EXTERNAL_PENDING' WHERE id=$1`,[job.id]);retryGenerationId=g.id;
   }
   const secret=randomBytes(32).toString('hex'),tokenHash=createHash('sha256').update(secret).digest('hex');
   await tx.query(`INSERT INTO "PublishingSendCapability"(id,"jobId","intentId",revision,generation,platform,"accountBindingId","accountVersion","providerAccountId","connectionId","contentHash",owner,epoch,actor,"workerToken","rootAttemptId","retryGenerationId","tokenHash","expiresAt")
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,LEAST($19::timestamptz,clock_timestamp()+$20*interval '1 millisecond'))`,[authorizationId,job.id,job.intentId,job.revision,job.generation,job.platform,job.accountBindingId,job.accountVersion,job.providerAccountId,job.connectionId,job.contentHash,input.owner,String(input.epoch),input.actor,input.workerToken,rootAttemptId,retryGenerationId,tokenHash,proof.validUntil,ttl]);
   await tx.query(`INSERT INTO "PublishingAuthorizationOperation"("operationId","authorizationId",actor,"requestHash") VALUES($1,$2,$3,$4)`,[input.operationId,authorizationId,input.actor,requestHash]);
   return {authorizationId,secret,target:target(job)};
  });
  if('receipt'in committed)return committed.receipt!;
  // Mint only after the top-level adapter confirms COMMIT. Never mint on recovery.
  const capability=Object.freeze({}) as PublicationCapability;
  registry.set(capability,{id:committed.authorizationId!,secret:committed.secret!,target:committed.target!,used:false});
  return {outcome:'AUTHORIZED',authorizationId:committed.authorizationId!,maySend:true,capability};
 }
 async function recover(operationId:string){identifier(operationId);return atomic(async tx=>{
  const row=(await tx.query(`SELECT o."authorizationId",c."jobId",c."intentId",c.revision,c.generation,c.state,c."expiresAt"<=clock_timestamp() AS expired FROM "PublishingAuthorizationOperation" o JOIN "PublishingSendCapability" c ON c.id=o."authorizationId" WHERE o."operationId"=$1`,[operationId])).rows[0]??null;
  return {record:row,maySend:false as const};
 });}
 async function consume(capability:PublicationCapability|undefined,expected:PublicationTarget){
  expected=Object.freeze({...expected});validTarget(expected);const handle=capability&&registry.get(capability);ensure(handle&&!handle.used,'PUBLICATION_CAPABILITY_REQUIRED');
  ensure(policyHash(handle.target)===policyHash(expected),'CAPABILITY_PUBLICATION_MISMATCH');handle.used=true;
  return atomic(async tx=>{
   const metadata=(await tx.query(`SELECT * FROM "PublishingSendCapability" WHERE id=$1`,[handle.id])).rows[0];ensure(metadata,'CAPABILITY_MISSING');
   const owner=(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0];ensure(owner?.enabled&&owner.state===metadata.owner&&String(owner.epoch)===String(metadata.epoch),'CAPABILITY_OWNERSHIP_FENCED');
   const job=await readJob(tx,expected.jobId);ensure(policyHash(target(job))===policyHash(expected),'CAPABILITY_PUBLICATION_MISMATCH');
   ensure(job.workerToken===metadata.workerToken,'CAPABILITY_WORKER_FENCED');
   const validated=await deps.validation.validateExecution(tx,job);
   const i=(await tx.query(`SELECT * FROM "PublishingIntent" WHERE id=$1 FOR UPDATE`,[job.intentId])).rows[0];ensure(i?.state==='ACTIVE'&&i.currentRevision===job.revision,'INTENT_FENCED');
   const j=(await tx.query(`SELECT phase FROM "PublishingJob" WHERE id=$1 FOR UPDATE`,[job.id])).rows[0];ensure(j?.phase==='EXTERNAL_PENDING','PUBLICATION_ALREADY_RESOLVED');
   const c=(await tx.query(`SELECT *,"expiresAt">clock_timestamp() AS live FROM "PublishingSendCapability" WHERE id=$1 FOR UPDATE`,[handle.id])).rows[0];
   ensure(c.state==='ISSUED'&&c.live&&c.tokenHash===createHash('sha256').update(handle.secret).digest('hex'),'CAPABILITY_EXPIRED_REVOKED_OR_SPENT');
   const post=(await tx.query(`SELECT platform,"postType",caption,cta,hashtags,"taggedAccounts","linkUrl","tikTokSettings" FROM "CalendarPost" WHERE id=$1`,[job.postId])).rows[0];
   const assets=(await tx.query(`SELECT id,"fileKey","mediaType","displayOrder",to_jsonb(a)->>'objectVersion' AS "objectVersion",to_jsonb(a)->>'contentSha256' AS "contentSha256" FROM "CalendarPostAsset" a WHERE "postId"=$1 ORDER BY "displayOrder",id`,[job.postId])).rows;
   ensure(post&&publishingContentHash(post,assets)===job.contentHash,'SUBMISSION_CONTENT_CHANGED');
   await tx.query(`UPDATE "PublishingSendCapability" SET state='CONSUMED',"consumedAt"=clock_timestamp(),"consumedFenceVersion"=$2,"consumedValidUntil"=LEAST("expiresAt",$3::timestamptz) WHERE id=$1`,[c.id,validated.fenceVersion,validated.validUntil]);
   await tx.query(`INSERT INTO "PublishingCapabilityEvent"("operationId","authorizationId",transition,actor,"requestHash") VALUES($1,$2,'CONSUMED',$3,$4)`,[randomUUID(),c.id,c.actor,policyHash(expected)]);
   return {authorizationId:c.id as string,actor:c.actor as string,deadline:new Date(Math.min(c.expiresAt.getTime(),validated.validUntil.getTime())),submission:seal({target:{...expected},post,assets,authorization:{id:c.id,actor:c.actor,owner:c.owner,epoch:String(c.epoch),rootAttemptId:c.rootAttemptId,retryGenerationId:c.retryGenerationId,expiresAt:new Date(Math.min(c.expiresAt.getTime(),validated.validUntil.getTime())).toISOString()}}) as ProviderSubmission};
  });
 }
 async function revoke(input:{operationId:string;authorizationId:string;actor:string;reason:string}){
  input=Object.freeze({...input});
  for(const s of [input.operationId,input.authorizationId,input.actor])identifier(s);ensure(typeof input.reason==='string'&&input.reason.length>0&&input.reason.length<=200,'INVALID_REVOCATION_REASON');
  return atomic(async tx=>{
   const c=(await tx.query(`SELECT * FROM "PublishingSendCapability" WHERE id=$1 FOR UPDATE`,[input.authorizationId])).rows[0];ensure(c&&c.actor===input.actor,'CAPABILITY_ACTOR_CONFLICT');
   const digest=policyHash(input),prior=(await tx.query(`SELECT * FROM "PublishingCapabilityEvent" WHERE "operationId"=$1`,[input.operationId])).rows[0];
   if(prior){ensure(prior.requestHash===digest,'OPERATION_CONFLICT');return {outcome:'REVOKED',maySend:false as const};}
   if(c.state!=='ISSUED')return {outcome:'PENDING_RECONCILIATION',maySend:false as const};
   await tx.query(`UPDATE "PublishingSendCapability" SET state='REVOKED' WHERE id=$1`,[c.id]);
   await tx.query(`INSERT INTO "PublishingCapabilityEvent"("operationId","authorizationId",transition,actor,"requestHash") VALUES($1,$2,'REVOKED',$3,$4)`,[input.operationId,c.id,input.actor,digest]);return {outcome:'REVOKED',maySend:false as const};
  });
 }
 async function recordOutcome(input:{operationId:string;authorizationId:string;actor:string;outcome:Exclude<Outcome,'AUTHORIZED'>;reference?:string}){
  input=Object.freeze({...input});
  for(const s of [input.operationId,input.authorizationId,input.actor])identifier(s);
  ensure(['ACCEPTED','CONFIRMED','REJECTED','UNKNOWN'].includes(input.outcome),'INVALID_OUTCOME');ensure(input.reference===undefined||typeof input.reference==='string'&&input.reference.length>0&&input.reference.length<=500,'INVALID_REFERENCE');
  return atomic(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`auth-outcome:${input.operationId}`]);
   const old=(await tx.query(`SELECT * FROM "PublishingAuthorizationOutcome" WHERE "operationId"=$1`,[input.operationId])).rows[0],digest=policyHash(input);
   if(old){ensure(old.requestHash===digest,'OPERATION_CONFLICT');return {replay:true,maySend:false as const};}
   const c=(await tx.query(`SELECT * FROM "PublishingSendCapability" WHERE id=$1`,[input.authorizationId])).rows[0];ensure(c&&c.actor===input.actor&&c.state==='CONSUMED','OUTCOME_REQUIRES_SPENT_CAPABILITY');
   await tx.query(`SELECT id FROM "PublishingIntent" WHERE id=$1 FOR UPDATE`,[c.intentId]);
   await tx.query(`SELECT id FROM "PublishingJob" WHERE id=$1 FOR UPDATE`,[c.jobId]);
   if(c.rootAttemptId)await createPublishingOwnership({transaction:fn=>fn(tx)}).recordOutcome({operationId:randomUUID(),attemptId:c.rootAttemptId,actor:input.actor,outcome:input.outcome,remoteReference:input.reference});
   else{
    const g=(await tx.query(`SELECT * FROM "PublishingRetryGeneration" WHERE id=$1 FOR UPDATE`,[c.retryGenerationId])).rows[0];ensure(outcomeAllowed(g.outcome,input.outcome),'OUTCOME_TERMINAL');ensure(!g.remoteReference||!input.reference||g.remoteReference===input.reference,'REFERENCE_CONFLICT');
    ensure(!['ACCEPTED','CONFIRMED'].includes(input.outcome)||g.remoteReference||input.reference,'REFERENCE_REQUIRED');
    await tx.query(`INSERT INTO "PublishingRetryEvent"("operationId","generationId",outcome,"remoteReference",actor) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),g.id,input.outcome,input.reference??null,input.actor]);
    await tx.query(`UPDATE "PublishingRetryGeneration" SET outcome=$2,"remoteReference"=COALESCE("remoteReference",$3) WHERE id=$1`,[g.id,input.outcome,input.reference??null]);
   }
   const phase={ACCEPTED:'PROVIDER_PENDING',CONFIRMED:'CONFIRMED',REJECTED:'REJECTED',UNKNOWN:'OUTCOME_UNKNOWN'}[input.outcome];
   await tx.query(`UPDATE "PublishingJob" SET phase=$2,"remoteId"=COALESCE("remoteId",$3) WHERE id=$1`,[c.jobId,phase,input.reference??null]);
   await tx.query(`INSERT INTO "PublishingAuthorizationOutcome"("operationId","authorizationId",actor,outcome,"remoteReference","requestHash") VALUES($1,$2,$3,$4,$5,$6)`,[input.operationId,c.id,input.actor,input.outcome,input.reference??null,digest]);return {replay:false,maySend:false as const};
  });
 }
 return {authorize,recover,revoke,recordOutcome,registerProviderRequest:registerProviderExecutionRequest,
  /** No global fetch fallback, URLs or caller payloads. Driver is trusted synthetic composition. */
  transport(driver:SyntheticPublicationDriver,options?:{persistObservation:(submission:ProviderSubmission,observation:ProviderObservation)=>Promise<ProviderObservation>}){ensure(typeof driver==='function','SYNTHETIC_DRIVER_REQUIRED');return {
   async publish(input:{target:PublicationTarget;capability?:PublicationCapability}):Promise<ProviderObservation>{
    ensure(input&&typeof input==='object','PUBLICATION_CONTEXT_REQUIRED');
    const spent=await consume(input.capability,input.target);
    ensure(Date.now()<spent.deadline.getTime(),'CAPABILITY_EXPIRED_BEFORE_INVOCATION');
    providerInvocations.set(spent.submission.authorization,{targetHash:policyHash(spent.submission.target)});
    let observed:ProviderObservation;
    try{observed=await driver(spent.submission);ensure(observed&&['ACCEPTED','CONFIRMED','REJECTED','UNKNOWN'].includes(observed.outcome),'INVALID_PROVIDER_OBSERVATION');}
    catch{observed={outcome:'UNKNOWN'};}
    finally{providerInvocations.delete(spent.submission.authorization);}
    if(options){try{return await options.persistObservation(spent.submission,observed);}catch{return {outcome:'UNKNOWN',...('reference'in observed&&observed.reference?{reference:observed.reference}:{})};}}
    try{await recordOutcome({operationId:randomUUID(),authorizationId:spent.authorizationId,actor:spent.actor,outcome:observed.outcome,reference:'reference'in observed?observed.reference:undefined});}
    catch{return {outcome:'UNKNOWN',...('reference'in observed&&observed.reference?{reference:observed.reference}:{})};}
    return observed;
   },
  };},
 };
}
