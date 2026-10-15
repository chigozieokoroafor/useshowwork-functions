import type { OwnershipDatabase } from './ownership';
import type { PublicationTarget } from './externalAuthorization';
import type { createPublishingValidationAdapters } from './validationAdapters';
export function createImmutablePublishingMedia(deps:{database:OwnershipDatabase;validation:ReturnType<typeof createPublishingValidationAdapters>;
 materialize(input:{jobId:string;assetId:string;sourceKey:string;objectVersion:string;contentSha256:string}):Promise<{blobKey:string;objectVersion:string;contentSha256:string}>}){
 async function snapshot(target:PublicationTarget){
  const job=await deps.validation.canonicalStore().findJob(target.jobId);
  const assets=await deps.database.transaction(async tx=>{await deps.validation.validateExecution(tx,job);return (await tx.query(`SELECT * FROM "CalendarPostAsset" WHERE "postId"=$1 ORDER BY "displayOrder",id`,[job.postId])).rows;});
  for(const asset of assets){if(!asset.objectVersion||!/^[a-f0-9]{64}$/.test(asset.contentSha256??''))throw Error('VERIFIED_MEDIA_VERSION_REQUIRED');
   const old=await deps.database.transaction(async tx=>(await tx.query(`SELECT * FROM "PublishingMediaSnapshot" WHERE "jobId"=$1 AND "assetId"=$2`,[job.id,asset.id])).rows[0]);if(old)continue;
   const copy=await deps.materialize({jobId:job.id,assetId:asset.id,sourceKey:asset.fileKey,objectVersion:asset.objectVersion,contentSha256:asset.contentSha256});
   if(copy.objectVersion!==asset.objectVersion||copy.contentSha256!==asset.contentSha256||!copy.blobKey.startsWith(`publishing/${job.id}/`))throw Error('IMMUTABLE_MEDIA_COPY_CONFLICT');
   await deps.database.transaction(async tx=>{await deps.validation.validateExecution(tx,job);await tx.query(`INSERT INTO "PublishingMediaSnapshot"("jobId","assetId","sourceKey","objectVersion","contentSha256","blobKey") VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[job.id,asset.id,asset.fileKey,copy.objectVersion,copy.contentSha256,copy.blobKey]);});
  }
 }
 async function pinnedAssets(target:PublicationTarget,assets:readonly Record<string,unknown>[]){return deps.database.transaction(async tx=>{
  const pins=(await tx.query(`SELECT * FROM "PublishingMediaSnapshot" WHERE "jobId"=$1`,[target.jobId])).rows;
  return assets.map(a=>{const p=pins.find(p=>p.assetId===a.id);if(!p||p.sourceKey!==a.fileKey||p.objectVersion!==a.objectVersion||p.contentSha256!==a.contentSha256)throw Error('IMMUTABLE_MEDIA_PIN_MISSING');return {...a,fileKey:p.blobKey};});
 });}
 return {snapshot,pinnedAssets};
}
