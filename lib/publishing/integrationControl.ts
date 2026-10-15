/** Explicit local cutover rehearsal; no automatic activation or invented no-send. */
import { policyHash } from './eligibilityPolicy';
import type { OwnershipDatabase,OwnershipTransaction } from './ownership';
import { createPublishingValidationAdapters, type ValidationDependencies } from './validationAdapters';
export function createPublishingIntegrationControl(deps:{database:OwnershipDatabase;validation:ValidationDependencies;verifyNeverAttempted?(tx:OwnershipTransaction,input:{postId:string;snapshotHash:string;evidenceReference:string}):Promise<{kind:'VERIFIED_NEVER_AUTHORIZED';evidenceHash:string}>;verifyStopped(tx:OwnershipTransaction,reference:string,epoch:bigint):Promise<{scope:'ALL_SENDERS';evidenceHash:string}>}){
 async function assertLegacyAllowed(){await deps.database.transaction(async tx=>{
  const o=(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0],c=(await tx.query(`SELECT mode FROM "PublishingIntegrationControl" WHERE id=1 FOR SHARE`)).rows[0];
  if(!o?.enabled||o.state!=='NETLIFY'||c?.mode!=='LEGACY'||(await tx.query(`SELECT 1 FROM "PublishingIntent" LIMIT 1`)).rows.length)throw Error('LEGACY_PUBLISHING_PATH_FENCED');
 });}
 async function activate(input:{operationId:string;actor:string;epoch:bigint;evidenceReference:string}){return deps.database.transaction(async tx=>{
  const hash=policyHash({...input,epoch:String(input.epoch)}),previous=(await tx.query(`SELECT * FROM "PublishingIntegrationEvent" WHERE "operationId"=$1`,[input.operationId])).rows[0];if(previous){if(previous.requestHash!==hash)throw Error('OPERATION_CONFLICT');return {mode:previous.mode,maySend:false};}
  const owner=(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0];if(owner.state!=='DRAINING'||BigInt(owner.epoch)!==input.epoch)throw Error('DRAINING_REQUIRED');
  const proof=await deps.verifyStopped(tx,input.evidenceReference,input.epoch);if(proof.scope!=='ALL_SENDERS'||!/^[a-f0-9]{64}$/.test(proof.evidenceHash))throw Error('TRUSTED_SENDER_STOP_REQUIRED');
  await tx.query(`INSERT INTO "PublishingSenderStopEvidence"(id,epoch,scope,"evidenceHash","verifiedBy") VALUES($1,$2,$3,$4,$5)`,[input.operationId,String(input.epoch),proof.scope,proof.evidenceHash,input.actor]);
  await tx.query(`UPDATE "PublishingIntegrationControl" SET mode='CANONICAL' WHERE id=1`);
  await tx.query(`INSERT INTO "PublishingIntegrationEvent"("operationId",mode,epoch,actor,"stopEvidenceId","requestHash") VALUES($1,'CANONICAL',$2,$3,$1,$4)`,[input.operationId,String(input.epoch),input.actor,hash]);return {mode:'CANONICAL',maySend:false};
 });}
 async function classify(postId:string,operationId:string){return deps.database.transaction(async tx=>{
  const p=(await tx.query(`SELECT * FROM "CalendarPost" WHERE id=$1`,[postId])).rows[0];if(!p)throw Error('POST_MISSING');
  const jobs=(await tx.query(`SELECT * FROM "PublishingJob" WHERE "postId"=$1`,[postId])).rows;
  const status=p.platform==='INSTAGRAM'?p.instagramPublishStatus:p.platform==='TIKTOK'?p.tikTokPublishStatus:p.publishStatus;
  const reference=p.tikTokPublishId??p.instagramMediaId??p.platformPostId??jobs.find(j=>j.remoteId)?.remoteId??null;
  const classification=status==='PUBLISHED'||jobs.some(j=>j.phase==='CONFIRMED')?'CONFIRMED':reference||p.publishWorkerStartedAt||p.tikTokInitStartedAt||status==='PUBLISHING'||status==='FAILED'||jobs.some(j=>!['READY','CANCELLED'].includes(j.phase))?'QUARANTINED':status==='SCHEDULED'&&p.approvalStatus==='APPROVED'&&!p.isAiDraft?'ADOPTABLE':'QUARANTINED';
  const snapshotHash=policyHash({p,jobs}),old=(await tx.query(`SELECT * FROM "PublishingLegacyDisposition" WHERE "postId"=$1`,[postId])).rows[0];if(old){if(old.snapshotHash!==snapshotHash)throw Error('LEGACY_SNAPSHOT_CHANGED');return old;}
  await tx.query(`INSERT INTO "PublishingLegacyDisposition"("postId",platform,classification,"snapshotHash","remoteReference","operationId") VALUES($1,$2,$3,$4,$5,$6)`,[postId,p.platform,classification,snapshotHash,reference,operationId]);return {classification,snapshotHash,reference};
 });}
 async function adopt(input:{operationId:string;actor:string;epoch:bigint;postId:string;intentId:string;platform:any;dueAt:Date;destination:{accountBindingId:string;accountVersion:number};adoptionEvidenceReference?:string}){return deps.database.transaction(async tx=>{
  const c=(await tx.query(`SELECT mode FROM "PublishingIntegrationControl" WHERE id=1 FOR SHARE`)).rows[0],o=(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0];
  if(c.mode!=='CANONICAL'||o.state!=='DRAINING'||BigInt(o.epoch)!==input.epoch||!(await tx.query(`SELECT 1 FROM "PublishingSenderStopEvidence" WHERE epoch=$1`,[String(input.epoch)])).rows.length)throw Error('ADOPTION_STOP_FENCE_REQUIRED');
  const d=(await tx.query(`SELECT * FROM "PublishingLegacyDisposition" WHERE "postId"=$1 FOR SHARE`,[input.postId])).rows[0];if(d?.classification!=='ADOPTABLE')throw Error('LEGACY_WORK_QUARANTINED');
  const {epoch:ignoredEpoch,...request}=input;
  const replay=(await tx.query(`SELECT 1 FROM "PublishingAction" WHERE "operationId"=$1`,[input.operationId])).rows[0];
  const p=(await tx.query(`SELECT * FROM "CalendarPost" WHERE id=$1`,[input.postId])).rows[0],jobs=(await tx.query(`SELECT * FROM "PublishingJob" WHERE "postId"=$1`,[input.postId])).rows;
  if(!replay&&policyHash({p,jobs})!==d.snapshotHash)throw Error('LEGACY_SNAPSHOT_CHANGED');
  if(!replay&&jobs.length)throw Error('EXISTING_LEGACY_JOB_REQUIRES_REVIEW');
  if(!replay){if(!deps.verifyNeverAttempted||!input.adoptionEvidenceReference)throw Error('TRUSTED_LEGACY_ADOPTION_PROOF_REQUIRED');const proof=await deps.verifyNeverAttempted(tx,{postId:input.postId,snapshotHash:d.snapshotHash,evidenceReference:input.adoptionEvidenceReference});if(proof.kind!=='VERIFIED_NEVER_AUTHORIZED'||!/^[a-f0-9]{64}$/.test(proof.evidenceHash))throw Error('TRUSTED_LEGACY_ADOPTION_PROOF_REQUIRED');await tx.query(`INSERT INTO "PublishingLegacyAdoptionProof"("postId","actionOperationId","snapshotHash","evidenceHash","stopEpoch") VALUES($1,$2,$3,$4,$5)`,[input.postId,input.operationId,d.snapshotHash,proof.evidenceHash,String(input.epoch)]);}
  const scoped={transaction:<T>(fn:(t:OwnershipTransaction)=>Promise<T>)=>fn(tx)};
  const v=createPublishingValidationAdapters({...deps.validation,database:scoped});return v.intentActions(async()=>{}).schedule({...request,expectedRevision:0});
 });}
 async function reconcileLegacy(input:{postId:string;operationId:string;actor:string},lookup:(disposition:Record<string,any>)=>Promise<{outcome:'CONFIRMED'|'REJECTED'|'UNKNOWN';reference?:string;evidenceHash:string;verified:boolean;actorStopped:boolean}>) {
  const d=await deps.database.transaction(async tx=>(await tx.query(`SELECT * FROM "PublishingLegacyDisposition" WHERE "postId"=$1`,[input.postId])).rows[0]);if(!d||d.classification!=='QUARANTINED'||!d.remoteReference)return {outcome:'UNKNOWN',maySend:false};
  const evidence=await lookup(d);if(!evidence.verified||!evidence.actorStopped||evidence.outcome==='UNKNOWN'||evidence.reference!==d.remoteReference||!/^[a-f0-9]{64}$/.test(evidence.evidenceHash))return {outcome:'UNKNOWN',maySend:false};
  return deps.database.transaction(async tx=>{await tx.query(`INSERT INTO "PublishingLegacyResolution"("operationId","postId",outcome,reference,"evidenceHash",actor) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[input.operationId,d.postId,evidence.outcome,evidence.reference,evidence.evidenceHash,input.actor]);return {outcome:evidence.outcome,maySend:false};});
 }
 return {activate,classify,adopt,reconcileLegacy,assertLegacyAllowed};
}
