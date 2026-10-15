/** Stage 4C.4 mock-only provider composition. No live native default exports/imports. */
import { buildCaption, validatePublishContent } from './state';
import { parseTikTokSettings, validateTikTokSettings, tikTokPostInfo, type TikTokCreator } from '../tiktokSettings';
import { policyHash, publishingContentHash } from './eligibilityPolicy';
import type { CanonicalJob } from './canonicalContract';
import type { OwnershipDatabase } from './ownership';
import type { PublicationTarget, PublicationCapability, ProviderSubmission, ProviderObservation, createExternalPublicationAuthorization } from './externalAuthorization';
import { createProviderJournal } from './providerJournal';
import type { DurableProviderSpool } from './providerSpool';
import type { createPublishingValidationAdapters } from './validationAdapters';
export type PreparationOperation='IG_CONTAINER'|'IG_CAROUSEL'|'IG_CONTAINER_STATUS'|'FB_PHOTO'|'FB_REEL_START'|'FB_REEL_UPLOAD'|'LI_MEDIA'|'X_MEDIA';
export type PublicationOperation='IG_MEDIA_PUBLISH'|'TT_VIDEO_INIT'|'TT_PHOTO_INIT'|'FB_FEED'|'FB_VIDEO'|'FB_REEL_FINISH'|'LI_POST'|'X_TWEET';
export type LookupOperation='IG_PERMALINK'|'TT_STATUS'|'FB_VIDEO_STATUS'|'LI_POST_GET'|'X_TWEET_GET';
export interface MockProviderResponse {status:number;body:Record<string,any>;headers?:Record<string,string>;definitiveNoSend?:{verified:true;evidenceReference:string}}
export interface MockProviderIO {
 kind:'local-mock'|'native-disabled'|'native-reviewed';refresh(target:PublicationTarget,options?:{reconciliation:true}):Promise<void>;
 reserveRate(target:PublicationTarget,kind:'creator'|'init'|'status'):Promise<void>;
 creatorInfo(target:PublicationTarget):Promise<TikTokCreator>;
 media(target:PublicationTarget,assets:readonly Record<string,unknown>[],creator?:TikTokCreator):Promise<string[]>;
 prepare(target:PublicationTarget,operation:PreparationOperation,payload:Record<string,unknown>):Promise<MockProviderResponse>;
 submit(target:PublicationTarget,operation:PublicationOperation,payload:Record<string,unknown>,authorization:ProviderSubmission['authorization']):Promise<MockProviderResponse>;
 lookup(target:PublicationTarget,operation:LookupOperation,reference:string):Promise<MockProviderResponse>;
 report?(target:PublicationTarget,reference:string):Promise<void>;
}
function check(ok:unknown,code:string):asserts ok{if(!ok)throw Error(code);}
function ref(value:unknown):string|undefined{return typeof value==='string'&&value.length>0&&value.length<=500?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):undefined;}
function okay(r:MockProviderResponse){return r.status>=200&&r.status<300&&(!r.body.error||r.body.error.code==='ok');}
export function classifyProviderSubmission(operation:PublicationOperation,response:MockProviderResponse,artifact:any):ProviderObservation{
  if(!okay(response))return response.status<500&&response.definitiveNoSend?.verified&&response.definitiveNoSend.evidenceReference?{outcome:'REJECTED'}:{outcome:'UNKNOWN'};
  let reference=operation==='LI_POST'?ref(response.headers?.['x-restli-id']):operation==='X_TWEET'?ref(response.body.data?.id):operation.startsWith('TT_')?ref(response.body.data?.publish_id??response.body.publish_id):operation==='FB_REEL_FINISH'?ref(response.body.id??artifact.refs[0]):ref(response.body.post_id??response.body.id);
  if(!reference)return {outcome:'UNKNOWN'};
  return {outcome:(['TT_VIDEO_INIT','TT_PHOTO_INIT','FB_VIDEO','FB_REEL_FINISH'].includes(operation)||(operation==='LI_POST'&&response.body.lifecycleState!=='PUBLISHED'))?'ACCEPTED':'CONFIRMED',reference};
 }

export function createCapabilityProviderIntegration(deps:{environment:'isolated-mock'|'production-canonical';database:OwnershipDatabase;authorization:ReturnType<typeof createExternalPublicationAuthorization>;
 validation:Pick<ReturnType<typeof createPublishingValidationAdapters>,'validateExecution'>;spool:DurableProviderSpool;io:MockProviderIO;signal?:AbortSignal}){
 check(deps.environment==='isolated-mock'&&deps.io.kind==='local-mock'||deps.environment==='production-canonical'&&deps.io.kind==='native-reviewed','REVIEWED_PROVIDER_COMPOSITION_REQUIRED');
 const journal=createProviderJournal(deps);
 // Cooperative worker shutdown fences each next provider operation. An already
 // submitted request may still finish; its response must still be journaled.
 const io=new Proxy(deps.io,{get(object,key){const value=Reflect.get(object,key);if(typeof value!=='function')return value;
  return (...args:unknown[])=>{if(deps.signal?.aborted)throw Error('PROVIDER_INTEGRATION_STOPPING');return Reflect.apply(value,object,args);};}});
 async function snapshot(target:PublicationTarget){
  return deps.database.transaction(async tx=>{
   const r=(await tx.query(`SELECT j.id,j."postId",j.platform,j.phase,j."workerToken",j."remoteId",j."intentId",j."intentRevision" AS revision,r."dueAt",b."accountBindingId",b."accountVersion",b."contentHash",a."calendarId",v."providerAccountId",v."connectionId",COALESCE(g.generation,1) AS generation
    FROM "PublishingJob" j JOIN "PublishingCanonicalRevision" b ON b."jobId"=j.id JOIN "PublishingIntentRevision" r ON r."intentId"=j."intentId" AND r.revision=j."intentRevision" JOIN "PublishingAccountBinding" a ON a.id=b."accountBindingId"
    JOIN "PublishingAccountVersion" v ON v."bindingId"=a.id AND v.version=b."accountVersion" LEFT JOIN "PublishingRetryGeneration" g ON g."jobId"=j.id WHERE j.id=$1`,[target.jobId])).rows[0] as CanonicalJob;
   check(r,'CANONICAL_JOB_MISSING');check(['intentId','revision','generation','platform','accountBindingId','accountVersion','providerAccountId','connectionId','contentHash'].every(k=>(r as any)[k]===(target as any)[k]),'PROVIDER_TARGET_CONFLICT');
   await deps.validation.validateExecution(tx,r);
   const post=(await tx.query(`SELECT platform,"postType",caption,cta,hashtags,"taggedAccounts","linkUrl","tikTokSettings" FROM "CalendarPost" WHERE id=$1`,[r.postId])).rows[0];
   const assets=(await tx.query(`SELECT id,"fileKey","mediaType","displayOrder",to_jsonb(a)->>'objectVersion' AS "objectVersion",to_jsonb(a)->>'contentSha256' AS "contentSha256" FROM "CalendarPostAsset" a WHERE "postId"=$1 ORDER BY "displayOrder",id`,[r.postId])).rows;
   check(publishingContentHash(post,assets)===target.contentHash,'PROVIDER_CONTENT_CHANGED');return {post,assets};
  });
 }
 async function prepare(target:PublicationTarget){
  target=Object.freeze({...target});
  // Exact immutable destination is checked before credential rotation; rotation
  // is outside DB transactions and never provides a publication capability.
  const existing=await deps.database.transaction(async tx=>(await tx.query(`SELECT * FROM "PublishingProviderPreparation" WHERE "jobId"=$1`,[target.jobId])).rows[0]);
  // Refresh is a required trusted adapter, scoped to this DB-bound destination.
  await deps.database.transaction(async tx=>{
   const bound=(await tx.query(`SELECT v."connectionId",v."providerAccountId" FROM "PublishingAccountVersion" v JOIN "PublishingAccountBinding" b ON b.id=v."bindingId" JOIN "SocialConnection" s ON s.id=v."connectionId" WHERE b.id=$1 AND b."currentVersion"=$2 AND v.version=$2 AND b.state='CONNECTED' AND s.status='CONNECTED' AND s.platform=$3 AND s."platformAccountId"=v."providerAccountId"`,[target.accountBindingId,target.accountVersion,target.platform])).rows[0];
   check(bound&&bound.connectionId===target.connectionId&&bound.providerAccountId===target.providerAccountId,'REFRESH_DESTINATION_CHANGED');
  });await io.refresh(target);const {post,assets}=await snapshot(target);
  if(existing){check(existing.targetHash===policyHash(target),'PREPARATION_TARGET_CONFLICT');return {prepared:true,maySend:false as const};}
  validatePublishContent(target.platform,assets as {mediaType:string}[],buildCaption(post as any),post.postType);
  const video=assets.some(a=>a.mediaType==='VIDEO'),caption=buildCaption(post as any);let refs:string[]=[];let creator:TikTokCreator|undefined;
  if(target.platform==='TIKTOK'){await io.reserveRate(target,'creator');creator=await io.creatorInfo(target);validateTikTokSettings(parseTikTokSettings(post.tikTokSettings),creator,video);}
  const media=await io.media(target,assets,creator);
  if(target.platform==='INSTAGRAM'){
   for(let i=0;i<assets.length;i++){const r=await io.prepare(target,'IG_CONTAINER',{media:media[i],mediaType:assets[i].mediaType,carousel:assets.length>1,caption:assets.length===1?buildCaption({...post,linkUrl:null} as any):undefined});check(okay(r)&&ref(r.body.id),'IG_CONTAINER_NOT_READY');refs.push(ref(r.body.id)!);
    if(assets[i].mediaType==='VIDEO'){const status=await io.prepare(target,'IG_CONTAINER_STATUS',{reference:refs.at(-1)});check(okay(status)&&status.body.status_code==='FINISHED','IG_CONTAINER_NOT_READY');}}
   if(refs.length>1){const r=await io.prepare(target,'IG_CAROUSEL',{children:refs,caption:buildCaption({...post,linkUrl:null} as any)});check(okay(r)&&ref(r.body.id),'IG_CAROUSEL_NOT_READY');refs=[ref(r.body.id)!];}
  }else if(target.platform==='FACEBOOK'){
   if(video&&/reel/i.test(post.postType??'')){const r=await io.prepare(target,'FB_REEL_START',{upload_phase:'start'});check(okay(r)&&ref(r.body.video_id),'FB_REEL_NOT_READY');refs=[ref(r.body.video_id)!];const upload=await io.prepare(target,'FB_REEL_UPLOAD',{video_id:refs[0],media:media[0],...(r.body.upload_url?{uploadUrl:r.body.upload_url}:{})});check(okay(upload),'FB_REEL_NOT_READY');}
   else if(!video)for(const url of media){const r=await io.prepare(target,'FB_PHOTO',{url,published:false});check(okay(r)&&ref(r.body.id),'FB_PHOTO_NOT_READY');refs.push(ref(r.body.id)!);}
  }else if(target.platform==='LINKEDIN'||target.platform==='X')for(let i=0;i<media.length;i++){const r=await io.prepare(target,target.platform==='X'?'X_MEDIA':'LI_MEDIA',{media:media[i],mediaType:assets[i].mediaType});check(okay(r)&&ref(r.body.id),'MEDIA_NOT_READY');refs.push(ref(r.body.id)!);}
  const artifact={media,refs,video,creator:creator??null};await snapshot(target);
  await deps.database.transaction(async tx=>{
   const old=(await tx.query(`SELECT * FROM "PublishingProviderPreparation" WHERE "jobId"=$1`,[target.jobId])).rows[0];
   if(old){check(old.targetHash===policyHash(target),'PREPARATION_TARGET_CONFLICT');return;}
   await tx.query(`INSERT INTO "PublishingProviderPreparation"("jobId","targetHash","contentHash",artifact) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[target.jobId,policyHash(target),target.contentHash,artifact]);
  });return {prepared:true,maySend:false as const};
 }
 const transport=deps.authorization.transport(async submission=>{
  const t=submission.target;
  const p=await deps.database.transaction(async tx=>(await tx.query(`SELECT * FROM "PublishingProviderPreparation" WHERE "jobId"=$1`,[t.jobId])).rows[0]);
  check(p&&p.targetHash===policyHash(t)&&p.contentHash===t.contentHash,'PROVIDER_PREPARATION_REQUIRED');const a=p.artifact;
  const caption=buildCaption(submission.post as any);let operation:PublicationOperation,payload:Record<string,unknown>;
  switch(t.platform){
   case 'INSTAGRAM':operation='IG_MEDIA_PUBLISH';payload={creation_id:a.refs[0]};break;
   case 'TIKTOK':{
    const settings=parseTikTokSettings(submission.post.tikTokSettings);await io.reserveRate(t,'creator');const creator=await io.creatorInfo(t);validateTikTokSettings(settings,creator,a.video);await io.reserveRate(t,'init');
    operation=a.video?'TT_VIDEO_INIT':'TT_PHOTO_INIT';payload={post_info:{...tikTokPostInfo(settings,creator,a.video),title:a.video?caption:settings.photoTitle,...(!a.video?{description:caption}:{})},source_info:{source:'PULL_FROM_URL',...(a.video?{video_url:a.media[0]}:{photo_images:a.media})},...(!a.video?{media_type:'PHOTO',post_mode:'DIRECT_POST',is_aigc:settings.isAigc}:{})};break;
   }
   case 'FACEBOOK':operation=a.video?/reel/i.test(String(submission.post.postType??''))?'FB_REEL_FINISH':'FB_VIDEO':'FB_FEED';payload=operation==='FB_REEL_FINISH'?{upload_phase:'finish',video_state:'PUBLISHED',video_id:a.refs[0],description:caption}:operation==='FB_VIDEO'?{file_url:a.media[0],description:caption}:{message:caption,...(a.refs.length?{attached_media:a.refs.map((id:string)=>({media_fbid:id}))}:submission.post.linkUrl?{link:submission.post.linkUrl}:{})};break;
   case 'LINKEDIN':operation='LI_POST';payload={author:t.providerAccountId.startsWith('urn:li:')?t.providerAccountId:`urn:li:person:${t.providerAccountId}`,commentary:caption,lifecycleState:'PUBLISHED',visibility:'PUBLIC',media:a.refs};break;
   case 'X':operation='X_TWEET';payload={text:caption,...(a.refs.length?{media:{media_ids:a.refs}}:{})};break;
  }
  deps.authorization.registerProviderRequest(submission.authorization,t,operation,payload);
  const base={authorizationId:submission.authorization.id,jobId:t.jobId,platform:t.platform,operation};
  await journal.append(journal.event({...base,kind:'SUBMISSION',outcome:'UNKNOWN',responseHash:policyHash({operation})}));
  await snapshot(t);check(Date.now()<new Date(submission.authorization.expiresAt).getTime(),'CAPABILITY_EXPIRED_BEFORE_PROVIDER');
  let observed:ProviderObservation;let digest:string;
  try{const response=await io.submit(t,operation,payload,submission.authorization);observed=classifyProviderSubmission(operation,response,a);digest=policyHash(response);}
  catch{observed={outcome:'UNKNOWN',...(operation==='FB_REEL_FINISH'&&a.refs[0]?{reference:a.refs[0]}:{})};digest=policyHash({interrupted:true});}
  const event=journal.event({...base,kind:'RESPONSE',outcome:observed.outcome,...('reference'in observed&&observed.reference?{reference:observed.reference}:{}),responseHash:digest});
  // Durability BEFORE optional lookups/reporting. Failure leaves a spent capability.
  try{await journal.capture(event);}catch{return {outcome:'UNKNOWN',...('reference'in observed&&observed.reference?{reference:observed.reference}:{})} as ProviderObservation;}
  if(observed.outcome==='CONFIRMED'){
   if(t.platform==='INSTAGRAM')await (async()=>{const response=await io.lookup(t,'IG_PERMALINK',observed.reference);if(response.status>=200&&response.status<300&&response.body.id===observed.reference&&typeof response.body.permalink==='string'&&/^https:\/\/(?:www\.)?instagram\.com\//.test(response.body.permalink))await journal.capture(journal.event({...base,kind:'STATUS',outcome:'CONFIRMED',reference:observed.reference,permalink:response.body.permalink,responseHash:policyHash(response),operation:'IG_PERMALINK'}));})().catch(()=>{});
   await io.report?.(t,observed.reference).catch(()=>{});
  }
  return observed;
 },{persistObservation:async(submission,observed)=>{
  const rows=await journal.observations(submission.authorization.id);const response=[...rows].reverse().find(e=>e.kind==='RESPONSE');
  if(response)return journal.project(response);
  const event=journal.event({authorizationId:submission.authorization.id,jobId:submission.target.jobId,platform:submission.target.platform,operation:'pre-submission-failure',kind:'RESPONSE',outcome:'UNKNOWN',...('reference'in observed&&observed.reference?{reference:observed.reference}:{}),responseHash:policyHash({unknown:true})});return journal.capture(event);
 }});
 async function reconcile(authorizationId:string):Promise<ProviderObservation>{
  const c=await deps.database.transaction(async tx=>(await tx.query(`SELECT * FROM "PublishingSendCapability" WHERE id=$1`,[authorizationId])).rows[0]);check(c&&c.state==='CONSUMED','RECONCILIATION_REQUIRES_CONSUMED_ATTEMPT');
  const target:PublicationTarget={jobId:c.jobId,intentId:c.intentId,revision:c.revision,generation:c.generation,platform:c.platform,accountBindingId:c.accountBindingId,accountVersion:c.accountVersion,providerAccountId:c.providerAccountId,connectionId:c.connectionId,contentHash:c.contentHash};
  const records=await journal.observations(authorizationId);for(const e of records)await journal.append(e);const known=[...records].reverse().find(e=>e.reference);
  if(!known)return journal.capture(journal.event({authorizationId,jobId:c.jobId,platform:c.platform,operation:'reconciliation-no-reference',kind:'STATUS',outcome:'UNKNOWN',responseHash:policyHash({noReference:true})}));
  if(known.outcome==='CONFIRMED'||known.outcome==='REJECTED')return journal.project(known);
  const connected=await deps.database.transaction(async tx=>(await tx.query(`SELECT s.id FROM "SocialConnection" s JOIN "PublishingAccountVersion" v ON v."connectionId"=s.id WHERE v."bindingId"=$1 AND v.version=$2 AND s.id=$3 AND s.platform=$4 AND s."platformAccountId"=$5 AND s.status='CONNECTED'`,[target.accountBindingId,target.accountVersion,target.connectionId,target.platform,target.providerAccountId])).rows.length>0);
  if(!connected)return {outcome:'UNKNOWN',reference:known.reference};
  await io.refresh(target,{reconciliation:true});if(target.platform==='TIKTOK')await io.reserveRate(target,'status');
  const operation:LookupOperation=target.platform==='TIKTOK'?'TT_STATUS':target.platform==='FACEBOOK'?'FB_VIDEO_STATUS':target.platform==='INSTAGRAM'?'IG_PERMALINK':target.platform==='LINKEDIN'?'LI_POST_GET':'X_TWEET_GET';
  let response:MockProviderResponse;try{response=await io.lookup(target,operation,known.reference!);}catch{return {outcome:'UNKNOWN',reference:known.reference};}
  const verified=okay(response)&&(operation==='TT_STATUS'?response.body.status==='PUBLISH_COMPLETE':operation==='FB_VIDEO_STATUS'?response.body.video_status==='ready'&&response.body.publishing_status==='complete':response.body.verified===true);
  // Failed/pending operations retain references; they are never treated as no-send.
  const ids=target.platform==='TIKTOK'?(response.body.data?.publicaly_available_post_id??response.body.publicaly_available_post_id):undefined;
  const references=Array.isArray(ids)?ids.map(ref).filter((id):id is string=>id!==undefined):undefined;
  const event=journal.event({authorizationId,jobId:c.jobId,platform:c.platform,operation,kind:'STATUS',outcome:verified?'CONFIRMED':known.outcome==='ACCEPTED'?'ACCEPTED':'UNKNOWN',reference:known.reference,responseHash:policyHash(response),...(references?.length?{publicationReferences:references}:{})});
  return journal.capture(event);
 }
 return {prepare,publish:transport.publish,reconcile,
  // Trusted callback import: identity is checked against the consumed capability.
  observe:journal.capture,
 };
}
