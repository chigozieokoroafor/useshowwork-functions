import {policyHash} from './eligibilityPolicy';
import {legacyProjection} from './canonicalContract';
import type {OwnershipDatabase} from './ownership';
import type {PublicationTarget} from './externalAuthorization';
import type {createPublishingValidationAdapters} from './validationAdapters';
/** UI projection only; a result/status is never permission to send. */
export function createCanonicalStatusProjection(deps:{database:OwnershipDatabase;validation:ReturnType<typeof createPublishingValidationAdapters>}){
 const project=async(target:PublicationTarget)=>deps.database.transaction(async tx=>{
  await deps.validation.lockForPolicyChange(tx);
  const j=(await tx.query(`SELECT j.*,i.state AS "intentState",i."currentRevision" FROM "PublishingJob" j JOIN "PublishingIntent" i ON i.id=j."intentId" WHERE j.id=$1`,[target.jobId])).rows[0];
  if(!j||j.intentRevision!==j.currentRevision)return {projected:false,maySend:false};
  const field=j.platform==='INSTAGRAM'?'instagramPublishStatus':j.platform==='TIKTOK'?'tikTokPublishStatus':'publishStatus';
  const installed=(await tx.query(`SELECT to_regclass('"PublishingEligibilityHold"') IS NOT NULL AS present`)).rows[0].present;
  const invalid=(await tx.query(`SELECT 1 FROM "PublishingPostEligibilityInvalidation" WHERE "intentId"=$1 AND revision=$2`,[j.intentId,j.intentRevision])).rows.length>0||installed&&(await tx.query(`SELECT 1 FROM "PublishingEligibilityHold" WHERE "intentId"=$1 AND revision=$2`,[j.intentId,j.intentRevision])).rows.length>0;
  const status=invalid&&['READY','PREPARED','CANCELLED'].includes(j.phase)?'NOT_SCHEDULED':legacyProjection(j.phase);
  const updated=(await tx.query(`UPDATE "CalendarPost" SET "${field}"=$2 WHERE id=$1 AND platform=$3 RETURNING to_jsonb("CalendarPost") AS fields`,[j.postId,status,j.platform])).rows[0];
  if(!updated)return {projected:false,maySend:false};
  if(j.remoteId){const referenceField=j.platform==='INSTAGRAM'?'instagramMediaId':j.platform==='TIKTOK'?'tikTokPublishId':'platformPostId';if(referenceField in updated.fields)await tx.query(`UPDATE "CalendarPost" SET "${referenceField}"=$2 WHERE id=$1`,[j.postId,j.remoteId]);}
  if(j.phase==='CONFIRMED'){
   const rows=(await tx.query(`SELECT "publicationReferences",permalink FROM "PublishingProviderJournal" WHERE "jobId"=$1 ORDER BY "createdAt" DESC,id DESC`,[j.id])).rows;
   const refs=rows.find(r=>r.publicationReferences?.length)?.publicationReferences,knownLink=rows.find(r=>r.permalink)?.permalink;
   if(j.platform==='TIKTOK'&&refs?.[0]&&'platformPostId'in updated.fields)await tx.query(`UPDATE "CalendarPost" SET "platformPostId"=$2 WHERE id=$1`,[j.postId,refs[0]]);
   const publishedField=j.platform==='INSTAGRAM'?'instagramPublishedAt':j.platform==='TIKTOK'?'tikTokPublishedAt':'publishedAt';
   if(publishedField in updated.fields)await tx.query(`UPDATE "CalendarPost" SET "${publishedField}"=COALESCE("${publishedField}",clock_timestamp()) WHERE id=$1`,[j.postId]);
   const link=knownLink??(j.remoteId?j.platform==='X'?`https://x.com/i/web/status/${encodeURIComponent(j.remoteId)}`:j.platform==='FACEBOOK'?`https://www.facebook.com/${encodeURIComponent(j.remoteId)}`:j.platform==='LINKEDIN'?`https://www.linkedin.com/feed/update/${encodeURIComponent(j.remoteId)}`:null:null),linkField=j.platform==='INSTAGRAM'?'instagramPermalink':'publishPermalink';
   if(link&&linkField in updated.fields)await tx.query(`UPDATE "CalendarPost" SET "${linkField}"=$2 WHERE id=$1`,[j.postId,link]);
  }return {projected:true,maySend:false};
 });
 return async(target:PublicationTarget)=>{
  const result=await project(target);
  // Reporting is optional follow-up. A reporting error cannot roll back the UI
  // projection or turn a confirmed publication into another send opportunity.
  try{return {...result,reporting:await projectCanonicalPublishedRecord(deps.database,target)};}
  catch{return {...result,reportingPending:true};}
 };
}
async function projectCanonicalPublishedRecord(database:OwnershipDatabase,target:PublicationTarget){
 return database.transaction(async tx=>{
  if(!(await tx.query(`SELECT to_regclass('"PublishedSocialPost"') IS NOT NULL AS present`)).rows[0].present)return {reported:false};
  const row=(await tx.query(`SELECT j."postId",j."remoteId",p."calendarId",p."postType",p."publishPermalink",p."instagramPermalink",COALESCE(p."instagramPublishedAt",p."tikTokPublishedAt",p."publishedAt") AS "publishedAt" FROM "PublishingJob" j JOIN "CalendarPost" p ON p.id=j."postId" JOIN "PublishingSendCapability" c ON c."jobId"=j.id JOIN "PublishingAccountVersion" v ON v."bindingId"=c."accountBindingId" AND v.version=c."accountVersion" JOIN "SocialConnection" s ON s.id=v."connectionId" WHERE j.id=$1 AND j.phase='CONFIRMED' AND c.state='CONSUMED' AND c."intentId"=$2 AND c.revision=$3 AND c.generation=$4 AND c.platform=$5 AND c."contentHash"=$6 AND c."accountBindingId"=$7 AND c."accountVersion"=$8 AND s.id=$9 AND s."platformAccountId"=$10`,[target.jobId,target.intentId,target.revision,target.generation,target.platform,target.contentHash,target.accountBindingId,target.accountVersion,target.connectionId,target.providerAccountId])).rows[0];
  if(!row)return {reported:false};
  if((await tx.query(`SELECT 1 FROM "PublishingResourceTombstone" WHERE ("resourceType"='POST' AND "resourceId"=$1) OR ("resourceType"='WORKSPACE' AND "resourceId"=$2)`,[row.postId,row.calendarId])).rows.length)return {reported:false,reason:'RETIRED_CONTENT'};
  const refs=(await tx.query(`SELECT "publicationReferences" FROM "PublishingProviderJournal" WHERE "jobId"=$1 AND "publicationReferences" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1`,[target.jobId])).rows[0]?.publicationReferences;
  const platformPostId=target.platform==='TIKTOK'?refs?.[0]??null:row.remoteId;
  const id=policyHash({jobId:target.jobId,connectionId:target.connectionId});
  const written=(await tx.query(`INSERT INTO "PublishedSocialPost"(id,"calendarId","calendarPostId","socialConnectionId",platform,"platformPostId","providerReference",permalink,status,"publishedAt","platformPostType","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PUBLISHED',COALESCE($9,clock_timestamp()),$10,clock_timestamp()) ON CONFLICT("calendarPostId","socialConnectionId") DO UPDATE SET "platformPostId"=COALESCE("PublishedSocialPost"."platformPostId",EXCLUDED."platformPostId"),"providerReference"=COALESCE("PublishedSocialPost"."providerReference",EXCLUDED."providerReference"),permalink=COALESCE("PublishedSocialPost".permalink,EXCLUDED.permalink),"publishedAt"=COALESCE("PublishedSocialPost"."publishedAt",EXCLUDED."publishedAt"),"updatedAt"=clock_timestamp(),status='PUBLISHED',"platformPostType"=COALESCE("PublishedSocialPost"."platformPostType",EXCLUDED."platformPostType") WHERE ("PublishedSocialPost"."platformPostId" IS NULL OR EXCLUDED."platformPostId" IS NULL OR "PublishedSocialPost"."platformPostId"=EXCLUDED."platformPostId") AND ("PublishedSocialPost"."providerReference" IS NULL OR "PublishedSocialPost"."providerReference"=EXCLUDED."providerReference") RETURNING id`,[id,row.calendarId,row.postId,target.connectionId,target.platform,platformPostId,row.remoteId,target.platform==='INSTAGRAM'?row.instagramPermalink:row.publishPermalink,row.publishedAt,row.postType])).rows;
  return {reported:written.length===1,...(!written.length?{reason:'HISTORICAL_REPORTING_CONFLICT'}:{})};
 });
}
