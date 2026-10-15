/** Optional shared three-slot data budget; never publishing authority. */
import {randomUUID} from 'node:crypto';
import type {OwnershipDatabase} from './ownership';
export function createBudgetedPublishingDatabase(database:OwnershipDatabase):OwnershipDatabase{
 return {async transaction(run){
  const token=randomUUID();const slot=await database.transaction(async tx=>{
   const r=(await tx.query(`SELECT id FROM "PublishingBudget" WHERE id<3 AND (owner IS NULL OR "leaseUntil"<=clock_timestamp()) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];if(!r)throw Error('PUBLISHING_DATABASE_BUDGET_BUSY');
   await tx.query(`UPDATE "PublishingBudget" SET owner=$2,"leaseUntil"=clock_timestamp()+interval '10 seconds' WHERE id=$1`,[r.id,token]);return r.id;
  });
  try{return await database.transaction(async tx=>{
   const lock=(await tx.query(`SELECT pg_try_advisory_xact_lock(197613, $1::integer) AS held`,[slot])).rows[0];if(!lock.held)throw Error('PUBLISHING_DATABASE_BUDGET_BUSY');
   const current=(await tx.query(`SELECT 1 FROM "PublishingBudget" WHERE id=$1 AND owner=$2 AND "leaseUntil">clock_timestamp()`,[slot,token])).rows;if(!current.length)throw Error('PUBLISHING_DATABASE_BUDGET_FENCED');return run(tx);
  });}finally{await database.transaction(tx=>tx.query(`UPDATE "PublishingBudget" SET owner=NULL,"leaseUntil"=NULL WHERE id=$1 AND owner=$2`,[slot,token])).catch(()=>{});}
 }};
}
