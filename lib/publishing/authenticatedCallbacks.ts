import {createHmac,timingSafeEqual} from 'node:crypto';
import {policyHash} from './eligibilityPolicy';
import type {OwnershipDatabase} from './ownership';
import type {createCapabilityProviderIntegration} from './capabilityProviders';
export function createAuthenticatedPublishingCallbacks(deps:{database:OwnershipDatabase;secret:Uint8Array;providers:Pick<ReturnType<typeof createCapabilityProviderIntegration>,'observe'>;
 parse(platform:string,body:Uint8Array):{eventId:string;accountId:string;reference:string;outcome:'ACCEPTED'|'CONFIRMED'|'UNKNOWN'}}){
 if(deps.secret.length<32)throw Error('CALLBACK_SECRET_TOO_SHORT');
 return async(platform:string,body:Uint8Array,timestamp:string,signature:string)=>{
  if(!['INSTAGRAM','TIKTOK','FACEBOOK','LINKEDIN','X'].includes(platform)||body.byteLength>65536||!/^[0-9]+$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>300000)throw Error('CALLBACK_AUTHENTICATION_FAILED');
  const expected=createHmac('sha256',deps.secret).update(timestamp+'.').update(body).digest(),given=Buffer.from(signature,'hex');if(given.length!==expected.length||!timingSafeEqual(given,expected))throw Error('CALLBACK_AUTHENTICATION_FAILED');
  const event=deps.parse(platform,body),payloadHash=policyHash(Buffer.from(body).toString('base64'));
  const cap=await deps.database.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`callback:${platform}:${event.eventId}`]);
   const old=(await tx.query(`SELECT * FROM "PublishingProviderCallback" WHERE platform=$1 AND "eventId"=$2`,[platform,event.eventId])).rows[0];if(old){if(old.payloadHash!==payloadHash)throw Error('CALLBACK_REPLAY_CONFLICT');return old.authorizationId?(await tx.query(`SELECT * FROM "PublishingSendCapability" WHERE id=$1`,[old.authorizationId])).rows[0]:null;}
   const candidates=(await tx.query(`SELECT DISTINCT c.* FROM "PublishingSendCapability" c JOIN "PublishingProviderJournal" j ON j."authorizationId"=c.id WHERE c.platform=$1 AND c."providerAccountId"=$2 AND (j.reference=$3 OR $3=ANY(j."publicationReferences")) AND c.state='CONSUMED' LIMIT 2`,[platform,event.accountId,event.reference])).rows;
   // An ambiguous provider reference must not select whichever row happens first.
   const c=candidates.length===1?candidates[0]:null;
   await tx.query(`INSERT INTO "PublishingProviderCallback"(platform,"eventId","payloadHash","authorizationId") VALUES($1,$2,$3,$4)`,[platform,event.eventId,payloadHash,c?.id??null]);return c;
  });
  if(!cap)return {state:'quarantined',maySend:false};
  const original=await deps.database.transaction(async tx=>(await tx.query(`SELECT reference FROM "PublishingProviderJournal" WHERE "authorizationId"=$1 AND reference IS NOT NULL ORDER BY "createdAt",id LIMIT 1`,[cap.id])).rows[0]?.reference);
  const observation={authorizationId:cap.id,jobId:cap.jobId,platform,kind:'STATUS' as const,outcome:event.outcome,reference:original??event.reference,...(original&&original!==event.reference?{publicationReferences:[event.reference]}:{}),responseHash:payloadHash,operation:'authenticated-callback'};
  const result=await deps.providers.observe({...observation,id:policyHash(observation)});return {state:result.outcome,maySend:false};
 };
}
/** Meta raw-body ingress; normalization must map documented events to known references.
 * No normalization is allowed before signature verification and no send is granted.
 */
export function createMetaPublishingCallbacks(deps:{database:OwnershipDatabase;secret:Uint8Array;providers:Pick<ReturnType<typeof createCapabilityProviderIntegration>,'observe'>;
 normalize(platform:'INSTAGRAM'|'FACEBOOK',body:Uint8Array):{eventId:string;accountId:string;reference:string;outcome:'ACCEPTED'|'CONFIRMED'|'UNKNOWN'}[]}) {
 if(deps.secret.length<32)throw Error('CALLBACK_SECRET_TOO_SHORT');
 return async(platform:'INSTAGRAM'|'FACEBOOK',body:Uint8Array,signature:string)=>{
  if(!['INSTAGRAM','FACEBOOK'].includes(platform)||body.byteLength>65536||!/^sha256=[a-f0-9]{64}$/.test(signature))throw Error('CALLBACK_AUTHENTICATION_FAILED');
  const expected=createHmac('sha256',deps.secret).update(body).digest(),given=Buffer.from(signature.slice(7),'hex');
  if(!timingSafeEqual(expected,given))throw Error('CALLBACK_AUTHENTICATION_FAILED');
  const events=deps.normalize(platform,body);if(!Array.isArray(events)||events.length>100)throw Error('CALLBACK_EVENT_LIMIT');
  const timestamp=String(Date.now()),normalizedSignature=createHmac('sha256',deps.secret).update(timestamp+'.').update(body).digest('hex');
  const results=[];for(const event of events){
   if(!event.eventId||!event.accountId||!event.reference||![event.eventId,event.accountId,event.reference].every(v=>typeof v==='string'&&v.length<=500)||!['ACCEPTED','CONFIRMED','UNKNOWN'].includes(event.outcome))throw Error('CALLBACK_EVENT_INVALID');
   const handler=createAuthenticatedPublishingCallbacks({...deps,parse:()=>event});results.push(await handler(platform,body,timestamp,normalizedSignature));
  }
  return {maySend:false as const,results};
 };
}
