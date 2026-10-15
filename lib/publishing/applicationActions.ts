/** Transactional application policies for the inactive canonical route composition. */
import { randomUUID,randomInt,createHash } from 'node:crypto';
import { createPublishingValidationAdapters,type ValidationDependencies } from './validationAdapters';
import { createCanonicalPublishingStore } from './canonicalStore';
import {legacyProjection} from './canonicalContract';
import { accountAuthorizationHash,policyHash } from './eligibilityPolicy';
import { parseTikTokSettings,validateTikTokSettings,TIKTOK_CONSENT_VERSION,type TikTokCreator } from '../tiktokSettings';
import { tikTokConsentHash } from '../tiktokConsent';
import { validateTeamAssignment,canManageTeamRole,effectiveTeamPermissions,normalizeTeamRole,needsAdvancedTeamPermissions } from '../calendarTeamPolicy';
import {getContentWorkspacePlan,canAccessContentWorkspace,canUseContentWorkspaceFeature} from '../contentWorkspacePolicy';
import type {ContentWorkspaceAccount} from '../contentWorkspaceUsage';
import type { OwnershipDatabase,OwnershipTransaction } from './ownership';
import {createPublishingIntentActions,type IntentRequest} from './intentActions';
import {calendarPostData,POST_TEXT_FIELDS} from '../calendarPosts';
import type {SocialPlatform} from '@prisma/client';
import {validateConfirm} from '../calendarImport/validation';
import {approvalFor,duplicateIndex,rowIssues,parsePlatforms,type ExistingPost} from '../calendarImport/mapping';
export function createCanonicalApplicationActions(deps:{database:OwnershipDatabase;policy:Omit<ValidationDependencies,'database'>;
 creatorInfo(calendarId:string,accountId:string):Promise<TikTokCreator>;
 verifyAccount(tx:OwnershipTransaction,input:unknown):Promise<{connectionId:string;providerAccountId:string;platform:string;tokenScopes:string;accessToken:string;expiresAt:Date|null;refreshToken?:string;refreshTokenExpiresAt?:Date;accountName?:string;username?:string;instagramPageId?:string;linkedinMemberId?:string}>;
 authorizeBilling(tx:OwnershipTransaction,actor:string,ownerId:string):Promise<void>;
 validateUsage(tx:OwnershipTransaction,input:{actor:string;calendarId:string;kind:'AI_DRAFT'|'AI_REGENERATION'|'UPLOAD'|'MEMBERSHIP';deltaBytes?:string}):Promise<void>;
 retention(tx:OwnershipTransaction,actor:string,resource:string):Promise<Date>;
 authorizeCreatorDeletion?:(tx:OwnershipTransaction,actor:string,subject:string)=>Promise<void>;
 generateContent?:(request:Record<string,unknown>)=>Promise<Record<string,any>[]>;
 regenerateContent?:(request:Record<string,unknown>)=>Promise<Record<string,any>>;
 hashViewerPassword?:(password:string)=>Promise<string>;
}){
 function services(tx:OwnershipTransaction){const database={transaction:<T>(fn:(t:OwnershipTransaction)=>Promise<T>)=>fn(tx)};return {database,v:createPublishingValidationAdapters({...deps.policy,database})};}
 async function replay<T>(operationId:string,actor:string,request:unknown,fn:(tx:OwnershipTransaction)=>Promise<T>){
  if(!/^[a-zA-Z0-9_-]{1,120}$/.test(operationId)||!/^[a-zA-Z0-9_-]{1,120}$/.test(actor))throw Error('INVALID_OPERATION_IDENTITY');
  const hash=policyHash(request);return deps.database.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`application:${operationId}`]);
   const old=(await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[operationId])).rows[0];
   // Current permission must still be checked by the public method before replay.
   if(old){if(old.actor!==actor||old.requestHash!==hash)throw Error('OPERATION_CONFLICT');return old.result as T;}
   const result=await fn(tx);await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[operationId,actor,hash,result]);return result;
  });
 }
 async function permission(actor:string,calendarId:string,p:any){return deps.database.transaction(tx=>services(tx).v.validateWorkspacePermission(tx,{actor,calendarId,permission:p}));}
 async function busy(tx:OwnershipTransaction,postId:string){return (await tx.query(`SELECT 1 FROM "PublishingJob" WHERE "postId"=$1 AND phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN','CONFIRMED') LIMIT 1`,[postId])).rows.length>0;}
 async function post(tx:OwnershipTransaction,postId:string,calendarId:string){const p=(await tx.query(`SELECT * FROM "CalendarPost" WHERE id=$1 AND "calendarId"=$2`,[postId,calendarId])).rows[0];if(!p)throw Error('POST_MISSING');if((await tx.query(`SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"='POST' AND "resourceId"=$1`,[postId])).rows.length)throw Error('POST_RETIRED');return p;}
 async function invalidate(tx:OwnershipTransaction,p:Record<string,any>,actor:string,operationId:string,permission:'calendar.edit'|'creatives.upload'|'delivery.manage'='calendar.edit'){
  if(await busy(tx,p.id))throw Error('PENDING_RECONCILIATION');
  const i=(await tx.query(`SELECT * FROM "PublishingIntent" WHERE "postId"=$1 ORDER BY id`,[p.id])).rows;
  const {v}=services(tx);for(const [n,intent] of i.entries()){
   if(intent.state==='ACTIVE'){const result=await v.contentIntentActions(permission).edit({operationId:operationId+'-'+n,actor,intentId:intent.id,postId:p.id,platform:p.platform,expectedRevision:intent.currentRevision});if(result.outcome!=='APPLIED')throw Error(result.outcome);}
  }
 }
 async function publishing(input:IntentRequest,action:'schedule'|'cancel'|'reschedule'|'retry'){
  await permission(input.actor,input.postId?await deps.database.transaction(async tx=>(await tx.query(`SELECT "calendarId" FROM "CalendarPost" WHERE id=$1`,[input.postId])).rows[0]?.calendarId):'','publishing.manage');
  return deps.database.transaction(async tx=>{const {v}=services(tx);await v.lockForPolicyChange(tx);
   if(input.platform==='TIKTOK'&&['schedule','reschedule'].includes(action))throw Error('EXPLICIT_TIKTOK_CONSENT_FLOW_REQUIRED');
   const result=await v.intentActions(async()=>{})[action](input);
   if(result.outcome==='APPLIED'){const field=input.platform==='INSTAGRAM'?'instagramPublishStatus':input.platform==='TIKTOK'?'tikTokPublishStatus':'publishStatus';await tx.query(`UPDATE "CalendarPost" SET "${field}"=$2 WHERE id=$1`,[input.postId,legacyProjection((await tx.query(`SELECT j.phase FROM "PublishingJob" j JOIN "PublishingIntent" i ON i.id=j."intentId" WHERE i.id=$1 AND j."intentRevision"=i."currentRevision"`,[input.intentId])).rows[0]?.phase??'READY')]);if(input.platform==='TIKTOK'&&action==='cancel')await tx.query(`UPDATE "CalendarPost" SET "tikTokConsentAt"=NULL,"tikTokConsentBy"=NULL,"tikTokConsentHash"=NULL,"tikTokConsentAccountId"=NULL,"tikTokConsentVersion"=NULL WHERE id=$1`,[input.postId]);}return result;
  });
 }
 async function createPost(input:{operationId:string;actor:string;calendarId:string;id:string;platform:string;caption:string;aiDraft?:boolean;postDate?:Date;fields?:Record<string,unknown>;usageAlreadyReserved?:true}){
  await permission(input.actor,input.calendarId,input.aiDraft?'ai.generate':'calendar.edit');return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:input.aiDraft?'ai.generate':'calendar.edit'});
   if(input.aiDraft&&!input.usageAlreadyReserved)await deps.validateUsage(tx,{actor:input.actor,calendarId:input.calendarId,kind:'AI_DRAFT'});
   if(input.postDate&&!(input.postDate instanceof Date&&Number.isFinite(input.postDate.getTime())))throw Error('INVALID_POST_DATE');
   if(!['INSTAGRAM','TIKTOK','FACEBOOK','LINKEDIN','X','YOUTUBE'].includes(input.platform))throw Error('INVALID_PLATFORM');
   await tx.query(`INSERT INTO "CalendarPost"(id,"calendarId",platform,caption,"approvalStatus","isAiDraft","publishStatus","instagramPublishStatus","tikTokPublishStatus","postDate","updatedAt") VALUES($1,$2,$3,$4,'PENDING',$5,'NOT_SCHEDULED','NOT_SCHEDULED','NOT_SCHEDULED',$6,clock_timestamp())`,[input.id,input.calendarId,input.platform,input.caption,input.aiDraft===true,input.postDate??new Date()]);
   if(input.fields){const data=calendarPostData(input.calendarId,{...input.fields,postDate:(input.postDate??new Date()).toISOString()},input.platform as SocialPlatform),values:unknown[]=[input.id],assignments:string[]=[];
    for(const field of [...POST_TEXT_FIELDS,'tikTokPrivacyLevel'] as const){values.push(data[field]??null);assignments.push(`"${field}"=$${values.length}`);}
    await tx.query(`UPDATE "CalendarPost" SET ${assignments.join(',')},"updatedAt"=clock_timestamp() WHERE id=$1`,values);
    const custom=(data.customFields as {create:{label:string;value:string}[]}).create;for(const field of custom)await tx.query(`INSERT INTO "CalendarPostCustomField"(id,"postId",label,value) VALUES($1,$2,$3,$4)`,[randomUUID(),input.id,field.label,field.value]);
   }return {ok:true,postId:input.id};
  });
 }
 async function changeContent(input:{operationId:string;actor:string;calendarId:string;postId:string;caption?:string;promoteAi?:boolean;patch?:Record<string,unknown>}){
  await permission(input.actor,input.calendarId,'calendar.edit');return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'calendar.edit'});const p=await post(tx,input.postId,input.calendarId);
   if(p.approvalStatus==='APPROVED')throw Error('APPROVED_CONTENT_LOCKED');if(p.publishWorkerStartedAt||p.tikTokInitStartedAt||p.tikTokPublishId||p.instagramMediaId||p.platformPostId)throw Error('PENDING_RECONCILIATION');await invalidate(tx,p,input.actor,input.operationId);
   const patch=input.patch??{};const allowed=['postDate','platform','postType','category','hook','script','contentIdea','cta','hashtags','taggedAccounts','linkUrl','tikTokPrivacyLevel'];
   const assignments:string[]=[],values:unknown[]=[p.id];for(const [key,value] of Object.entries(patch)){if(!allowed.includes(key))throw Error('UNSUPPORTED_POST_FIELD');let normalized:unknown=value;
    if(key==='postDate'){normalized=new Date(String(value));if(!Number.isFinite((normalized as Date).getTime()))throw Error('INVALID_POST_DATE');}
    else if(key==='platform'){if(!['INSTAGRAM','TIKTOK','FACEBOOK','LINKEDIN','X','YOUTUBE'].includes(String(value)))throw Error('INVALID_PLATFORM');}
    else if(key==='tikTokPrivacyLevel'){if(value!==null&&!['PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY'].includes(String(value)))throw Error('INVALID_TIKTOK_PRIVACY');}
    else if(value!==null&&typeof value!=='string')throw Error('INVALID_POST_FIELD_VALUE');
    else normalized=typeof value==='string'?value.trim()||null:null;
    values.push(normalized);assignments.push(`"${key}"=$${values.length}`);
   }if(assignments.length)await tx.query(`UPDATE "CalendarPost" SET ${assignments.join(',')},"updatedAt"=clock_timestamp() WHERE id=$1`,values);
   if(input.caption!==undefined&&input.caption!==null&&typeof input.caption!=='string')throw Error('INVALID_POST_FIELD_VALUE');
   await tx.query(`UPDATE "CalendarPost" SET caption=CASE WHEN $4 THEN $2 ELSE caption END,"isAiDraft"=CASE WHEN $3 THEN false ELSE "isAiDraft" END,"approvalStatus"='PENDING',"tikTokConsentAt"=NULL,"tikTokConsentHash"=NULL,"tikTokConsentBy"=NULL,"updatedAt"=clock_timestamp() WHERE id=$1`,[p.id,input.caption?.trim()||null,input.promoteAi===true,input.caption!==undefined]);return {ok:true};
  });
 }
 async function review(input:{operationId:string;calendarId:string;postId:string;credential:string;approved:boolean;note?:string}){
  // Viewer authority cannot be substituted for a creator scheduling principal.
  return deps.database.transaction(async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);const authority=await v.validateViewerApproval(tx,input);
   const old=(await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[input.operationId])).rows[0],hash=policyHash({...input,credential:undefined});if(old){if(old.actor!==authority.principalId||old.requestHash!==hash)throw Error('OPERATION_CONFLICT');return old.result;}
   const p=await post(tx,input.postId,input.calendarId);if(await busy(tx,p.id))throw Error('PENDING_RECONCILIATION');
   await tx.query(`UPDATE "CalendarPost" SET "approvalStatus"=$2,"tikTokConsentAt"=CASE WHEN $3 THEN "tikTokConsentAt" ELSE NULL END,"tikTokConsentHash"=CASE WHEN $3 THEN "tikTokConsentHash" ELSE NULL END WHERE id=$1`,[p.id,input.approved?'APPROVED':'NEEDS_REVISION',input.approved]);
   if(!input.approved)await tx.query(`UPDATE "CalendarPost" SET "publishStatus"=CASE WHEN "publishStatus"='SCHEDULED' THEN 'NOT_SCHEDULED' ELSE "publishStatus" END,"instagramPublishStatus"=CASE WHEN "instagramPublishStatus"='SCHEDULED' THEN 'NOT_SCHEDULED' ELSE "instagramPublishStatus" END,"tikTokPublishStatus"=CASE WHEN "tikTokPublishStatus"='SCHEDULED' THEN 'NOT_SCHEDULED' ELSE "tikTokPublishStatus" END WHERE id=$1`,[p.id]);
   if((await tx.query(`SELECT to_jsonb(p) ? 'reviewedAt' AS present FROM "CalendarPost" p WHERE id=$1`,[p.id])).rows[0].present)await tx.query(`UPDATE "CalendarPost" SET "approvalNote"=$2,"reviewedAt"=clock_timestamp() WHERE id=$1`,[p.id,input.approved?null:input.note?.trim()||null]);
   // DB eligibility invalidation is permanent for withdrawn revisions. No implicit viewer scheduling/delegation.
   const result={ok:true,approvalStatus:input.approved?'APPROVED':'NEEDS_REVISION',maySend:false};await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[input.operationId,authority.principalId,hash,result]);return result;
  });
 }
 async function tikTok(input:IntentRequest&{calendarId:string;settings:unknown;accountId:string;consent:boolean;saveOnly?:boolean;reschedule?:boolean;retry?:boolean}){
  await permission(input.actor,input.calendarId,'publishing.manage');const settings=parseTikTokSettings(input.settings),creator=await deps.creatorInfo(input.calendarId,input.accountId);
  const action=input.retry?'retry':input.reschedule?'reschedule':'schedule';
  return deps.database.transaction(async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'publishing.manage'});const old=(await tx.query(`SELECT 1 FROM "PublishingAction" WHERE "operationId"=$1`,[input.operationId])).rows[0];if(old&&!input.saveOnly)return v.intentActions(async()=>{})[action](input);const p=await post(tx,input.postId,input.calendarId);if(p.platform!=='TIKTOK'||p.tikTokPublishId||p.tikTokInitStartedAt||['PUBLISHING','PUBLISHED'].includes(p.tikTokPublishStatus)||await busy(tx,p.id))throw Error('TIKTOK_ATTEMPT_CONFLICT');
   if(!input.retry&&!input.reschedule&&(await tx.query(`SELECT 1 FROM "PublishingIntent" WHERE "postId"=$1 AND state='ACTIVE'`,[p.id])).rows.length)throw Error('CANCEL_BEFORE_TIKTOK_SETTINGS_CHANGE');
   const a=(await tx.query(`SELECT v."providerAccountId" FROM "PublishingAccountBinding" b JOIN "PublishingAccountVersion" v ON v."bindingId"=b.id AND v.version=b."currentVersion" WHERE b.id=$1 AND b."currentVersion"=$2 AND b.state='CONNECTED' FOR SHARE OF b`,[input.destination?.accountBindingId,input.destination?.accountVersion])).rows[0];if(!a||a.providerAccountId!==input.accountId)throw Error('TIKTOK_ACCOUNT_CHANGED');
   const assets=(await tx.query(`SELECT * FROM "CalendarPostAsset" WHERE "postId"=$1 ORDER BY "displayOrder",id`,[p.id])).rows;validateTikTokSettings(settings,creator,assets.some(a=>a.mediaType==='VIDEO'));
   if(!input.saveOnly&&input.consent!==true)throw Error('EXPLICIT_TIKTOK_CONSENT_REQUIRED');
   await tx.query(`UPDATE "CalendarPost" SET "tikTokSettings"=$2,"tikTokConsentAt"=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,"tikTokConsentBy"=$4,"tikTokConsentAccountId"=$5,"tikTokConsentVersion"=$6,"tikTokConsentHash"=$7 WHERE id=$1`,[p.id,settings,!input.saveOnly,input.saveOnly?null:input.actor,input.saveOnly?null:input.accountId,input.saveOnly?null:TIKTOK_CONSENT_VERSION,input.saveOnly?null:tikTokConsentHash({...p,assets} as any,settings,input.accountId)]);
   if(input.saveOnly)return {ok:true,maySend:false};const result=await v.intentActions(async()=>{})[action](input);if(result.outcome==='APPLIED')await tx.query(`UPDATE "CalendarPost" SET "tikTokPublishStatus"='SCHEDULED' WHERE id=$1`,[p.id]);return result;
  });
 }
 async function media(input:{operationId:string;actor:string;calendarId:string;postId:string;assetId:string;remove?:boolean;upload?:unknown},verifyUpload:(upload:unknown)=>Promise<{fileKey:string;objectVersion:string;contentSha256:string;mediaType:'PHOTO'|'VIDEO';sizeBytes:string;verifiedFor:{calendarId:string;postId:string};reservationId?:string;sourceAssetId?:string;sourcePostId?:string}>){
  const access=input.remove?'calendar.edit':'creatives.upload';await permission(input.actor,input.calendarId,access);const verified=input.remove?null:await verifyUpload({upload:input.upload,calendarId:input.calendarId,postId:input.postId,actor:input.actor});
  return replay(input.operationId,input.actor,{...input,upload:verified},async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:access});const p=await post(tx,input.postId,input.calendarId);if(p.approvalStatus==='APPROVED'||p.publishWorkerStartedAt||p.tikTokInitStartedAt||p.tikTokPublishId||p.instagramMediaId||p.platformPostId||await busy(tx,p.id))throw Error('MEDIA_LOCKED');
   // Cancellation requires publishing.manage. Contributors cannot invalidate a publisher's live intent silently.
   if((await tx.query(`SELECT 1 FROM "PublishingIntent" WHERE "postId"=$1 AND state='ACTIVE'`,[p.id])).rows.length)await invalidate(tx,p,input.actor,input.operationId,access);
   if(!input.remove){if(!verified||!/^\d+$/.test(verified.sizeBytes)||BigInt(verified.sizeBytes)>BigInt(Number.MAX_SAFE_INTEGER))throw Error('VERIFIED_UPLOAD_SIZE_REQUIRED');
    if(verified.reservationId){
     const owner=(await tx.query(`SELECT "managerId" FROM "SocialCalendar" WHERE id=$1`,[input.calendarId])).rows[0];
     const reservation=(await tx.query(`SELECT *,"expiresAt">clock_timestamp() AS live FROM "ContentWorkspaceStorageReservation" WHERE id=$1 AND "calendarId"=$2 AND "creatorId"=$3 AND "fileKey"=$4 FOR UPDATE`,[verified.reservationId,input.calendarId,owner.managerId,verified.fileKey])).rows[0];
     if(!reservation||String(reservation.bytes)!==verified.sizeBytes)throw Error('UPLOAD_RESERVATION_INVALID');
     if(reservation.status==='COMPLETED'){const existing=(await tx.query(`SELECT id FROM "CalendarPostAsset" WHERE "postId"=$1 AND "fileKey"=$2`,[p.id,verified.fileKey])).rows[0];if(!existing)throw Error('COMPLETED_UPLOAD_ASSET_MISSING');return {ok:true,assetId:existing.id};}
     if(reservation.status!=='PENDING'||!reservation.live)throw Error('UPLOAD_RESERVATION_INVALID');
     const usage=(await tx.query(`UPDATE "ContentWorkspaceUsage" SET "storageReservedBytes"="storageReservedBytes"-$2::bigint,"storageBytes"="storageBytes"+$2::bigint,"updatedAt"=clock_timestamp() WHERE "creatorId"=$1 AND "storageReservedBytes">=$2::bigint RETURNING "creatorId"`,[owner.managerId,verified.sizeBytes])).rows;if(!usage.length)throw Error('CONTENT_WORKSPACE_STORAGE_USAGE_UPDATE_FAILED');
     await tx.query(`UPDATE "ContentWorkspaceStorageReservation" SET status='COMPLETED',"completedAt"=clock_timestamp() WHERE id=$1`,[reservation.id]);
    }else if(verified.sourceAssetId){const source=(await tx.query(`SELECT a.id FROM "CalendarPostAsset" a JOIN "CalendarPost" s ON s.id=a."postId" WHERE a.id=$1 AND a."postId"=$2 AND s."calendarId"=$3 AND a."fileKey"=$4`,[verified.sourceAssetId,verified.sourcePostId,input.calendarId,verified.fileKey])).rows[0];if(!source)throw Error('SOURCE_ASSET_WORKSPACE_MISMATCH');}
    else await deps.validateUsage(tx,{actor:input.actor,calendarId:input.calendarId,kind:'UPLOAD',deltaBytes:verified.sizeBytes});
   }
   if(input.remove){if(!(await tx.query(`DELETE FROM "CalendarPostAsset" WHERE id=$1 AND "postId"=$2 RETURNING id`,[input.assetId,p.id])).rows.length)throw Error('Asset not found');}else{
    if(verified?.verifiedFor?.calendarId!==input.calendarId||verified?.verifiedFor?.postId!==input.postId)throw Error('UPLOAD_RESOURCE_BINDING_REQUIRED');if(!verified?.objectVersion||!/^[a-f0-9]{64}$/.test(verified.contentSha256))throw Error('VERIFIED_UPLOAD_REQUIRED');
    const updated=(await tx.query(`INSERT INTO "CalendarPostAsset"(id,"postId","fileKey","mediaType","displayOrder","objectVersion","contentSha256","sizeBytes") VALUES($1,$2,$3,$4,(SELECT count(*)::integer FROM "CalendarPostAsset" WHERE "postId"=$2),$5,$6,$7) ON CONFLICT(id) DO UPDATE SET "fileKey"=EXCLUDED."fileKey","objectVersion"=EXCLUDED."objectVersion","contentSha256"=EXCLUDED."contentSha256","mediaType"=EXCLUDED."mediaType","sizeBytes"=EXCLUDED."sizeBytes" WHERE "CalendarPostAsset"."postId"=EXCLUDED."postId" RETURNING id`,[input.assetId,p.id,verified.fileKey,verified.mediaType,verified.objectVersion,verified.contentSha256,verified.sizeBytes])).rows;if(updated.length!==1)throw Error('ASSET_RESOURCE_SCOPE_CONFLICT');
   }await tx.query(`UPDATE "CalendarPost" SET "tikTokConsentAt"=NULL,"tikTokConsentHash"=NULL,"tikTokConsentBy"=NULL WHERE id=$1`,[p.id]);return {ok:true,assetId:input.assetId};
  });
 }
 async function account(input:{operationId:string;actor:string;calendarId:string;bindingId:string;expectedVersion:number;disconnect?:boolean;proof:unknown}){
  await permission(input.actor,input.calendarId,'channels.manage');return replay(input.operationId,input.actor,input,async tx=>{
   const {v,database}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'channels.manage'});const evidence=await deps.verifyAccount(tx,input.proof);
   await tx.query(`INSERT INTO "SocialConnection"(id,"calendarId",platform,"platformAccountId",status,"accessToken","accessTokenExpiresAt","tokenScopes","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,"platformAccountId"=EXCLUDED."platformAccountId","accessToken"=EXCLUDED."accessToken","accessTokenExpiresAt"=EXCLUDED."accessTokenExpiresAt","tokenScopes"=EXCLUDED."tokenScopes","updatedAt"=clock_timestamp() WHERE "SocialConnection"."calendarId"=EXCLUDED."calendarId" AND "SocialConnection".platform=EXCLUDED.platform`,[evidence.connectionId,input.calendarId,evidence.platform,evidence.providerAccountId,input.disconnect?'DISCONNECTED':'CONNECTED',input.disconnect?null:evidence.accessToken,evidence.expiresAt,evidence.tokenScopes]);
   const connection=(await tx.query(`SELECT * FROM "SocialConnection" WHERE id=$1`,[evidence.connectionId])).rows[0];if(connection.calendarId!==input.calendarId||connection.platform!==evidence.platform)throw Error('ACCOUNT_SCOPE_CONFLICT');
   if(evidence.refreshToken!==undefined)await tx.query(`UPDATE "SocialConnection" SET "refreshToken"=$2,"refreshTokenExpiresAt"=$3 WHERE id=$1`,[evidence.connectionId,input.disconnect?null:evidence.refreshToken,input.disconnect?null:evidence.refreshTokenExpiresAt??null]);
   if(evidence.accountName!==undefined)await tx.query(`UPDATE "SocialConnection" SET "accountName"=$2,username=$3 WHERE id=$1`,[evidence.connectionId,evidence.accountName,evidence.username??null]);
   const store=createCanonicalPublishingStore({database,lockAndValidate:async()=>{}});return store.changeAccount({operationId:input.operationId,actor:input.actor,bindingId:input.bindingId,calendarId:input.calendarId,platform:evidence.platform,expectedVersion:input.expectedVersion,providerAccountId:evidence.providerAccountId,connectionId:evidence.connectionId,authorizationHash:accountAuthorizationHash(connection as any),state:input.disconnect?'DISCONNECTED':'CONNECTED'});
  });
 }
 async function membership(input:{operationId:string;actor:string;calendarId:string;memberId:string;assignment:unknown;remove?:boolean}){
  await permission(input.actor,input.calendarId,'people.manage');return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'people.manage'});const owner=(await tx.query(`SELECT "managerId" FROM "SocialCalendar" WHERE id=$1`,[input.calendarId])).rows[0];
   const actorMember=(await tx.query(`SELECT * FROM "CalendarCollaborator" WHERE "calendarId"=$1 AND "creatorId"=$2`,[input.calendarId,input.actor])).rows[0],actorRole=owner.managerId===input.actor?'OWNER':normalizeTeamRole(actorMember?.role??''),member=(await tx.query(`SELECT * FROM "CalendarCollaborator" WHERE "calendarId"=$1 AND "creatorId"=$2`,[input.calendarId,input.memberId])).rows[0];
   if(input.memberId===owner.managerId||input.memberId===input.actor&&!input.remove)throw Error('OWNER_MEMBERSHIP_IMMUTABLE');
   if(!actorRole||member&&!canManageTeamRole(actorRole,member.role))throw Error('Only the owner can appoint or change another manager');
   if(!input.remove){const selected=validateTeamAssignment(input.assignment);if('error'in selected)throw Error(selected.error);if(!canManageTeamRole(actorRole,selected.role))throw Error('Only the owner can appoint another manager');
    if(actorRole!=='OWNER'&&selected.permissions.some(p=>!effectiveTeamPermissions(actorRole,actorMember.permissions,actorMember.customPermissions).includes(p)))throw Error('You can only grant features you have access to');
    const account=(await tx.query(`SELECT * FROM "Creator" WHERE id=$1`,[owner.managerId])).rows[0] as ContentWorkspaceAccount;
    if(!canAccessContentWorkspace(account)||!getContentWorkspacePlan(account))throw Error('WORKSPACE_ENTITLEMENT_DENIED');
    if(needsAdvancedTeamPermissions(selected.role,selected.customPermissions)&&!canUseContentWorkspaceFeature(account,'advancedTeamPermissions'))throw Error('Upgrade to Studio to assign this role or customize feature access');
    if(!member)await deps.validateUsage(tx,{actor:input.actor,calendarId:input.calendarId,kind:'MEMBERSHIP'});
   }
   if(input.remove)await tx.query(`DELETE FROM "CalendarCollaborator" WHERE "calendarId"=$1 AND "creatorId"=$2`,[input.calendarId,input.memberId]);else{const assignment=validateTeamAssignment(input.assignment);if('error'in assignment)throw Error(assignment.error);await tx.query(`INSERT INTO "CalendarCollaborator"(id,"calendarId","creatorId",role,permissions,"customPermissions") VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT("calendarId","creatorId") DO UPDATE SET role=EXCLUDED.role,permissions=EXCLUDED.permissions,"customPermissions"=EXCLUDED."customPermissions"`,[randomUUID(),input.calendarId,input.memberId,assignment.role,assignment.permissions,assignment.customPermissions]);}return {ok:true};
  });
 }
 async function membershipById(input:{operationId:string;actor:string;calendarId:string;collaboratorId:string;assignment:unknown;remove?:boolean}){
  await permission(input.actor,input.calendarId,'people.manage');return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'people.manage'});
   const member=(await tx.query(`SELECT m.*,c.email FROM "CalendarCollaborator" m JOIN "Creator" c ON c.id=m."creatorId" WHERE m.id=$1 AND m."calendarId"=$2`,[input.collaboratorId,input.calendarId])).rows[0];if(!member)throw Error('Teammate not found');
   const scoped={transaction:<T>(fn:(t:OwnershipTransaction)=>Promise<T>)=>fn(tx)},actions=createCanonicalApplicationActions({...deps,database:scoped});
   const result=await actions.membership({operationId:input.operationId+'-membership',actor:input.actor,calendarId:input.calendarId,memberId:member.creatorId,assignment:input.assignment,remove:input.remove});
   const actor=(await tx.query(`SELECT name,email FROM "Creator" WHERE id=$1`,[input.actor])).rows[0],selected=input.remove?null:validateTeamAssignment(input.assignment);
   await tx.query(`INSERT INTO "CalendarTeamActivity"(id,"calendarId","actorCreatorId","actorName",action,"targetEmail",details) VALUES($1,$2,$3,$4,$5,$6,$7)`,[policyHash({operationId:input.operationId,action:'team-activity'}).slice(0,40),input.calendarId,input.actor,actor.name||actor.email,input.remove?'MEMBER_REMOVED':'ACCESS_CHANGED',member.email,input.remove?{role:member.role}:{previousRole:member.role,...selected}]);return result;
  });
 }
 async function billing(input:{operationId:string;actor:string;ownerId:string;billingStatus:string;trialEndsAt?:Date|null;comped?:boolean}){await deps.database.transaction(tx=>deps.authorizeBilling(tx,input.actor,input.ownerId));return replay(input.operationId,input.actor,input,async tx=>{
  const {v}=services(tx);await v.lockForPolicyChange(tx);await deps.authorizeBilling(tx,input.actor,input.ownerId);
  if(!['PENDING_SETUP','TRIAL','ACTIVE','OFFLINE'].includes(input.billingStatus))throw Error('INVALID_BILLING_STATUS');await tx.query(`UPDATE "Creator" SET "contentWorkspaceBillingStatus"=$2,"contentWorkspaceTrialEndsAt"=$3,"isComped"=$4 WHERE id=$1`,[input.ownerId,input.billingStatus,input.trialEndsAt??null,input.comped===true]);return {ok:true};
 });}
 async function retainPost(tx:OwnershipTransaction,p:Record<string,any>,actor:string,operationId:string,reason:string,adminDeletion=false){
  const {database}=services(tx);
  const external=(await tx.query(`SELECT 1 FROM "PublishingExternalAttempt" a JOIN "PublishingJob" j ON j.id=a."jobId" WHERE j."postId"=$1 LIMIT 1`,[p.id])).rows.length>0||!!(p.publishWorkerStartedAt||p.tikTokInitStartedAt||p.platformPostId||p.instagramMediaId||p.tikTokPublishId)||(await tx.query(`SELECT 1 FROM "PublishingJob" WHERE "postId"=$1 AND "intentId" IS NULL LIMIT 1`,[p.id])).rows.length>0||['PUBLISHING','FAILED','PUBLISHED'].some(status=>[p.publishStatus,p.instagramPublishStatus,p.tikTokPublishStatus].includes(status));
  const hasAttempt=(await tx.query(`SELECT 1 FROM "PublishingExternalAttempt" a JOIN "PublishingJob" j ON j.id=a."jobId" WHERE j."postId"=$1 LIMIT 1`,[p.id])).rows.length>0;
  const unresolved=(await tx.query(`SELECT 1 FROM "PublishingJob" WHERE "postId"=$1 AND phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN') LIMIT 1`,[p.id])).rows.length>0||external&&!hasAttempt;
  const intents=(await tx.query(`SELECT * FROM "PublishingIntent" WHERE "postId"=$1 AND state='ACTIVE' ORDER BY id FOR UPDATE`,[p.id])).rows;
  for(const intent of intents){
   const attempted=(await tx.query(`SELECT 1 FROM "PublishingExternalAttempt" WHERE "intentId"=$1 AND outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED') UNION ALL SELECT 1 FROM "PublishingRetryGeneration" WHERE "intentId"=$1 AND outcome IN ('AUTHORIZED','ACCEPTED','UNKNOWN','CONFIRMED') LIMIT 1`,[intent.id])).rows.length>0;
   if(attempted)continue; // Preserve exact authorized lineage; tombstone vetoes any new send.
   const cancel=createPublishingIntentActions({database,lockAndValidatePost:async(checkTx,request,action)=>{
    if(action!=='cancel'||request.actor!==actor||request.postId!==p.id||request.platform!==intent.platform)throw Error('RETENTION_CANCELLATION_SCOPE_CONFLICT');
    const scope=(await checkTx.query(`SELECT c."managerId",a."isDeactivated" FROM "CalendarPost" p JOIN "SocialCalendar" c ON c.id=p."calendarId" JOIN "Creator" a ON a.id=$2 WHERE p.id=$1 AND p."calendarId"=$3`,[p.id,actor,p.calendarId])).rows[0];if(!scope||scope.isDeactivated)throw Error('RETENTION_ACTOR_DENIED');
    if(adminDeletion){if(!deps.authorizeCreatorDeletion)throw Error('TRUSTED_ADMIN_DELETION_REQUIRED');await deps.authorizeCreatorDeletion(checkTx,actor,scope.managerId);}else if(scope.managerId!==actor)await services(checkTx).v.validateWorkspacePermission(checkTx,{actor,calendarId:p.calendarId,permission:'calendar.edit'});
   },applyEdit:async()=>{throw Error('RETENTION_CANCELLATION_ONLY');},validateDueTime:async()=>{throw Error('RETENTION_CANNOT_CREATE_REVISION');},verifyRetryEvidence:async()=>{throw Error('RETENTION_CANNOT_AUTHORIZE_RETRY');}});
   const result=await cancel.cancel({operationId:policyHash({operationId,intentId:intent.id,action:'retention-cancel'}).slice(0,40),actor,intentId:intent.id,postId:p.id,platform:intent.platform,expectedRevision:intent.currentRevision});
   if(result.outcome!=='APPLIED')throw Error('RETENTION_CANCEL_CONFLICT');
  }
  await tx.query(`INSERT INTO "PublishingResourceTombstone"("resourceType","resourceId","evidenceHash","retentionUntil",actor,"operationId",reason,dependency) VALUES('POST',$1,$2,NULL,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[p.id,policyHash({postId:p.id,reason}),actor,operationId,reason,unresolved?'EXTERNAL_RECONCILIATION_AND_POLICY_REVIEW':hasAttempt?'HISTORICAL_PUBLICATION_POLICY_REVIEW':'RETENTION_PRIVACY_BILLING_POLICY_REVIEW']);
  return {retained:true,reconciliationOnly:unresolved};
 }
 async function eraseAdminCreator(input:{operationId:string;actor:string;subjectId:string}){
  if(!deps.authorizeCreatorDeletion)throw Error('TRUSTED_ADMIN_DELETION_REQUIRED');
  await deps.database.transaction(tx=>deps.authorizeCreatorDeletion!(tx,input.actor,input.subjectId));if(input.actor===input.subjectId)throw Error('ADMIN_CANNOT_DELETE_SELF');
  return replay(input.operationId,input.actor,input,async tx=>{
   await services(tx).v.lockForPolicyChange(tx);await deps.authorizeCreatorDeletion!(tx,input.actor,input.subjectId);
   const subject=(await tx.query(`SELECT id FROM "Creator" WHERE id=$1 FOR UPDATE NOWAIT`,[input.subjectId])).rows[0];if(!subject)throw Error('CREATOR_MISSING');
   const calendars=(await tx.query(`SELECT id FROM "SocialCalendar" WHERE "managerId"=$1 ORDER BY id`,[input.subjectId])).rows;
   for(const calendar of calendars){const posts=(await tx.query(`SELECT * FROM "CalendarPost" WHERE "calendarId"=$1 ORDER BY id`,[calendar.id])).rows;for(const p of posts)await retainPost(tx,p,input.actor,input.operationId,'ADMIN_CREATOR_DELETE',true);await tx.query(`INSERT INTO "PublishingResourceTombstone"("resourceType","resourceId","evidenceHash","retentionUntil",actor,"operationId",reason,dependency) VALUES('WORKSPACE',$1,$2,NULL,$3,$4,'ADMIN_CREATOR_DELETE','RETENTION_PRIVACY_BILLING_POLICY_REVIEW') ON CONFLICT DO NOTHING`,[calendar.id,policyHash({calendarId:calendar.id}),input.actor,input.operationId]);}
   await tx.query(`INSERT INTO "PublishingResourceTombstone"("resourceType","resourceId","evidenceHash","retentionUntil",actor,"operationId",reason,dependency) VALUES('CREATOR',$1,$2,NULL,$3,$4,'ADMIN_CREATOR_DELETE','RETENTION_PRIVACY_BILLING_POLICY_REVIEW') ON CONFLICT DO NOTHING`,[input.subjectId,policyHash({creatorId:input.subjectId}),input.actor,input.operationId]);await tx.query(`UPDATE "Creator" SET "isDeactivated"=true WHERE id=$1`,[input.subjectId]);return {ok:true,retained:true};
  });
 }
 async function eraseCreator(input:{operationId:string;actor:string;confirmedPasswordHash:string}){
  return replay(input.operationId,input.actor,{operationId:input.operationId,actor:input.actor,confirmationHash:policyHash(input.confirmedPasswordHash)},async tx=>{
   await services(tx).v.lockForPolicyChange(tx);
   const creator=(await tx.query(`SELECT "passwordHash","isDeactivated" FROM "Creator" WHERE id=$1 FOR UPDATE NOWAIT`,[input.actor])).rows[0];
   if(!creator||creator.isDeactivated||!input.confirmedPasswordHash||creator.passwordHash!==input.confirmedPasswordHash)throw Error('DELETION_CONFIRMATION_CHANGED');
   const calendars=(await tx.query(`SELECT id FROM "SocialCalendar" WHERE "managerId"=$1 ORDER BY id`,[input.actor])).rows;
   for(const calendar of calendars){const posts=(await tx.query(`SELECT * FROM "CalendarPost" WHERE "calendarId"=$1 ORDER BY id`,[calendar.id])).rows;for(const p of posts)await retainPost(tx,p,input.actor,input.operationId,'CREATOR_DELETE');await tx.query(`INSERT INTO "PublishingResourceTombstone"("resourceType","resourceId","evidenceHash","retentionUntil",actor,"operationId",reason,dependency) VALUES('WORKSPACE',$1,$2,NULL,$3,$4,'CREATOR_DELETE','RETENTION_PRIVACY_BILLING_POLICY_REVIEW') ON CONFLICT DO NOTHING`,[calendar.id,policyHash({calendarId:calendar.id}),input.actor,input.operationId]);}
   await tx.query(`INSERT INTO "PublishingResourceTombstone"("resourceType","resourceId","evidenceHash","retentionUntil",actor,"operationId",reason,dependency) VALUES('CREATOR',$1,$2,NULL,$1,$3,'CREATOR_DELETE','RETENTION_PRIVACY_BILLING_POLICY_REVIEW') ON CONFLICT DO NOTHING`,[input.actor,policyHash({creatorId:input.actor}),input.operationId]);
   await tx.query(`UPDATE "Creator" SET "isDeactivated"=true WHERE id=$1`,[input.actor]);return {ok:true,retained:true};
  });
 }
 async function erase(input:{operationId:string;actor:string;calendarId:string;postId?:string;resourceType:'POST'|'WORKSPACE'|'CREATOR';resourceId:string}){
  const verifyOwner=async(tx:OwnershipTransaction)=>{const scope=(await tx.query(`SELECT c."managerId",a."isDeactivated" FROM "SocialCalendar" c JOIN "Creator" a ON a.id=$2 WHERE c.id=$1`,[input.calendarId,input.actor])).rows[0];if(!scope||scope.managerId!==input.actor)throw Error('WORKSPACE_MISSING');if(scope.isDeactivated)throw Error('ACTOR_DEACTIVATED');};
  await deps.database.transaction(verifyOwner);return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await verifyOwner(tx);
   const owner=(await tx.query(`SELECT "managerId" FROM "SocialCalendar" WHERE id=$1`,[input.calendarId])).rows[0];if(owner.managerId!==input.actor)throw Error('OWNER_DELETION_REQUIRED');
   if(input.resourceType==='CREATOR'&&input.resourceId!==input.actor||input.resourceType==='WORKSPACE'&&input.resourceId!==input.calendarId)throw Error('RESOURCE_SCOPE_CONFLICT');
   const posts=input.resourceType==='POST'?[await post(tx,input.resourceId,input.calendarId)]:(await tx.query(`SELECT p.* FROM "CalendarPost" p JOIN "SocialCalendar" c ON c.id=p."calendarId" WHERE ${input.resourceType==='CREATOR'?'c."managerId"=$1':'c.id=$1'} ORDER BY p.id`,[input.resourceId])).rows;
   for(const p of posts)await retainPost(tx,p,input.actor,input.operationId,'USER_DELETE');
   if(input.resourceType!=='POST')await tx.query(`INSERT INTO "PublishingResourceTombstone"("resourceType","resourceId","evidenceHash","retentionUntil",actor,"operationId",reason,dependency) VALUES($1,$2,$3,NULL,$4,$5,'USER_DELETE','RETENTION_PRIVACY_BILLING_POLICY_REVIEW') ON CONFLICT DO NOTHING`,[input.resourceType,input.resourceId,policyHash({id:input.resourceId}),input.actor,input.operationId]);
   if(input.resourceType==='CREATOR')await tx.query(`UPDATE "Creator" SET "isDeactivated"=true WHERE id=$1`,[input.actor]);
   return {ok:true,tombstoned:true,retained:true,requiresNonPublishingCleanup:input.resourceType!=='POST'};
  });
 }
 async function createBatch(input:{operationId:string;actor:string;calendarId:string;platforms:string[];caption:string;postDate?:Date;fields?:Record<string,unknown>}){
  await permission(input.actor,input.calendarId,'calendar.edit');if(!input.platforms.length||input.platforms.length>6||new Set(input.platforms).size!==input.platforms.length)throw Error('INVALID_POST_BATCH');
  return replay(input.operationId,input.actor,input,async tx=>{const scoped={transaction:<T>(fn:(t:OwnershipTransaction)=>Promise<T>)=>fn(tx)};const actions=createCanonicalApplicationActions({...deps,database:scoped}),posts=[];
   for(const [index,platform] of input.platforms.entries()){const id=policyHash({operation:input.operationId,actor:input.actor,calendar:input.calendarId,platform}).slice(0,32);posts.push(await actions.createPost({operationId:input.operationId+'-'+index,actor:input.actor,calendarId:input.calendarId,id,platform,caption:input.caption,postDate:input.postDate,fields:input.fields}));}return {ok:true,posts};
  });
 }
 async function metadata(actor:string,calendarId:string,postId:string){return deps.database.transaction(async tx=>{
  const {v}=services(tx);await v.validateWorkspacePermission(tx,{actor,calendarId,permission:'VIEW_ONLY'});const p=await post(tx,postId,calendarId);
  const intent=(await tx.query(`SELECT * FROM "PublishingIntent" WHERE "postId"=$1 AND platform=$2`,[postId,p.platform])).rows[0];
  const account=(await tx.query(`SELECT * FROM "PublishingAccountBinding" WHERE "calendarId"=$1 AND platform=$2`,[calendarId,p.platform])).rows[0];
  const job=intent?(await tx.query(`SELECT * FROM "PublishingJob" WHERE "intentId"=$1 AND "intentRevision"=$2`,[intent.id,intent.currentRevision])).rows[0]:null;
  const invalid=intent?(await tx.query(`SELECT 1 FROM "PublishingPostEligibilityInvalidation" WHERE "intentId"=$1 AND revision=$2 UNION ALL SELECT 1 FROM "PublishingEligibilityHold" WHERE "intentId"=$1 AND revision=$2`,[intent.id,intent.currentRevision])).rows.length>0:false;
  const destinationAccount=account?(await tx.query(`SELECT s."platformAccountId",to_jsonb(s)->>'accountName' AS name FROM "PublishingAccountVersion" v JOIN "SocialConnection" s ON s.id=v."connectionId" WHERE v."bindingId"=$1 AND v.version=$2`,[account.id,account.currentVersion])).rows[0]:null;
  const evidence=intent&&job?.phase==='REJECTED'?(await tx.query(`SELECT e.id FROM "PublishingRetryEvidence" e LEFT JOIN "PublishingExternalAttempt" a ON a.id=e."rootAttemptId" LEFT JOIN "PublishingRetryGeneration" g ON g.id=e."predecessorGenerationId" WHERE e."intentId"=$1 AND COALESCE(a."jobId",g."jobId")=$2 AND e.verified AND e."actorStopped" AND e.retryable AND NOT EXISTS(SELECT 1 FROM "PublishingRetryGeneration" next WHERE next."evidenceId"=e.id) ORDER BY e."createdAt" DESC LIMIT 1`,[intent.id,job.id])).rows[0]:null;
  // Identity is server-derived from immutable post/platform, never timestamps.
  return {protocol:'canonical',intentId:intent?.id??policyHash({postId,platform:p.platform}).slice(0,40),expectedRevision:intent?.currentRevision??0,platform:p.platform,dueAt:p.postDate instanceof Date?p.postDate.toISOString():null,destination:account?{accountBindingId:account.id,accountVersion:account.currentVersion}:null,providerAccountId:destinationAccount?.platformAccountId??null,accountDisplayName:destinationAccount?.name??destinationAccount?.platformAccountId??null,status:invalid&&job&&['READY','PREPARED','CANCELLED'].includes(job.phase)?'NOT_SCHEDULED':job?legacyProjection(job.phase):p.platform==='INSTAGRAM'?p.instagramPublishStatus:p.platform==='TIKTOK'?p.tikTokPublishStatus:p.publishStatus,phase:job?.phase??null,nextSchedulingAction:intent?.state==='ACTIVE'?'reschedule':'schedule',eligibility:invalid?'INVALIDATED':'CURRENT',evidenceId:evidence?.id??null,generation:job?(await tx.query(`SELECT generation FROM "PublishingRetryGeneration" WHERE "jobId"=$1`,[job.id])).rows[0]?.generation??1:null};
 });}
 async function postView(calendarId:string,postId:string){return deps.database.transaction(async tx=>{
  const p=await post(tx,postId,calendarId),assets=(await tx.query(`SELECT * FROM "CalendarPostAsset" WHERE "postId"=$1 ORDER BY "displayOrder",id`,[postId])).rows;
  const related=async(table:string)=>((await tx.query(`SELECT to_regclass($1) IS NOT NULL AS present`,['"'+table+'"'])).rows[0].present?(await tx.query(`SELECT * FROM "${table}" WHERE "postId"=$1 ORDER BY ${table==='CalendarPostVideoComment'?'"videoTimestampSeconds",id':'id'}`,[postId])).rows:[]);
  return {...p,assets:assets.map((a):Record<string,any>=>({...a,sizeBytes:Number(a.sizeBytes??0)})),customFields:await related('CalendarPostCustomField'),videoComments:await related('CalendarPostVideoComment')};
 });}
 async function resubmit(input:{operationId:string;actor:string;calendarId:string;postId:string}){
  await permission(input.actor,input.calendarId,'delivery.manage');return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'delivery.manage'});const p=await post(tx,input.postId,input.calendarId);
   if(p.approvalStatus!=='NEEDS_REVISION')throw Error('Only posts with requested changes can be resubmitted');
   if(!(await tx.query(`SELECT 1 FROM "CalendarPostAsset" WHERE "postId"=$1 LIMIT 1`,[p.id])).rows.length)throw Error('Add content to this post before resubmitting it');
   await invalidate(tx,p,input.actor,input.operationId,'delivery.manage');await tx.query(`UPDATE "CalendarPost" SET "approvalStatus"='PENDING',"updatedAt"=clock_timestamp() WHERE id=$1`,[p.id]);return {ok:true};
  });
 }
 async function importPosts(calendarId:string,actor:string,raw:unknown){
  const input=validateConfirm(raw);await permission(actor,calendarId,'calendar.edit');
  return replay(input.requestId,actor,{calendarId,input},async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor,calendarId,permission:'calendar.edit'});
   const rows=(await tx.query(`SELECT p.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('label',label,'value',value)) FROM "CalendarPostCustomField" f WHERE f."postId"=p.id),'[]'::jsonb) AS "customFields" FROM "CalendarPost" p WHERE "calendarId"=$1`,[calendarId])).rows;
   const duplicates=duplicateIndex(rows as ExistingPost[],input.options.timezone),postIds:string[]=[],skipped:string[]=[];let firstDate:string|null=null;
   const scoped={transaction:<T>(fn:(t:OwnershipTransaction)=>Promise<T>)=>fn(tx)},actions=createCanonicalApplicationActions({...deps,database:scoped});
   for(const row of input.rows){const iso=rowIssues(row,input.options).iso!;
    for(const platform of parsePlatforms(row.platform)){
     const candidate={...row,id:row.id,postDate:iso,platform} as ExistingPost;
     if(duplicates.exact(candidate)){skipped.push(row.id+':'+platform);continue;}
     if(duplicates.possible(candidate)&&!row.keepPossibleDuplicate)throw Error('Possible duplicate. Explicitly keep it or exclude the item.');
     const id=policyHash({requestId:input.requestId,calendarId,rowId:row.id,platform}).slice(0,40),customFields=[...row.customFields,...(row.notes.trim()?[{label:'Notes',value:row.notes}]:[]),...(row.status.trim()?[{label:'Source status',value:row.status}]:[])];
     await actions.createPost({operationId:input.requestId+'-'+postIds.length,actor,calendarId,id,platform,caption:row.caption,postDate:new Date(iso),fields:{...row,customFields}});
     await tx.query(`UPDATE "CalendarPost" SET "approvalStatus"=$2 WHERE id=$1`,[id,approvalFor(row.status)]);
     postIds.push(id);duplicates.add(candidate);if(!firstDate||iso<firstDate)firstDate=iso;
    }
   }
   return {postIds,skipped,firstDate};
  });
 }
 async function restoreDraft(input:{operationId:string;actor:string;calendarId:string;postId:string;generationId:string}){
  await permission(input.actor,input.calendarId,'calendar.edit');return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'calendar.edit'});const p=await post(tx,input.postId,input.calendarId);if(!p.isAiDraft)throw Error('AI draft not found');
   const generation=(await tx.query(`SELECT * FROM "CalendarPostAiGeneration" WHERE id=$1 AND "postId"=$2`,[input.generationId,p.id])).rows[0];if(!generation)throw Error('Generation not found');
   const scoped={transaction:<T>(fn:(t:OwnershipTransaction)=>Promise<T>)=>fn(tx)},actions=createCanonicalApplicationActions({...deps,database:scoped});
   await actions.changeContent({operationId:input.operationId+'-restore',actor:input.actor,calendarId:input.calendarId,postId:p.id,caption:generation.caption,patch:Object.fromEntries(['postDate','platform','postType','category','hook','script','contentIdea','cta','hashtags'].map(k=>[k,generation[k]]))});return {ok:true};
  });
 }
 async function plan(input:{operationId:string;actor?:string;credential?:string;calendarId:string;action:string;note?:string}){
  const viewer=input.actor===undefined;
  if(!viewer)await permission(input.actor!,input.calendarId,input.action==='publish'?'delivery.manage':'workspace.manage');
  return deps.database.transaction(async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);
   const actor=viewer?(await v.validateViewerWorkspace(tx,{calendarId:input.calendarId,credential:input.credential??''})).principalId:input.actor!;
   if(!viewer)await v.validateWorkspacePermission(tx,{actor,calendarId:input.calendarId,permission:input.action==='publish'?'delivery.manage':'workspace.manage'});
   const hash=policyHash({...input,credential:undefined}),old=(await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[input.operationId])).rows[0];if(old){if(old.actor!==actor||old.requestHash!==hash)throw Error('OPERATION_CONFLICT');return old.result;}
   const calendar=(await tx.query(`SELECT * FROM "SocialCalendar" WHERE id=$1`,[input.calendarId])).rows[0];if(!calendar)throw Error('Calendar not found');
   if(viewer&&calendar.planStatus!=='AWAITING_APPROVAL')throw Error("This plan isn't currently awaiting a response");
   if(viewer&&!['approve','request_changes'].includes(input.action)||!viewer&&input.action!=='publish')throw Error('Unknown action');
   if(!viewer&&!['BUILDING','PLAN_NEEDS_CHANGES'].includes(calendar.planStatus))throw Error('This plan cannot be submitted again');
   const status=viewer?input.action==='approve'?'PLAN_APPROVED':'PLAN_NEEDS_CHANGES':'AWAITING_APPROVAL';
   const calendarRow=(await tx.query(`UPDATE "SocialCalendar" SET "planStatus"=$2::"CalendarPlanStatus","planApprovalNote"=$3,"planApprovedAt"=CASE WHEN $2::text='PLAN_APPROVED' THEN clock_timestamp() ELSE "planApprovedAt" END,"planSubmittedAt"=CASE WHEN $2::text='AWAITING_APPROVAL' THEN clock_timestamp() ELSE "planSubmittedAt" END,"updatedAt"=clock_timestamp() WHERE id=$1 RETURNING *`,[input.calendarId,status,input.action==='request_changes'?input.note?.trim()||null:null])).rows[0];
   const result={calendar:JSON.parse(JSON.stringify(calendarRow,(_key,value)=>typeof value==='bigint'?Number(value):value))};
   await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[input.operationId,actor,hash,result]);return result;
  });
 }
 async function generate(input:{operationId:string;actor:string;calendarId:string;body:Record<string,any>}){
  if(!deps.generateContent)throw Error('AI_GENERATION_SERVICE_REQUIRED');await permission(input.actor,input.calendarId,'ai.generate');
  const b=input.body,date=(s:unknown)=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const parsed=new Date(s+'T00:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===s;};
  if(!date(b.startDate)||!date(b.endDate)||b.endDate<b.startDate||!Array.isArray(b.platforms)||!b.platforms.length||b.platforms.some((p:string)=>!['INSTAGRAM','TIKTOK','FACEBOOK','LINKEDIN','X','YOUTUBE'].includes(p))||b.postsPerWeek!==undefined&&(!Number.isFinite(b.postsPerWeek)||b.postsPerWeek<1||b.postsPerWeek>14))throw Error('Invalid generation dates, platforms or frequency');
  if(b.customInstructions!==undefined&&typeof b.customInstructions!=='string'||b.contentStrategy!==undefined&&!['SAME_CONTENT','DIFFERENT_CONTENT','CUSTOM_GROUPS'].includes(b.contentStrategy)||b.scheduleStrategy!==undefined&&!['SAME_TIME','SAME_DAY','CUSTOM'].includes(b.scheduleStrategy)||b.contentGroups!==undefined&&(!Array.isArray(b.contentGroups)||b.contentGroups.some((g:unknown)=>!Array.isArray(g)||g.some(p=>typeof p!=='string'))))throw Error('Invalid generation strategy');
  const hash=policyHash(input),reservation=await deps.database.transaction(async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'ai.generate'});
   const old=(await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[input.operationId])).rows[0];if(old){if(old.actor!==input.actor||old.requestHash!==hash)throw Error('OPERATION_CONFLICT');return {completed:old.result};}
   if((await tx.query(`SELECT 1 FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[input.operationId+'-quota'])).rows.length)throw Error('AI_GENERATION_PENDING_RECONCILIATION');
   const calendar=(await tx.query(`SELECT * FROM "SocialCalendar" WHERE id=$1`,[input.calendarId])).rows[0];if(!calendar?.aiBusinessSummary?.trim())throw Error('Upload a business document before generating content');
   if(b.usePerformanceRecommendations===true){const owner=(await tx.query(`SELECT * FROM "Creator" WHERE id=$1`,[calendar.managerId])).rows[0] as ContentWorkspaceAccount;if(!canUseContentWorkspaceFeature(owner,'performanceRecommendations'))throw Error('Upgrade to Studio to use performance recommendations');}
   await deps.validateUsage(tx,{actor:input.actor,calendarId:input.calendarId,kind:'AI_DRAFT'});
   await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[input.operationId+'-quota',input.actor,hash,{reserved:true}]);return {calendar};
  });if('completed'in reservation)return reservation.completed;
  const ideas=await deps.generateContent({...b,clientName:reservation.calendar.clientName,businessSummary:reservation.calendar.aiBusinessSummary});
  if(!Array.isArray(ideas)||!ideas.length||ideas.length>500)throw Error('AI returned invalid content');
  return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'ai.generate'});
   const scoped={transaction:<T>(fn:(t:OwnershipTransaction)=>Promise<T>)=>fn(tx)},actions=createCanonicalApplicationActions({...deps,database:scoped}),posts=[];
   for(const [index,idea]of ideas.entries()){
    if(!date(idea.postDate)||!b.platforms.includes(idea.platform))throw Error('Generated date/platform is invalid');
    const time=b.platformSchedules?.[idea.platform]?.time??'09:00';if(typeof time!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('Generated schedule time is invalid');
    const id=policyHash({operationId:input.operationId,index}).slice(0,40),postDate=new Date(idea.postDate+'T'+time+':00Z');
    await actions.createPost({operationId:input.operationId+'-'+index,actor:input.actor,calendarId:input.calendarId,id,platform:idea.platform,caption:idea.caption??'',postDate,fields:idea,aiDraft:true,usageAlreadyReserved:true});posts.push((await tx.query(`SELECT * FROM "CalendarPost" WHERE id=$1`,[id])).rows[0]);
   }return {created:posts.length,posts,aiGenerationsRemaining:null};
  });
 }
 type AccountEvidence=Awaited<ReturnType<typeof deps.verifyAccount>>;
 async function bindVerifiedAccount(input:{operationId:string;actor:string;calendarId:string;platform:string;evidence?:AccountEvidence;disconnect?:boolean;expectedAccountVersion?:number;operationRequest?:Record<string,unknown>;selectionOperationId?:string}){
  const request=input.operationRequest?{actor:input.actor,calendarId:input.calendarId,platform:input.platform,operationRequest:input.operationRequest}:{...input,evidence:input.evidence?{providerAccountId:input.evidence.providerAccountId,connectionId:input.evidence.connectionId,tokenScopes:input.evidence.tokenScopes,credentialHash:policyHash(input.evidence)}:undefined};
  await permission(input.actor,input.calendarId,'channels.manage');return replay(input.operationId,input.actor,request,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'channels.manage'});
   if(input.selectionOperationId&&(await tx.query(`SELECT 1 FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[input.selectionOperationId+'-selected'])).rows.length)throw Error('OAUTH_SELECTION_ALREADY_APPLIED');
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`account:${input.calendarId}:${input.platform}`]);
   const binding=(await tx.query(`SELECT * FROM "PublishingAccountBinding" WHERE "calendarId"=$1 AND platform=$2 FOR UPDATE`,[input.calendarId,input.platform])).rows[0];
   if(input.expectedAccountVersion!==undefined&&(binding?.currentVersion??0)!==input.expectedAccountVersion)throw Error('ACCOUNT_VERSION_CONFLICT');
   const previous=binding?(await tx.query(`SELECT s.* FROM "PublishingAccountVersion" a JOIN "SocialConnection" s ON s.id=a."connectionId" WHERE a."bindingId"=$1 AND a.version=$2`,[binding.id,binding.currentVersion])).rows[0]:null;
   let evidence:AccountEvidence|null=input.evidence??(input.disconnect&&previous?{connectionId:previous.id,platform:previous.platform,providerAccountId:previous.platformAccountId,tokenScopes:previous.tokenScopes??'',accessToken:previous.accessToken??'',expiresAt:previous.accessTokenExpiresAt,refreshToken:previous.refreshToken??undefined,accountName:previous.accountName??undefined,username:previous.username??undefined}:null);
   if(!evidence||evidence.platform!==input.platform)throw Error('VERIFIED_ACCOUNT_REQUIRED');
   const proposed=(await tx.query(`SELECT "calendarId",platform,"platformAccountId" FROM "SocialConnection" WHERE id=$1`,[evidence.connectionId])).rows[0];
   if(proposed&&(proposed.calendarId!==input.calendarId||proposed.platform!==input.platform||proposed.platformAccountId!==evidence.providerAccountId))throw Error('ACCOUNT_CONNECTION_IDENTITY_CONFLICT');
   // Legacy UUIDs are already durable identities. Reuse the exact destination
   // tuple rather than colliding with its unique key or repurposing another row.
   const existing=(await tx.query(`SELECT id FROM "SocialConnection" WHERE "calendarId"=$1 AND platform=$2 AND "platformAccountId"=$3`,[input.calendarId,input.platform,evidence.providerAccountId])).rows[0];
   if(existing)evidence={...evidence,connectionId:existing.id};
   const scoped={transaction:<T>(fn:(t:OwnershipTransaction)=>Promise<T>)=>fn(tx)},actions=createCanonicalApplicationActions({...deps,database:scoped,verifyAccount:async()=>evidence});
   const result=await actions.account({operationId:input.operationId+'-bind',actor:input.actor,calendarId:input.calendarId,bindingId:binding?.id??policyHash({calendarId:input.calendarId,platform:input.platform}).slice(0,40),expectedVersion:binding?.currentVersion??0,disconnect:input.disconnect,proof:'trusted-server-evidence'});
   if(previous&&previous.id!==evidence.connectionId)await tx.query(`UPDATE "SocialConnection" SET status='DISCONNECTED',"updatedAt"=clock_timestamp() WHERE id=$1`,[previous.id]);
   const fields:Record<string,{id:string;token:string;expiry:string;connected:string;name?:string;refresh?:string}>={INSTAGRAM:{id:'instagramAccountId',token:'instagramAccessToken',expiry:'instagramTokenExpiresAt',connected:'instagramConnectedAt',name:'instagramUsername'},TIKTOK:{id:'tikTokOpenId',token:'tikTokAccessToken',expiry:'tikTokAccessTokenExpiresAt',connected:'tikTokConnectedAt',name:'tikTokUsername',refresh:'tikTokRefreshToken'},FACEBOOK:{id:'facebookPageId',token:'facebookAccessToken',expiry:'facebookTokenExpiresAt',connected:'facebookConnectedAt',name:'facebookPageName'},LINKEDIN:{id:'linkedinMemberId',token:'linkedinAccessToken',expiry:'linkedinAccessTokenExpiresAt',connected:'linkedinConnectedAt',name:'linkedinName',refresh:'linkedinRefreshToken'},X:{id:'xUserId',token:'xAccessToken',expiry:'xAccessTokenExpiresAt',connected:'xConnectedAt',name:'xUsername',refresh:'xRefreshToken'}};
   const f=fields[input.platform];if(!f)throw Error('INVALID_PLATFORM');const values:unknown[]=[input.calendarId,input.disconnect?null:evidence.providerAccountId,input.disconnect?null:evidence.accessToken,input.disconnect?null:evidence.expiresAt,input.disconnect?null:new Date()],assignments=[`"${f.id}"=$2`,`"${f.token}"=$3`,`"${f.expiry}"=$4`,`"${f.connected}"=$5`];
   if(f.name){values.push(input.disconnect?null:evidence.username??evidence.accountName??null);assignments.push(`"${f.name}"=$${values.length}`);}if(f.refresh){values.push(input.disconnect?null:evidence.refreshToken??null);assignments.push(`"${f.refresh}"=$${values.length}`);}
   await tx.query(`UPDATE "SocialCalendar" SET ${assignments.join(',')},"updatedAt"=clock_timestamp() WHERE id=$1`,values);
   if(input.platform==='INSTAGRAM'&&evidence.instagramPageId)await tx.query(`UPDATE "SocialCalendar" SET "instagramPageId"=$2 WHERE id=$1`,[input.calendarId,input.disconnect?null:evidence.instagramPageId]);
   if(input.platform==='LINKEDIN'&&evidence.linkedinMemberId)await tx.query(`UPDATE "SocialCalendar" SET "linkedinMemberId"=$2 WHERE id=$1`,[input.calendarId,input.disconnect?null:evidence.linkedinMemberId]);
   if(input.selectionOperationId)await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[input.selectionOperationId+'-selected',input.actor,policyHash(request),{accountId:input.evidence?.providerAccountId,operationId:input.operationId}]);
   return {ok:true,...result};
  });
 }
 async function regenerate(input:{operationId:string;actor:string;calendarId:string;postId:string;body:Record<string,any>}){
  if(!deps.regenerateContent)throw Error('AI_REGENERATION_SERVICE_REQUIRED');await permission(input.actor,input.calendarId,'calendar.edit');const hash=policyHash(input);
  const snapshot=(p:Record<string,any>)=>policyHash(Object.fromEntries(['postDate','platform','postType','category','hook','script','caption','contentIdea','cta','hashtags','isAiDraft','approvalStatus','updatedAt'].map(k=>[k,p[k]])));
  const reservation=await deps.database.transaction(async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'calendar.edit'});
   const old=(await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[input.operationId])).rows[0];if(old){if(old.actor!==input.actor||old.requestHash!==hash)throw Error('OPERATION_CONFLICT');return {completed:old.result};}
   if((await tx.query(`SELECT 1 FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[input.operationId+'-quota'])).rows.length)throw Error('AI_REGENERATION_PENDING_RECONCILIATION');
   const p=await post(tx,input.postId,input.calendarId);if(p.approvalStatus==='APPROVED'||p.publishWorkerStartedAt||p.tikTokInitStartedAt||p.platformPostId||p.instagramMediaId||p.tikTokPublishId||await busy(tx,p.id))throw Error('APPROVED_CONTENT_LOCKED');
   const calendar=(await tx.query(`SELECT * FROM "SocialCalendar" WHERE id=$1`,[input.calendarId])).rows[0];if(!calendar.aiBusinessSummary?.trim())throw Error('Upload a business document before generating content');
   await deps.validateUsage(tx,{actor:input.actor,calendarId:input.calendarId,kind:'AI_REGENERATION'});await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[input.operationId+'-quota',input.actor,hash,{reserved:true}]);return {p,calendar};
  });if('completed'in reservation)return reservation.completed;
  const p=reservation.p,currentPost={...Object.fromEntries(['platform','postType','category','caption','contentIdea','hook','script','cta','hashtags'].map(k=>[k,p[k]??''])),postDate:p.postDate.toISOString().slice(0,10)};
  const generated=await deps.regenerateContent({clientName:reservation.calendar.clientName,businessSummary:reservation.calendar.aiBusinessSummary,currentPost,instruction:typeof input.body.instruction==='string'?input.body.instruction.trim()||undefined:undefined,fields:Array.isArray(input.body.fields)&&input.body.fields.every((f:unknown)=>typeof f==='string')?input.body.fields:undefined});
  const postDate=new Date(String(generated.postDate)+'T09:00:00Z');if(!Number.isFinite(postDate.getTime())||!['INSTAGRAM','TIKTOK','FACEBOOK','LINKEDIN','X','YOUTUBE'].includes(generated.platform))throw Error('AI returned invalid date/platform');
  return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'calendar.edit'});const current=await post(tx,p.id,input.calendarId);if(snapshot(current)!==snapshot(p)||await busy(tx,p.id))throw Error('AI_CONTENT_CHANGED_DURING_GENERATION');await invalidate(tx,current,input.actor,input.operationId);
   const fields=['postType','category','hook','script','caption','contentIdea','cta','hashtags'],values:unknown[]=[policyHash({operationId:input.operationId,postId:p.id}).slice(0,40),p.id,postDate,generated.platform,...fields.map(k=>generated[k]||null)];
   const generation=(await tx.query(`INSERT INTO "CalendarPostAiGeneration"(id,"postId","generationNumber","postDate",platform,${fields.map(k=>'"'+k+'"').join(',')}) VALUES($1,$2,(SELECT COALESCE(max("generationNumber"),0)+1 FROM "CalendarPostAiGeneration" WHERE "postId"=$2),$3,$4,${fields.map((_,n)=>'$'+(n+5)).join(',')}) RETURNING *`,values)).rows[0];
   const updateValues:unknown[]=[p.id,postDate,generated.platform,...fields.map(k=>generated[k]||null)];await tx.query(`UPDATE "CalendarPost" SET "postDate"=$2,platform=$3,${fields.map((k,n)=>'"'+k+'"=$'+(n+4)).join(',')},"approvalStatus"='PENDING',"tikTokConsentAt"=NULL,"tikTokConsentBy"=NULL,"tikTokConsentHash"=NULL,"updatedAt"=clock_timestamp() WHERE id=$1`,updateValues);return {generation};
  });
 }
 async function creatorMetadata(actor:string,calendarId:string){
  await permission(actor,calendarId,'channels.view');const account=await deps.database.transaction(async tx=>{
   const {v}=services(tx);await v.validateWorkspacePermission(tx,{actor,calendarId,permission:'channels.view'});
   return (await tx.query(`SELECT b.id,b."currentVersion",v."providerAccountId" FROM "PublishingAccountBinding" b JOIN "PublishingAccountVersion" v ON v."bindingId"=b.id AND v.version=b."currentVersion" JOIN "SocialConnection" s ON s.id=v."connectionId" WHERE b."calendarId"=$1 AND b.platform='TIKTOK' AND b.state='CONNECTED' AND s.status='CONNECTED' AND s."platformAccountId"=v."providerAccountId"`,[calendarId])).rows[0];
  });if(!account)throw Error('Reconnect TikTok before continuing');
  const info=await deps.creatorInfo(calendarId,account.providerAccountId);
  await deps.database.transaction(async tx=>{const {v}=services(tx);await v.validateWorkspacePermission(tx,{actor,calendarId,permission:'channels.view'});if(!(await tx.query(`SELECT 1 FROM "PublishingAccountBinding" WHERE id=$1 AND "currentVersion"=$2 AND state='CONNECTED'`,[account.id,account.currentVersion])).rows.length)throw Error('TIKTOK_ACCOUNT_CHANGED');});
  return {...info,accountId:account.providerAccountId,privacyOptions:info.privacy_level_options,accountName:info.creator_nickname||info.creator_username,maxVideoDuration:info.max_video_post_duration_sec,canonicalAccount:{accountBindingId:account.id,accountVersion:account.currentVersion}};
 }
 async function listPosts(actor:string,calendarId:string){await permission(actor,calendarId,'VIEW_ONLY');const ids=await deps.database.transaction(async tx=>{await services(tx).v.validateWorkspacePermission(tx,{actor,calendarId,permission:'VIEW_ONLY'});return (await tx.query(`SELECT id FROM "CalendarPost" p WHERE "calendarId"=$1 AND NOT EXISTS(SELECT 1 FROM "PublishingResourceTombstone" t WHERE t."resourceType"='POST' AND t."resourceId"=p.id) ORDER BY "postDate",id`,[calendarId])).rows;});const posts=[];for(const p of ids)posts.push({...await postView(calendarId,p.id),publishing:await metadata(actor,calendarId,p.id)});return posts;}
 async function deletePlanningPosts(input:{operationId:string;actor:string;calendarId:string;postId?:string;draftOnly?:boolean}){
  await permission(input.actor,input.calendarId,'calendar.edit');return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'calendar.edit'});
   const posts=input.postId?[await post(tx,input.postId,input.calendarId)]:(await tx.query(`SELECT * FROM "CalendarPost" WHERE "calendarId"=$1 AND "isAiDraft" ORDER BY id`,[input.calendarId])).rows;
   const cleanupKeys:string[]=[];
   for(const p of posts){if(input.draftOnly&&!p.isAiDraft)throw Error('This post has already been confirmed');if((await tx.query(`SELECT 1 FROM "PublishingIntent" WHERE "postId"=$1 LIMIT 1`,[p.id])).rows.length||(await tx.query(`SELECT 1 FROM "PublishingJob" WHERE "postId"=$1 LIMIT 1`,[p.id])).rows.length||['PUBLISHING','FAILED','PUBLISHED'].some(status=>[p.publishStatus,p.instagramPublishStatus,p.tikTokPublishStatus].includes(status))||await busy(tx,p.id)||(await tx.query(`SELECT 1 FROM "PublishingExternalAttempt" a JOIN "PublishingJob" j ON j.id=a."jobId" WHERE j."postId"=$1 LIMIT 1`,[p.id])).rows.length||p.publishWorkerStartedAt||p.tikTokInitStartedAt||p.tikTokPublishId||p.platformPostId||p.instagramMediaId){await retainPost(tx,p,input.actor,input.operationId,'USER_DELETE');continue;}if(p.approvalStatus==='APPROVED')throw Error('APPROVED_CONTENT_LOCKED');if(p.publishWorkerStartedAt||p.tikTokInitStartedAt||p.tikTokPublishId||p.platformPostId||p.instagramMediaId||await busy(tx,p.id))throw Error('UNRESOLVED_PUBLICATION_RETAINED');await invalidate(tx,p,input.actor,policyHash({operationId:input.operationId,postId:p.id,action:'delete'}).slice(0,40));
    if(!input.draftOnly)cleanupKeys.push(...(await tx.query(`SELECT "fileKey" FROM "CalendarPostAsset" WHERE "postId"=$1 ORDER BY id`,[p.id])).rows.map(row=>row.fileKey));
    // No publication attempt exists in this path. Preserve identity/audits;
    // physical objects remain for shared-reference-aware storage cleanup.
    await tx.query(`INSERT INTO "PublishingResourceTombstone"("resourceType","resourceId","evidenceHash","retentionUntil",actor,"operationId") VALUES('POST',$1,$2,clock_timestamp(),$3,$4) ON CONFLICT DO NOTHING`,[p.id,policyHash({postId:p.id}),input.actor,input.operationId]);
    await tx.query(`DELETE FROM "CalendarPost" WHERE id=$1`,[p.id]);
   }if(cleanupKeys.length)await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[input.operationId+'-cleanup-plan',input.actor,policyHash(input),{keys:[...new Set(cleanupKeys)],entrypoint:'canonical-planning-post-delete'}]);return {ok:true,deletedCount:posts.length};
  });
 }
 async function acceptInvitation(input:{operationId:string;actor:string;token:string}){
  await deps.database.transaction(async tx=>{const actor=(await tx.query(`SELECT "isDeactivated" FROM "Creator" WHERE id=$1`,[input.actor])).rows[0];if(!actor||actor.isDeactivated)throw Error('ACTOR_DEACTIVATED');});
  const tokenHash=policyHash(input.token); // Native inviteHash hashes raw UTF-8, not JSON.
  const hash=createHash('sha256').update(input.token).digest('hex');
  return replay(input.operationId,input.actor,{actor:input.actor,tokenHash},async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);
   const actor=(await tx.query(`SELECT id,email,"isDeactivated" FROM "Creator" WHERE id=$1`,[input.actor])).rows[0];if(!actor||actor.isDeactivated)throw Error('ACTOR_DEACTIVATED');
   const invite=(await tx.query(`SELECT *,"expiresAt">clock_timestamp() AS live FROM "CalendarInvite" WHERE "tokenHash"=$1 FOR UPDATE`,[hash])).rows[0];if(!invite)throw Error('Invitation not found');if(actor.email.trim().toLowerCase()!==invite.email.trim().toLowerCase())throw Error('Sign in with the email address this invitation was sent to');
   const calendar=(await tx.query(`SELECT "managerId" FROM "SocialCalendar" WHERE id=$1`,[invite.calendarId])).rows[0];if(!calendar||actor.id===calendar.managerId)throw Error('The owner already has full access');
   const member=(await tx.query(`SELECT id FROM "CalendarCollaborator" WHERE "calendarId"=$1 AND "creatorId"=$2`,[invite.calendarId,actor.id])).rows[0];if(invite.status==='ACCEPTED'&&member)return {ok:true,alreadyMember:true,calendarId:invite.calendarId};
   if(invite.status!=='PENDING'||!invite.live)throw Error('This invitation is no longer active');
   // Revalidate the recorded inviter, not the accepting viewer's claimed role.
   await v.validateWorkspacePermission(tx,{actor:invite.invitedByCreatorId,calendarId:invite.calendarId,permission:'people.manage'});
   const scoped={transaction:<T>(fn:(t:OwnershipTransaction)=>Promise<T>)=>fn(tx)},actions=createCanonicalApplicationActions({...deps,database:scoped});
   if(!member)await actions.membership({operationId:input.operationId+'-membership',actor:invite.invitedByCreatorId,calendarId:invite.calendarId,memberId:actor.id,assignment:{role:invite.role,permissions:invite.permissions,customPermissions:invite.customPermissions}});
   await tx.query(`UPDATE "CalendarInvite" SET status='ACCEPTED',"respondedAt"=clock_timestamp() WHERE id=$1`,[invite.id]);return {ok:true,calendarId:invite.calendarId};
  });
 }
 async function deactivate(input:{operationId:string;actor:string}){return replay(input.operationId,input.actor,input,async tx=>{
  await services(tx).v.lockForPolicyChange(tx);const actor=(await tx.query(`SELECT id FROM "Creator" WHERE id=$1`,[input.actor])).rows[0];if(!actor)throw Error('CREATOR_MISSING');await tx.query(`UPDATE "Creator" SET "isDeactivated"=true WHERE id=$1`,[input.actor]);return {ok:true};
 });}
 async function workspaceDetails(input:{operationId:string;actor:string;calendarId:string;action:string;clientName?:unknown;password?:unknown}){
  await permission(input.actor,input.calendarId,'workspace.manage');
  if(!['update_details','set_password','regenerate_password'].includes(input.action))throw Error('INVALID_WORKSPACE_ACTION');
  if(input.action==='update_details'&&(typeof input.clientName!=='string'||!input.clientName.trim()))throw Error('INVALID_CLIENT_NAME');
  if(input.action==='set_password'&&(typeof input.password!=='string'||!input.password))throw Error('INVALID_VIEWER_PASSWORD');
  if(input.action!=='update_details'&&!deps.hashViewerPassword)throw Error('VIEWER_PASSWORD_SERVICE_REQUIRED');
  return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'workspace.manage'});
   const alphabet='ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
   const password=input.action==='regenerate_password'?Array.from({length:10},()=>alphabet[randomInt(alphabet.length)]).join(''):input.password as string;
   const row=input.action==='update_details'?(await tx.query(`UPDATE "SocialCalendar" SET "clientName"=$2,"updatedAt"=clock_timestamp() WHERE id=$1 RETURNING *`,[input.calendarId,(input.clientName as string).trim()])).rows[0]:(await tx.query(`UPDATE "SocialCalendar" SET "passwordHash"=$2,"accessCode"=$3,"updatedAt"=clock_timestamp() WHERE id=$1 RETURNING *`,[input.calendarId,await deps.hashViewerPassword!(password),password])).rows[0];
   if(!row)throw Error('Calendar not found');return {calendar:JSON.parse(JSON.stringify(row,(_key,value)=>typeof value==='bigint'?Number(value):value)),...(input.action!=='update_details'?{newPassword:password}:{})};
  });
 }
 async function resetCalendar(input:{operationId:string;actor:string;calendarId:string;confirmation:unknown}){
  if(input.confirmation!=='RESET')throw Error('INVALID_RESET_CONFIRMATION');await permission(input.actor,input.calendarId,'workspace.manage');
  return replay(input.operationId,input.actor,input,async tx=>{
   const {v}=services(tx);await v.lockForPolicyChange(tx);await v.validateWorkspacePermission(tx,{actor:input.actor,calendarId:input.calendarId,permission:'workspace.manage'});
   const calendar=(await tx.query(`SELECT "managerId" FROM "SocialCalendar" WHERE id=$1`,[input.calendarId])).rows[0];if(calendar?.managerId!==input.actor)throw Error('PERMISSION_DENIED');
   const posts=(await tx.query(`SELECT * FROM "CalendarPost" p WHERE "calendarId"=$1 AND NOT EXISTS(SELECT 1 FROM "PublishingResourceTombstone" t WHERE t."resourceType"='POST' AND t."resourceId"=p.id) ORDER BY id`,[input.calendarId])).rows;
   for(const p of posts)await retainPost(tx,p,input.actor,input.operationId,'USER_RESET');
   await tx.query(`DELETE FROM "CalendarImport" WHERE "calendarId"=$1`,[input.calendarId]);
   await tx.query(`UPDATE "SocialCalendar" SET "planStatus"='BUILDING',"planSubmittedAt"=NULL,"planApprovedAt"=NULL,"planApprovalNote"=NULL,"updatedAt"=clock_timestamp() WHERE id=$1`,[input.calendarId]);
   // Physical objects and charged storage are retained until shared-reference
   // and evidence-aware cleanup completes; reset never erases provider history.
   return {ok:true,deletedCount:posts.length};
  });
 }
 return {publishing,createPost,createBatch,changeContent,review,tikTok,media,account,membership,membershipById,billing,erase,metadata,postView,resubmit,importPosts,restoreDraft,plan,generate,bindVerifiedAccount,regenerate,creatorMetadata,listPosts,deletePlanningPosts,acceptInvitation,deactivate,workspaceDetails,resetCalendar,eraseCreator,eraseAdminCreator};
}
