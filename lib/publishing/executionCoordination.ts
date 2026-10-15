/** Database-backed account mutex, bounded rates and refresh reservation. */
import { randomUUID } from 'node:crypto';
import type { OwnershipDatabase } from './ownership';
import type { PublicationTarget } from './externalAuthorization';
import type { createPublishingValidationAdapters } from './validationAdapters';
export function createPublishingCoordination(deps:{database:OwnershipDatabase;validation:ReturnType<typeof createPublishingValidationAdapters>}){
 // Separate read before the mutation; validation repeats exact identity in tx.
 async function claim(input:{target:PublicationTarget;workerToken:string;owner:'NETLIFY'|'VPS';epoch:bigint}){
  const job=await deps.validation.canonicalStore().findJob(input.target.jobId);
  return deps.database.transaction(async tx=>{
   const o=(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0];if(o.state!==input.owner||BigInt(o.epoch)!==input.epoch)throw Error('OWNERSHIP_FENCED');await deps.validation.validateExecution(tx,job);
   await tx.query(`SELECT id FROM "PublishingIntent" WHERE id=$1 FOR UPDATE`,[job.intentId]);
   const j=(await tx.query(`SELECT *,"workerUntil">clock_timestamp() AS live FROM "PublishingJob" WHERE id=$1 FOR UPDATE`,[job.id])).rows[0];if(j.phase!=='PREPARED'||!j.live||j.workerToken!==input.workerToken)throw Error('CLAIM_FENCED');
   const rows=(await tx.query(`INSERT INTO "PublishingAccountLease"(platform,"accountId","jobId",token,"leaseUntil") VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(platform,"accountId") DO UPDATE SET "jobId"=EXCLUDED."jobId",token=EXCLUDED.token,"leaseUntil"=EXCLUDED."leaseUntil"
    WHERE ("PublishingAccountLease".token=EXCLUDED.token OR "PublishingAccountLease"."leaseUntil"<=clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM "PublishingJob" old WHERE old.id="PublishingAccountLease"."jobId" AND old.phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN')) RETURNING token`,[job.platform,job.providerAccountId,job.id,input.workerToken,j.workerUntil])).rows;
   if(!rows.length)throw Error('ACCOUNT_EXECUTION_BUSY');return {maySend:false as const};
  });
 }
 async function release(input:{target:PublicationTarget;workerToken:string}){return deps.database.transaction(async tx=>{
  await tx.query(`DELETE FROM "PublishingAccountLease" a USING "PublishingJob" j WHERE a."jobId"=j.id AND j.id=$1 AND a.token=$2 AND j.phase IN ('PREPARED','CONFIRMED','REJECTED','CANCELLED')`,[input.target.jobId,input.workerToken]);
 });}
 async function reserveRate(key:string,max:number,windowMs:number){if(!Number.isInteger(max)||max<1||!Number.isInteger(windowMs)||windowMs<1000||key.length>500)throw Error('INVALID_RATE_BUDGET');return deps.database.transaction(async tx=>{
  const rows=(await tx.query(`INSERT INTO "PublishingRateBucket"(key,"bucketWindow",used) VALUES($1,floor(extract(epoch FROM clock_timestamp())*1000/$2)::bigint,1)
   ON CONFLICT(key,"bucketWindow") DO UPDATE SET used="PublishingRateBucket".used+1 WHERE "PublishingRateBucket".used<$3 RETURNING used`,[key,windowMs,max])).rows;if(!rows.length)throw Error('PUBLISHING_RATE_DEFERRED');
 });}
 async function reserveRefresh(key:string){const token=randomUUID();const rows=await deps.database.transaction(async tx=>(await tx.query(`INSERT INTO "PublishingCoordinationLease"(key,token,"leaseUntil") VALUES($1,$2,clock_timestamp()+interval '30 seconds') ON CONFLICT(key) DO UPDATE SET token=EXCLUDED.token,"leaseUntil"=EXCLUDED."leaseUntil" WHERE "PublishingCoordinationLease"."leaseUntil"<=clock_timestamp() RETURNING token`,[key,token])).rows);if(!rows.length)throw Error('TOKEN_REFRESH_BUSY');return token;}
 async function reserveSpacing(key:string,intervalMs:number){if(!Number.isInteger(intervalMs)||intervalMs<1||intervalMs>60000)throw Error('INVALID_REQUEST_SPACING');
  const wait=await deps.database.transaction(async tx=>{const r=(await tx.query(`INSERT INTO "PublishingRequestSpacing"(key,"nextAt") VALUES($1,clock_timestamp()+$2*interval '1 millisecond') ON CONFLICT(key) DO UPDATE SET "nextAt"=GREATEST("PublishingRequestSpacing"."nextAt",clock_timestamp())+$2*interval '1 millisecond' RETURNING GREATEST(0,ceil(extract(epoch FROM ("nextAt"-clock_timestamp()))*1000)-$2)::integer AS wait`,[key,intervalMs])).rows[0];if(r.wait>15000)throw Error('PUBLISHING_RATE_DEFERRED');return r.wait;});
  if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
 }
 return {acquire:claim,release,reserveRate,reserveRefresh,reserveSpacing};
}
