'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID}=require('node:crypto');
const {startCluster}=require('../../tests/helpers/isolated-postgres.cjs'),{startPooler}=require('../../tests/helpers/isolated-pooler.cjs'),{installFullSchema,fixtures}=require('../../tests/helpers/full-publishing-stage.cjs'),{load}=require('../../tests/helpers/load-typescript.cjs');
let cluster,pooler,worker;const result={productionAccess:false,realPublishing:false,hostedMeasurement:false};
async function main(){
 cluster=await startCluster();await installFullSchema(cluster);await fixtures(cluster.stage,5);pooler=await startPooler(cluster,{nativePublishing:true});await cluster.stage.$disconnect();
 const {createReliablePublishingStore}=load('lib/publishing/reliableStore.ts'),{createReliableWorker}=load('lib/publishing/reliableWorker.ts');const root=createReliablePublishingStore(pooler.db),lease=await root.acquireConsumer(randomUUID());
 const job=(await root.admit(undefined,'INSTAGRAM',randomUUID(),new Date(),1))[0];let attempts=0;
 worker=createReliableWorker({...root,prepare:(j,t)=>root.prepare(j,t,lease),reject:async()=>{throw Object.assign(Error('Synthetic rejection write unavailable'),{code:'P1017'});}},async()=>{attempts++;return 'never';},{preflight:async()=>{throw Object.assign(Error('Synthetic temporary read failure'),{code:'P1017'});}});
 assert.equal((await worker.run(job)).state,'deferred');assert.equal(attempts,0);assert.equal(await root.consumerValid(lease),true);assert.ok((await root.ready('INSTAGRAM',5)).some(j=>j.id===job.id));
 const reclaimed=await root.prepare(job,'new-private-token',lease);assert.equal(reclaimed.length,1);
 await root.releasePrepared(job.id,'stale-token');assert.equal((await root.ready('INSTAGRAM',5)).some(j=>j.id===job.id),false);
 assert.equal((await root.beginExternal(job,'new-private-token',lease)).length,1);await root.releasePrepared(job.id,'new-private-token');assert.equal((await root.findJob(job.id)).phase,'EXTERNAL_PENDING');assert.equal((await root.ready('INSTAGRAM',5)).some(j=>j.id===job.id),false);
 const retryJob=(await root.admit(undefined,'FACEBOOK',randomUUID(),new Date(),1))[0];assert.equal((await root.prepare(retryJob,'retry-owner')).length,1);
 await pooler.db.$transaction(async tx=>{const p=await tx.calendarPost.update({where:{id:retryJob.postId},data:{publishStatus:'FAILED',publishError:'Synthetic temporary capacity failure'}});await tx.$executeRawUnsafe('UPDATE "PublishingJob" SET lease=$1 WHERE id=$2',p.updatedAt,retryJob.id);});
 await pooler.db.$executeRawUnsafe(`UPDATE "PublishingBudget" SET owner='synthetic-busy',"leaseUntil"=clock_timestamp()+interval '30 seconds' WHERE id<3`);
 assert.equal((await root.reject(retryJob,'retry-owner','Synthetic temporary capacity failure',true)).length,1);assert.equal((await root.findJob(retryJob.id)).phase,'READY');assert.equal((await pooler.db.calendarPost.findUnique({where:{id:retryJob.postId}})).publishStatus,'PUBLISHING');
 await pooler.db.$executeRawUnsafe('UPDATE "PublishingBudget" SET owner=NULL,"leaseUntil"=NULL');
 result.checks=['Temporary pre-send read and rejection-write failure remains recoverable while the consumer lease is live','Stale actor cannot release a replacement token','Committed external boundary cannot be requeued by prepared cleanup','Native temporary FAILED status becomes durable READY/PUBLISHING even when all three heavy slots are busy'];result.success=true;await root.releaseConsumer(lease);
}
main().catch(e=>{result.success=false;result.failure={code:e.code||e.name,message:e.message,stack:e.stack};process.exitCode=1;}).finally(async()=>{await worker?.close();await pooler?.close();await cluster?.close();result.clusterRemoved=cluster?!fs.existsSync(cluster.directory):false;const file='/tmp/showwork-prepared-recovery-'+randomUUID()+'.json';fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,file}));});
