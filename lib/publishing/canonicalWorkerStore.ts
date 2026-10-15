/** Inactive Stage 4C.5: discovery/claims using C1; never a send-authority store. */
import { randomUUID } from 'node:crypto';
import { policyHash } from './eligibilityPolicy';
import type { OwnershipDatabase } from './ownership';
import type { CanonicalJob } from './canonicalContract';
import type { PublicationTarget } from './externalAuthorization';
import type { createPublishingValidationAdapters } from './validationAdapters';
export function canonicalPublicationTarget(job:CanonicalJob):PublicationTarget {
 return {jobId:job.id,intentId:job.intentId,revision:job.revision,generation:job.generation,platform:job.platform,
  accountBindingId:job.accountBindingId,accountVersion:job.accountVersion,providerAccountId:job.providerAccountId,
  connectionId:job.connectionId,contentHash:job.contentHash};
}
export function createCanonicalWorkerStore(deps:{database:OwnershipDatabase;validation:Pick<ReturnType<typeof createPublishingValidationAdapters>,'canonicalStore'>;
 actor:string;owner:'NETLIFY'|'VPS';epoch:bigint;preparedLeaseMs?:number}) {
 const canonical=deps.validation.canonicalStore(deps.preparedLeaseMs===undefined?undefined:{preparedLeaseMs:deps.preparedLeaseMs});
 if(!/^[a-zA-Z0-9_-]{1,120}$/.test(deps.actor)||!['NETLIFY','VPS'].includes(deps.owner)||typeof deps.epoch!=='bigint'||deps.epoch<=BigInt(0))throw Error('INVALID_WORKER_IDENTITY');
 // Copy configuration: an injected caller cannot retarget a running worker.
 const actor=deps.actor,owner=deps.owner,epoch=deps.epoch;
 function exact(job:CanonicalJob,target:PublicationTarget){if(policyHash(canonicalPublicationTarget(job))!==policyHash(target))throw Error('WORKER_PUBLICATION_IDENTITY_CONFLICT');}
 async function inspect(target:PublicationTarget){const job=await canonical.findJob(target.jobId);exact(job,target);return job;}
 async function poll(limit:number){
  if(!Number.isInteger(limit)||limit<1||limit>5)throw Error('INVALID_WORKER_POLL_LIMIT');
  const ids=await deps.database.transaction(async tx=>{
   const o=(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0];
   const enabled=o?.enabled&&o.state===owner&&BigInt(o.epoch)===epoch;
   const extensions=(await tx.query(`SELECT to_regclass('"PublishingEligibilityHold"') IS NOT NULL AS holds,to_regclass('"PublishingResourceTombstone"') IS NOT NULL AS retired`)).rows[0];
   const ready=enabled?(await tx.query(`SELECT j.id FROM "PublishingJob" j JOIN "PublishingCanonicalRevision" b ON b."jobId"=j.id
    JOIN "PublishingIntent" i ON i.id=j."intentId" JOIN "PublishingIntentRevision" r ON r."intentId"=i.id AND r.revision=j."intentRevision"
    WHERE i.state='ACTIVE' AND i."currentRevision"=j."intentRevision" AND r."dueAt"<=clock_timestamp() AND j."availableAt"<=clock_timestamp()
    AND (j.phase='READY' OR j.phase='PREPARED' AND j."workerUntil"<=clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM "PublishingRevisionInvalidation" WHERE "intentId"=i.id AND revision=j."intentRevision")
    AND NOT EXISTS(SELECT 1 FROM "PublishingSendCapability" WHERE "jobId"=j.id)
    AND NOT EXISTS(SELECT 1 FROM "PublishingPostEligibilityInvalidation" v WHERE v."intentId"=i.id AND v.revision=j."intentRevision")
    ${extensions.holds?`AND NOT EXISTS(SELECT 1 FROM "PublishingEligibilityHold" h WHERE h."intentId"=i.id AND h.revision=j."intentRevision")`:''}
    ${extensions.retired?`AND NOT EXISTS(SELECT 1 FROM "PublishingResourceTombstone" t JOIN "CalendarPost" p ON p.id=j."postId" JOIN "SocialCalendar" c ON c.id=p."calendarId" WHERE (t."resourceType"='POST' AND t."resourceId"=p.id) OR (t."resourceType"='WORKSPACE' AND t."resourceId"=c.id) OR (t."resourceType"='CREATOR' AND t."resourceId"=c."managerId"))`:''}
    ORDER BY j."availableAt",j.id LIMIT $1`,[limit])).rows:[];
   // Recovery is read-only external work. It may continue while ownership drains.
   const recovery=(await tx.query(`SELECT j.id FROM "PublishingJob" j JOIN "PublishingSendCapability" c ON c."jobId"=j.id
    WHERE j.phase IN ('PROVIDER_PENDING','OUTCOME_UNKNOWN') OR j.phase='EXTERNAL_PENDING' AND j."workerUntil"<=clock_timestamp()
    ORDER BY j."updatedAt",j.id LIMIT $1`,[limit])).rows;
   return {ready,recovery,fenced:!enabled};
  });
  const hints=async(rows:Record<string,any>[])=>Promise.all(rows.map(async r=>canonicalPublicationTarget(await canonical.findJob(r.id))));
  return {ready:await hints(ids.ready),recovery:await hints(ids.recovery),fenced:ids.fenced};
 }
 async function claim(target:PublicationTarget){
  target=Object.freeze({...target});const job=await inspect(target);
  const operation=()=>({jobId:job.id,operationId:randomUUID(),actor,owner,epoch});
  if(job.phase==='READY')await canonical.admit(operation());
  else if(job.phase!=='PREPARED')throw Error('JOB_NOT_ELIGIBLE');
  // Fresh operation IDs only. Never recover/replay a claim token after lost ACK.
  const receipt=await canonical.prepare(operation());
  if(!receipt.workerToken||policyHash(receipt.identity)!==policyHash({intentId:target.intentId,revision:target.revision,generation:target.generation}))throw Error('WORKER_CLAIM_IDENTITY_CONFLICT');
  return {target,workerToken:receipt.workerToken,actor,owner,epoch,maySend:false as const};
 }
 async function recovery(target:PublicationTarget){
  const job=await inspect(target);
  const cap=await deps.database.transaction(async tx=>(await tx.query(`SELECT c.id,c.state,j.phase,j."workerUntil"<=clock_timestamp() AS expired
   FROM "PublishingSendCapability" c JOIN "PublishingJob" j ON j.id=c."jobId" WHERE c."jobId"=$1`,[job.id])).rows[0]??null);
  return {job,cap};
 }
 async function parkUnsent(target:PublicationTarget,cause:string){
  await inspect(target); // Exact immutable identity, never a caller-selected job alias.
  return deps.database.transaction(async tx=>{
   await tx.query(`SELECT version FROM "PublishingEligibilityFence" WHERE id=1 FOR UPDATE`);
   const o=(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0];if(!o?.enabled||o.state!==owner||BigInt(o.epoch)!==epoch)return;
   const pending=(await tx.query(`SELECT j.id FROM "PublishingJob" j WHERE j.id=$1 AND j.phase IN ('READY','PREPARED') AND NOT EXISTS(SELECT 1 FROM "PublishingSendCapability" WHERE "jobId"=j.id) FOR UPDATE`,[target.jobId])).rows[0];if(!pending)return;
   const permanent=/ENTITLEMENT|APPROVAL|AI_DRAFT|DEACTIVATED|PERMISSION|ACCOUNT_BINDING|ACCOUNT_VERSION|ACCOUNT_AUTHORITY|POST_RETIRED|WORKSPACE_RETIRED/.test(cause);
   if(permanent&&(await tx.query(`SELECT to_regclass('"PublishingEligibilityHold"') IS NOT NULL AS present`)).rows[0].present){
    await tx.query(`INSERT INTO "PublishingEligibilityHold"("intentId",revision,reason) SELECT "intentId",revision,'CURRENT_POLICY_REAUTHORISATION_REQUIRED' FROM "PublishingCanonicalRevision" WHERE "jobId"=$1 ON CONFLICT DO NOTHING`,[target.jobId]);
   }else{
    // Only unattempted preparation is deferred. No attempted job is reset or
    // automatically resent; queue timing is never publication identity.
    await tx.query(`UPDATE "PublishingJob" SET "availableAt"=clock_timestamp()+interval '30 seconds' WHERE id=$1 AND (phase='READY' OR phase='PREPARED' AND "workerUntil">clock_timestamp())`,[target.jobId]);
   }
  });
 }
 return {poll,claim,inspect,recovery,parkUnsent};

}
