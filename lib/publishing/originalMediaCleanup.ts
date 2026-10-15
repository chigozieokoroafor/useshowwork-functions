import {policyHash} from './eligibilityPolicy';
import type {OwnershipDatabase} from './ownership';
/** Original files only. Publishing snapshots/journals are never purge candidates. */
export function createOriginalMediaCleanup(deps:{database:OwnershipDatabase;
 storage:{originalVersion(key:string):Promise<string|null>;deleteOriginalVersion(key:string,version:string):Promise<void>};
}){
 return async(operationId:string)=>{
  const plan=await deps.database.transaction(async tx=>(await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[operationId+'-cleanup-plan'])).rows[0]);
  if(!plan)return {deleted:0,retained:0,pending:0};
  if(!Array.isArray(plan.result.keys)||plan.result.keys.length>1000)throw Error('INVALID_MEDIA_CLEANUP_PLAN');
  let deleted=0,retained=0,pending=0;
  for(const key of plan.result.keys as string[]){
   if(typeof key!=='string'||key.startsWith('publishing/')||key.length>1024){retained++;continue;}
   const decision=await deps.database.transaction(async tx=>{
    await tx.query(`SELECT version FROM "PublishingEligibilityFence" WHERE id=1 FOR UPDATE`);
    const published=(await tx.query(`SELECT 1 FROM "CalendarPostAsset" WHERE "fileKey"=$1 UNION ALL SELECT 1 FROM "PublishingMediaSnapshot" WHERE "sourceKey"=$1 OR "blobKey"=$1 LIMIT 1`,[key])).rows.length;
    if(published)return false;
    // Sharing outside publishing must also prevent cleanup. This is evaluated
    // after the originating native transaction has committed its row deletion.
    const shared=(await tx.query(`SELECT 1 FROM "Media" WHERE "fileKey"=$1 UNION ALL SELECT 1 FROM "PortfolioMedia" WHERE "fileKey"=$1 UNION ALL SELECT 1 FROM "TaskAsset" WHERE "fileKey"=$1 UNION ALL SELECT 1 FROM "BriefAttachment" WHERE "fileKey"=$1 UNION ALL SELECT 1 FROM "CalendarBusinessDocument" WHERE "fileKey"=$1 UNION ALL SELECT 1 FROM "ContentWorkspaceStorageReservation" WHERE "fileKey"=$1 AND status='PENDING' AND "expiresAt">clock_timestamp() UNION ALL SELECT 1 FROM "Portfolio" WHERE "heroBannerDesktopUrl"=$1 OR "heroBannerMobileUrl"=$1 OR "logoUrl"=$1 UNION ALL SELECT 1 FROM "SocialCalendar" WHERE "headerBannerDesktopUrl"=$1 OR "headerBannerMobileUrl"=$1 LIMIT 1`,[key])).rows.length;
    if(shared)return false;
    await tx.query(`INSERT INTO "PublishingResourceTombstone"("resourceType","resourceId","evidenceHash","retentionUntil",actor,"operationId") VALUES('OBJECT',$1,$2,clock_timestamp(),$3,$4) ON CONFLICT DO NOTHING`,[key,policyHash({key,plan:operationId}),plan.actor,operationId]);return true;
   });
   if(!decision){retained++;continue;}
   try{
    const version=await deps.storage.originalVersion(key);
    if(version)await deps.storage.deleteOriginalVersion(key,version);
    // Conditional deletion is repeatable only for this retired original, and
    // never grants a social publication retry or deletes immutable evidence.
    if(await deps.storage.originalVersion(key)!==null)throw Error('ORIGINAL_DELETION_UNCONFIRMED');
    const receipt='original-deleted-'+policyHash({key}).slice(0,50);
    await deps.database.transaction(async tx=>{await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[receipt,plan.actor,policyHash(key),{key,absent:true}]);});deleted++;
   }catch{pending++;}
  }
  return {deleted,retained,pending};
 };
}
