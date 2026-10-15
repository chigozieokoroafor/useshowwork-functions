import type {OwnershipDatabase} from './ownership';
/** Explicit read-only probe. Aggregate output excludes tokens, URLs and identities. */
export function createPublishingMonitoring(database:OwnershipDatabase) {
 return async()=>database.transaction(async tx=>{
  const owner=(await tx.query(`SELECT state,epoch,enabled FROM "PublishingOwnership" WHERE id=1`)).rows[0];
  const phases=(await tx.query(`SELECT phase,count(*)::integer AS count FROM "PublishingJob" GROUP BY phase ORDER BY phase`)).rows;
  const unresolved=(await tx.query(`SELECT count(*)::integer AS count,COALESCE(max(extract(epoch FROM clock_timestamp()-"updatedAt")),0)::double precision AS "oldestSeconds" FROM "PublishingJob" WHERE phase IN ('EXTERNAL_PENDING','PROVIDER_PENDING','OUTCOME_UNKNOWN')`)).rows[0];
  const withheld=(await tx.query(`SELECT count(*)::integer AS count FROM "PublishingSendCapability" WHERE state IN ('ISSUED','REVOKED')`)).rows[0];
  const holds=(await tx.query(`SELECT count(*)::integer AS count FROM "PublishingEligibilityHold"`)).rows[0];
  return {owner:owner?{state:owner.state,epoch:String(owner.epoch),enabled:owner.enabled}:null,phases,unresolved,withheldAuthorizations:withheld.count,eligibilityHolds:holds.count,maySend:false as const};
 });
}
