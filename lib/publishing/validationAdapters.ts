/** Inactive Stage 4C.2. Same-tx policy reads; no global DB/auth/provider imports. */
import { randomUUID } from 'node:crypto';
import { effectiveTeamPermissions, type TeamPermission } from '../calendarTeamPolicy';
import { parseTikTokSettings, TIKTOK_CONSENT_VERSION } from '../tiktokSettings';
import { tikTokConsentHash } from '../tiktokConsent';
import { buildCaption, publishingStatus, validatePublishContent } from './state';
import { workspaceEligibility, accountAuthorizationHash, publishingContentHash } from './eligibilityPolicy';
import { createCanonicalIntentActions, createCanonicalPublishingStore } from './canonicalStore';
import type { CanonicalJob } from './canonicalContract';
import { IntentActionError, type IntentActionDependencies, type IntentRequest, type IntentAction } from './intentActions';
import type { OwnershipDatabase, OwnershipTransaction } from './ownership';
type Tx=OwnershipTransaction;type Row=Record<string,any>;
export class PublishingValidationError extends IntentActionError {constructor(code:string){super(code);this.name='PublishingValidationError';}}
function ensure(ok:unknown,code:string):asserts ok{if(!ok)throw new PublishingValidationError(code);}
function id(v:string){ensure(typeof v==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(v),'INVALID_PRINCIPAL_OR_ID');}
export interface ValidationDependencies {
 database:OwnershipDatabase;
 /** Must verify a real viewer token/credential for this calendar locally in tx.
  * Returned principal is server-derived, never a request boolean. No network IO. */
 verifyViewer(tx:Tx,input:{calendarId:string;credential:string}):Promise<{principalId:string;calendarId:string;expiresAt:Date}>;
 verifyRetryEvidence:IntentActionDependencies['verifyRetryEvidence'];
}
export function createPublishingValidationAdapters(deps:ValidationDependencies){
 async function fence(tx:Tx,exclusive=false){
  ensure((await tx.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation==='read committed','VALIDATION_REQUIRES_READ_COMMITTED');
  const f=(await tx.query(`SELECT version FROM "PublishingEligibilityFence" WHERE id=1 FOR ${exclusive?'UPDATE':'SHARE'}`)).rows[0];
  ensure(f,'ELIGIBILITY_FENCE_MISSING');return String(f.version);
 }
 async function clock(tx:Tx):Promise<Date>{return (await tx.query('SELECT clock_timestamp() AS now')).rows[0].now;}
 async function workspace(tx:Tx,calendarId:string){
  id(calendarId);const calendar=(await tx.query(`SELECT id,"managerId","createdAt" FROM "SocialCalendar" WHERE id=$1`,[calendarId])).rows[0];ensure(calendar,'WORKSPACE_MISSING');
  const owner=(await tx.query(`SELECT id,"isDeactivated","contentWorkspacePlan","contentWorkspaceBillingStatus","contentWorkspaceTrialEndsAt","isComped","compedUntil","workspaceCompedPlan","workspaceCompedUntil","billingComplimentaryGrants" FROM "Creator" WHERE id=$1`,[calendar.managerId])).rows[0];ensure(owner,'OWNER_MISSING');
  const hasRetirement=(await tx.query(`SELECT to_regclass('"PublishingResourceTombstone"') IS NOT NULL AS present`)).rows[0].present;
  const ordinal=(await tx.query(`SELECT count(*)::integer AS ordinal FROM "SocialCalendar" c WHERE "managerId"=$1 AND ("createdAt",id)<=(SELECT "createdAt",id FROM "SocialCalendar" WHERE id=$2) ${hasRetirement?`AND NOT EXISTS(SELECT 1 FROM "PublishingResourceTombstone" t WHERE t."resourceType"='WORKSPACE' AND t."resourceId"=c.id)`:''}`,[owner.id,calendar.id])).rows[0].ordinal;
  if((await tx.query(`SELECT to_regclass('"PublishingResourceTombstone"') IS NOT NULL AS present`)).rows[0].present&&
   (await tx.query(`SELECT 1 FROM "PublishingResourceTombstone" WHERE ("resourceType"='WORKSPACE' AND "resourceId"=$1) OR ("resourceType"='CREATOR' AND "resourceId"=$2)`,[calendar.id,owner.id])).rows.length)throw new PublishingValidationError('WORKSPACE_RETIRED');
  const billingRevocationPending=(await tx.query(`SELECT to_regclass('"PublishingBillingRevocationHold"') IS NOT NULL AS present`)).rows[0].present&&!!(await tx.query(`SELECT 1 FROM "PublishingBillingRevocationHold" h WHERE h."ownerId"=$1 AND NOT EXISTS(SELECT 1 FROM "PublishingBillingRevocationResolution" r WHERE r."ownerId"=h."ownerId" AND r."holdOperationId"=h."operationId") LIMIT 1`,[owner.id])).rows.length;
  return {calendar,owner,ordinal,billingRevocationPending};
 }
 async function snapshot(tx:Tx,postId:string){
  id(postId);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`policy-post:${postId}`]);
  // Fence-protected MVCC reads avoid application row locks: a BEFORE UPDATE
  // writer may already hold its row while waiting for the exclusive fence.
  const post=(await tx.query(`SELECT * FROM "CalendarPost" WHERE id=$1`,[postId])).rows[0];ensure(post,'POST_MISSING');
  if((await tx.query(`SELECT to_regclass('"PublishingResourceTombstone"') IS NOT NULL AS present`)).rows[0].present&&(await tx.query(`SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"='POST' AND "resourceId"=$1`,[postId])).rows.length)throw new PublishingValidationError('POST_RETIRED');
  const w=await workspace(tx,post.calendarId);
  const assets=(await tx.query(`SELECT * FROM "CalendarPostAsset" WHERE "postId"=$1 ORDER BY "displayOrder",id`,[postId])).rows;
  return {post,...w,assets};
 }
 function entitlement(s:Awaited<ReturnType<typeof workspace>>,now:Date){
  ensure(!s.billingRevocationPending,'BILLING_RECONCILIATION_REQUIRED');ensure(!s.owner.isDeactivated,'OWNER_DEACTIVATED');ensure(workspaceEligibility(s.owner as any,s.ordinal,now).allowed,'WORKSPACE_ENTITLEMENT_DENIED');
 }
 async function creator(tx:Tx,s:Awaited<ReturnType<typeof workspace>>,principalId:string,permission:TeamPermission){
  id(principalId);const actor=(await tx.query(`SELECT id,"isDeactivated" FROM "Creator" WHERE id=$1`,[principalId])).rows[0];ensure(actor,'CREATOR_MISSING');ensure(!actor.isDeactivated,'ACTOR_DEACTIVATED');
  if(principalId===s.owner.id)return actor;
  const m=(await tx.query(`SELECT * FROM "CalendarCollaborator" WHERE "calendarId"=$1 AND "creatorId"=$2`,[s.calendar.id,principalId])).rows[0];
  ensure(m&&effectiveTeamPermissions(m.role,m.permissions,m.customPermissions).includes(permission),'WORKSPACE_PERMISSION_DENIED');return actor;
 }
 function approved(s:Awaited<ReturnType<typeof snapshot>>){ensure(!s.post.isAiDraft,'AI_DRAFT_INELIGIBLE');ensure(s.post.approvalStatus==='APPROVED','POST_APPROVAL_REQUIRED');}
 async function account(tx:Tx,s:Awaited<ReturnType<typeof snapshot>>,d:{accountBindingId:string;accountVersion:number},now:Date){
  id(d.accountBindingId);ensure(Number.isSafeInteger(d.accountVersion)&&d.accountVersion>0,'INVALID_ACCOUNT_VERSION');
  const a=(await tx.query(`SELECT * FROM "PublishingAccountBinding" WHERE id=$1 FOR SHARE`,[d.accountBindingId])).rows[0];
  ensure(a&&a.calendarId===s.calendar.id&&a.platform===s.post.platform&&a.state==='CONNECTED'&&a.currentVersion===d.accountVersion,'ACCOUNT_BINDING_CHANGED');
  ensure(!(await tx.query(`SELECT 1 FROM "PublishingAccountInvalidation" WHERE "bindingId"=$1 AND version=$2`,[a.id,d.accountVersion])).rows.length,'ACCOUNT_VERSION_INVALIDATED');
  const version=(await tx.query(`SELECT * FROM "PublishingAccountVersion" WHERE "bindingId"=$1 AND version=$2`,[a.id,d.accountVersion])).rows[0];ensure(version,'ACCOUNT_VERSION_MISSING');
  const c=(await tx.query(`SELECT id,"calendarId",platform,"platformAccountId",status,"tokenScopes","accessTokenExpiresAt",("accessToken" IS NOT NULL AND length("accessToken")>0) AS "hasAccessToken" FROM "SocialConnection" WHERE id=$1`,[version.connectionId])).rows[0];
  ensure(c&&c.calendarId===s.calendar.id&&c.platform===s.post.platform&&c.platformAccountId===version.providerAccountId&&c.status==='CONNECTED','SOCIAL_CONNECTION_CHANGED');
  ensure(c.hasAccessToken&&(!c.accessTokenExpiresAt||c.accessTokenExpiresAt>now),'SOCIAL_TOKEN_EXPIRED');
  ensure(accountAuthorizationHash(c as any)===version.authorizationHash,'ACCOUNT_AUTHORIZATION_CHANGED');
  const scopes=new Set((c.tokenScopes??'').split(/[\s,]+/));
  const required:Record<string,string[]>={INSTAGRAM:['instagram_content_publish'],TIKTOK:['video.publish'],FACEBOOK:['pages_manage_posts','pages_read_engagement'],X:['tweet.write',...(s.assets.length?['media.write']:[])],LINKEDIN:[c.platformAccountId.startsWith('urn:li:organization:')?'w_organization_social':'w_member_social']};
  ensure(required[s.post.platform]?.every(scope=>scopes.has(scope)),'SOCIAL_PERMISSION_MISSING');
  validatePublishContent(s.post.platform,s.assets as {mediaType:string}[],buildCaption(s.post as any),s.post.postType);
  if(s.post.platform==='TIKTOK'){
   await creator(tx,s,s.post.tikTokConsentBy,'publishing.manage');
   const settings=parseTikTokSettings(s.post.tikTokSettings);
   ensure(s.post.tikTokConsentAccountId===c.platformAccountId&&s.post.tikTokConsentAt&&s.post.tikTokConsentBy&&s.post.tikTokConsentVersion===TIKTOK_CONSENT_VERSION&&s.post.tikTokConsentHash===tikTokConsentHash({...s.post,assets:s.assets} as any,settings,c.platformAccountId),'TIKTOK_CONSENT_REQUIRED');
  }
  return {version,connection:c};
 }
 function expiry(s:Awaited<ReturnType<typeof snapshot>>,connection:Row,now:Date){
  // Earliest policy time boundary is conservative even if another grant survives.
  const dates=[s.owner.contentWorkspaceTrialEndsAt,s.owner.compedUntil,s.owner.workspaceCompedUntil,connection.accessTokenExpiresAt,
   ...(Array.isArray(s.owner.billingComplimentaryGrants)?s.owner.billingComplimentaryGrants.map((g:Row)=>new Date(g.endsAt)):[])].filter((d):d is Date=>d instanceof Date&&Number.isFinite(d.getTime())&&d>now);
  return new Date(Math.min(now.getTime()+30_000,...dates.map(d=>d.getTime())));
 }
 async function validateAction(tx:Tx,input:IntentRequest,action:IntentAction){
  await fence(tx,action==='edit');const s=await snapshot(tx,input.postId),now=await clock(tx);
  ensure(s.post.platform===input.platform,'POST_PLATFORM_CHANGED');entitlement(s,now);await creator(tx,s,input.actor,action==='edit'?'calendar.edit':'publishing.manage');
  if(['schedule','reschedule','retry'].includes(action)){approved(s);ensure(input.destination,'EXPLICIT_DESTINATION_REQUIRED');await account(tx,s,input.destination,now);}
  if(action==='edit')ensure(s.post.approvalStatus!=='APPROVED'&&!['PUBLISHING','PUBLISHED'].includes(publishingStatus(s.post as any)),'APPROVED_CONTENT_LOCKED');
 }
 async function captureRevision(tx:Tx,input:IntentRequest){
  await fence(tx);const s=await snapshot(tx,input.postId),now=await clock(tx);entitlement(s,now);approved(s);await creator(tx,s,input.actor,'publishing.manage');ensure(input.destination,'EXPLICIT_DESTINATION_REQUIRED');await account(tx,s,input.destination,now);
  // capture runs before CanonicalRevision INSERT; its FK is deferred to COMMIT.
  const revision=(await tx.query(`SELECT "currentRevision" FROM "PublishingIntent" WHERE id=$1`,[input.intentId])).rows[0]?.currentRevision;ensure(revision,'INTENT_MISSING');
  await tx.query(`INSERT INTO "PublishingRevisionPolicy"("intentId",revision,"calendarId","ownerId","principalId","principalKind") VALUES($1,$2,$3,$4,$5,'CREATOR')`,[input.intentId,revision,s.calendar.id,s.owner.id,input.actor]);
  return {...input.destination,calendarId:s.calendar.id,contentHash:publishingContentHash(s.post,s.assets)};
 }
 async function validateExecution(tx:Tx,job:CanonicalJob){
  const fenceVersion=await fence(tx);
  const canonical=(await tx.query(`SELECT j."postId",j.platform,j."intentId",j."intentRevision" AS revision,b."accountBindingId",b."accountVersion",b."contentHash",a."calendarId",v."providerAccountId",v."connectionId",COALESCE(g.generation,1) AS generation
   FROM "PublishingJob" j JOIN "PublishingCanonicalRevision" b ON b."jobId"=j.id JOIN "PublishingAccountBinding" a ON a.id=b."accountBindingId"
   JOIN "PublishingAccountVersion" v ON v."bindingId"=a.id AND v.version=b."accountVersion" LEFT JOIN "PublishingRetryGeneration" g ON g."jobId"=j.id WHERE j.id=$1`,[job.id])).rows[0];
  ensure(canonical&&['postId','platform','intentId','revision','generation','accountBindingId','accountVersion','contentHash','calendarId','providerAccountId','connectionId'].every(k=>canonical[k]===(job as any)[k]),'CANONICAL_JOB_IDENTITY_CHANGED');
  if((await tx.query(`SELECT to_regclass('"PublishingEligibilityHold"') IS NOT NULL AS present`)).rows[0].present&&
   (await tx.query(`SELECT 1 FROM "PublishingEligibilityHold" WHERE "intentId"=$1 AND revision=$2`,[job.intentId,job.revision])).rows.length)throw new PublishingValidationError('EXPLICIT_REAUTHORIZATION_REQUIRED');
  const s=await snapshot(tx,job.postId),now=await clock(tx);
  const p=(await tx.query(`SELECT * FROM "PublishingRevisionPolicy" WHERE "intentId"=$1 AND revision=$2`,[job.intentId,job.revision])).rows[0];
  ensure(p&&p.principalKind==='CREATOR'&&p.calendarId===s.calendar.id&&p.ownerId===s.owner.id,'REVISION_AUTHORITY_CHANGED');
  approved(s);
  ensure(!(await tx.query(`SELECT 1 FROM "PublishingPostEligibilityInvalidation" WHERE "intentId"=$1 AND revision=$2`,[job.intentId,job.revision])).rows.length,'POST_APPROVAL_REVISION_INVALIDATED');
  ensure(job.calendarId===s.calendar.id&&job.platform===s.post.platform,'POST_IDENTITY_CHANGED');entitlement(s,now);approved(s);await creator(tx,s,p.principalId,'publishing.manage');
  ensure(job.contentHash===publishingContentHash(s.post,s.assets),'APPROVED_CONTENT_CHANGED');
  const {connection,version}=await account(tx,s,job,now);ensure(job.providerAccountId===version.providerAccountId&&job.connectionId===connection.id,'CANONICAL_DESTINATION_CHANGED');
  return {principalId:p.principalId,fenceVersion,validUntil:expiry(s,connection,now),maySend:false as const};
 }
 async function validateBeforeExternal(tx:Tx,input:{job:CanonicalJob;owner:'NETLIFY'|'VPS';epoch:bigint}){
  const o=(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0];ensure(o?.enabled&&o.state===input.owner&&BigInt(o.epoch)===input.epoch,'OWNERSHIP_FENCED');
  const v=await validateExecution(tx,input.job);
  const i=(await tx.query(`SELECT * FROM "PublishingIntent" WHERE id=$1 FOR UPDATE`,[input.job.intentId])).rows[0];
  ensure(i?.state==='ACTIVE'&&i.currentRevision===input.job.revision,'INTENT_FENCED');
  const j=(await tx.query(`SELECT *,"workerUntil">clock_timestamp() AS live FROM "PublishingJob" WHERE id=$1 FOR UPDATE`,[input.job.id])).rows[0];
  ensure(j?.phase==='PREPARED'&&j.live&&j.workerToken===input.job.workerToken&&BigInt(j.ownershipEpoch)===input.epoch,'PREPARED_JOB_FENCED');
  await tx.query(`INSERT INTO "PublishingEligibilityWitness"(id,"jobId","principalId","fenceVersion","validUntil") VALUES($1,$2,$3,$4,$5)`,[randomUUID(),j.id,v.principalId,v.fenceVersion,v.validUntil]);return v;
 }
 async function validateViewerApproval(tx:Tx,input:{postId:string;calendarId:string;credential:string}){
  await fence(tx,true);const s=await snapshot(tx,input.postId),now=await clock(tx);ensure(s.calendar.id===input.calendarId,'VIEWER_CALENDAR_MISMATCH');entitlement(s,now);
  const viewer=await deps.verifyViewer(tx,{calendarId:input.calendarId,credential:input.credential});
  ensure(viewer.calendarId===s.calendar.id&&viewer.expiresAt>await clock(tx)&&viewer.principalId,'VIEWER_AUTHORITY_DENIED');ensure(!s.post.isAiDraft,'AI_DRAFT_INELIGIBLE');
  ensure(!['PUBLISHING','PUBLISHED'].includes(publishingStatus(s.post as any)),'POST_ALREADY_PUBLISHING');
  const busy=(await tx.query(`SELECT 1 FROM "PublishingExternalAttempt" a JOIN "PublishingIntent" i ON i.id=a."intentId" WHERE i."postId"=$1 AND a.outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED') UNION ALL SELECT 1 FROM "PublishingRetryGeneration" a JOIN "PublishingIntent" i ON i.id=a."intentId" WHERE i."postId"=$1 AND a.outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED')`,[input.postId])).rows;
  ensure(!busy.length,'POST_EXTERNAL_CONFLICT');ensure(s.assets.length||s.post.caption?.trim()&&!['INSTAGRAM','TIKTOK'].includes(s.post.platform),'NOTHING_TO_APPROVE');
  return {authority:'VIEWER_APPROVAL' as const,principalId:viewer.principalId,calendarId:s.calendar.id,postId:s.post.id,maySend:false as const};
 }
 return {
  validateAction,captureRevision,validateExecution,validateBeforeExternal,validateViewerApproval,
  async validateViewerWorkspace(tx:Tx,input:{calendarId:string;credential:string}){
   await fence(tx,true);const w=await workspace(tx,input.calendarId);entitlement(w,await clock(tx));
   const viewer=await deps.verifyViewer(tx,input);ensure(viewer.calendarId===w.calendar.id&&viewer.expiresAt>await clock(tx)&&viewer.principalId,'VIEWER_AUTHORITY_DENIED');
   return {principalId:viewer.principalId,calendarId:w.calendar.id,maySend:false as const};
  },
  async validateWorkspacePermission(tx:Tx,input:{calendarId:string;actor:string;permission:TeamPermission|'VIEW_ONLY'|'ADD_CONTENT'|'EDIT_CALENDAR'}){
   await fence(tx);const w=await workspace(tx,input.calendarId);
   const p:TeamPermission=input.permission==='VIEW_ONLY'?'calendar.view':input.permission==='ADD_CONTENT'?'creatives.upload':input.permission==='EDIT_CALENDAR'?'calendar.edit':input.permission;
   await creator(tx,w,input.actor,p);
   if(!p.endsWith('.view')&&p!=='people.manage')entitlement(w,await clock(tx));
   return {permission:p,calendarId:w.calendar.id,actor:input.actor,maySend:false as const};
  },
  intentActions:(applyEdit:IntentActionDependencies['applyEdit'])=>createCanonicalIntentActions({database:deps.database,lockAndValidatePost:validateAction,captureRevision,applyEdit,
   validateDueTime:async(_tx,i)=>ensure(i.dueAt instanceof Date&&Number.isFinite(i.dueAt.getTime()),'INVALID_DUE_TIME'),verifyRetryEvidence:deps.verifyRetryEvidence}),
  contentIntentActions:(permission:'calendar.edit'|'creatives.upload'|'delivery.manage')=>createCanonicalIntentActions({database:deps.database,captureRevision,applyEdit:async()=>{},verifyRetryEvidence:deps.verifyRetryEvidence,
   validateDueTime:async()=>{throw new PublishingValidationError('CONTENT_INVALIDATION_CANNOT_SCHEDULE');},
   lockAndValidatePost:async(tx,input,action)=>{
    ensure(action==='edit','CONTENT_INVALIDATION_ONLY');await fence(tx,true);const s=await snapshot(tx,input.postId);ensure(s.post.platform===input.platform,'POST_PLATFORM_CHANGED');entitlement(s,await clock(tx));await creator(tx,s,input.actor,permission);
    ensure(s.post.approvalStatus!=='APPROVED'&&!['PUBLISHING','PUBLISHED'].includes(publishingStatus(s.post as any)),'APPROVED_CONTENT_LOCKED');
   },
  }),
  canonicalStore:(options?:{preparedLeaseMs:number})=>createCanonicalPublishingStore({database:deps.database,preparedLeaseMs:options?.preparedLeaseMs,lockAndValidate:(tx,job)=>validateExecution(tx,job).then(()=>{})}),
  // Policy mutators must take this before any application/canonical row lock.
  lockForPolicyChange:(tx:Tx)=>fence(tx,true),
 };
}
