/** Independent durable response capture, followed by idempotent outcome projection. */
import type { OwnershipDatabase } from './ownership';
import type { createExternalPublicationAuthorization, ProviderObservation } from './externalAuthorization';
import type { DurableProviderSpool, ProviderJournalEvent } from './providerSpool';
import { policyHash } from './eligibilityPolicy';
export function createProviderJournal(deps:{database:OwnershipDatabase;authorization:ReturnType<typeof createExternalPublicationAuthorization>;spool:DurableProviderSpool}){
 async function append(event:ProviderJournalEvent){
  const {id,...body}=event;
  if(id!==policyHash(body)||!['SUBMISSION','RESPONSE','STATUS'].includes(event.kind)||!['ACCEPTED','CONFIRMED','REJECTED','UNKNOWN'].includes(event.outcome)||!/^[a-f0-9]{64}$/.test(event.responseHash)||
    (event.reference!==undefined&&(typeof event.reference!=='string'||!event.reference.length||event.reference.length>500))||(['ACCEPTED','CONFIRMED'].includes(event.outcome)&&!event.reference)||
    (event.publicationReferences!==undefined&&(!Array.isArray(event.publicationReferences)||event.publicationReferences.length>35||event.publicationReferences.some(r=>typeof r!=='string'||!r.length||r.length>500)))||
    (event.permalink!==undefined&&(typeof event.permalink!=='string'||event.permalink.length>2000||!/^https:\/\//.test(event.permalink))))throw Error('INVALID_PROVIDER_JOURNAL_EVENT');
  // WAL precedes DB capture; known references survive a failed DB write/projection.
  let spooled=true;try{await deps.spool.append(event);}catch(error){spooled=false;if(event.kind==='SUBMISSION')throw error;}
  try{await deps.database.transaction(async tx=>{
   const c=(await tx.query(`SELECT "jobId",platform,state FROM "PublishingSendCapability" WHERE id=$1`,[event.authorizationId])).rows[0];if(!c||c.jobId!==event.jobId||c.platform!==event.platform||c.state!=='CONSUMED')throw Error('JOURNAL_CAPABILITY_CONFLICT');
   const old=(await tx.query(`SELECT * FROM "PublishingProviderJournal" WHERE id=$1`,[event.id])).rows[0];
   if(old){if(old.responseHash!==event.responseHash||old.reference!==(event.reference??null)||old.outcome!==event.outcome||old.authorizationId!==event.authorizationId||old.operation!==event.operation||old.kind!==event.kind||policyHash(old.publicationReferences??null)!==policyHash(event.publicationReferences??null)||(old.permalink??null)!==(event.permalink??null))throw Error('JOURNAL_OPERATION_CONFLICT');return;}
   await tx.query(`INSERT INTO "PublishingProviderJournal"(id,"authorizationId","jobId",platform,kind,outcome,reference,"responseHash",operation,"publicationReferences",permalink) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[event.id,event.authorizationId,event.jobId,event.platform,event.kind,event.outcome,event.reference??null,event.responseHash,event.operation,event.publicationReferences??null,event.permalink??null]);
  });return {database:true,spooled};}catch{return {database:false,spooled};}
 }
 async function observations(authorizationId:string){
  const spool=await deps.spool.records(authorizationId);let rows:ProviderJournalEvent[]=[];
  try{rows=await deps.database.transaction(async tx=>(await tx.query(`SELECT id,"authorizationId","jobId",platform,kind,outcome,reference,"responseHash",operation,"publicationReferences",permalink FROM "PublishingProviderJournal" WHERE "authorizationId"=$1 ORDER BY "createdAt",id`,[authorizationId])).rows as ProviderJournalEvent[]);}catch{/* spool remains durable */}
  const all=new Map<string,ProviderJournalEvent>();for(const e of [...spool,...rows]){const event={...e,reference:e.reference??undefined,publicationReferences:e.publicationReferences??undefined,permalink:e.permalink??undefined},{id,...body}=event;if(id!==policyHash(body))throw Error('JOURNAL_INTEGRITY_FAILED');all.set(id,event);}return [...all.values()];
 }
 async function project(event:ProviderJournalEvent):Promise<ProviderObservation>{
  const c=await deps.database.transaction(async tx=>{
   const cap=(await tx.query(`SELECT * FROM "PublishingSendCapability" WHERE id=$1`,[event.authorizationId])).rows[0];if(!cap||cap.state!=='CONSUMED'||cap.jobId!==event.jobId||cap.platform!==event.platform)throw Error('JOURNAL_CAPABILITY_CONFLICT');
   const a=cap.rootAttemptId?(await tx.query(`SELECT outcome,"remoteReference" FROM "PublishingExternalAttempt" WHERE id=$1`,[cap.rootAttemptId])).rows[0]:(await tx.query(`SELECT outcome,"remoteReference" FROM "PublishingRetryGeneration" WHERE id=$1`,[cap.retryGenerationId])).rows[0];
   return {actor:cap.actor,outcome:a.outcome,reference:a.remoteReference};
  });
  if(c.outcome==='CONFIRMED'){if(event.reference&&event.reference!==c.reference)throw Error('REFERENCE_CONFLICT');return {outcome:'CONFIRMED',reference:c.reference};}
  if(c.outcome==='REJECTED'){if(event.outcome!=='REJECTED')throw Error('TERMINAL_PROVIDER_CONFLICT');return {outcome:'REJECTED'};}
  if(c.outcome!==event.outcome||c.reference!==(event.reference??null))await deps.authorization.recordOutcome({operationId:'provider-'+event.id,authorizationId:event.authorizationId,actor:c.actor,outcome:event.outcome,reference:event.reference});
  return event.outcome==='ACCEPTED'||event.outcome==='CONFIRMED'?{outcome:event.outcome,reference:event.reference!}:event.outcome==='UNKNOWN'?{outcome:'UNKNOWN',...(event.reference?{reference:event.reference}:{})}:{outcome:'REJECTED'};
 }
 async function capture(event:ProviderJournalEvent){const saved=await append(event);if(!saved.database&&!saved.spooled)return {outcome:'UNKNOWN',...(event.reference?{reference:event.reference}:{})} as ProviderObservation;if(event.kind==='SUBMISSION')return {outcome:'UNKNOWN'} as ProviderObservation;
  try{return await project(event);}catch{return {outcome:'UNKNOWN',...(event.reference?{reference:event.reference}:{})} as ProviderObservation;}
 }
 return {append,observations,capture,project,
  event(input:Omit<ProviderJournalEvent,'id'>):ProviderJournalEvent{return {...input,id:policyHash(input)};},
 };
}
