'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {startCluster}=require('../../tests/helpers/isolated-postgres.cjs'),{startPooler}=require('../../tests/helpers/isolated-pooler.cjs'),{installFullSchema,fixtures}=require('../../tests/helpers/full-publishing-stage.cjs'),{load}=require('../../tests/helpers/load-typescript.cjs'),{compose}=require('../../tests/helpers/native-publishing-composition.cjs'),{createMockSocialApis}=require('./mock-social-apis.cjs');
let cluster,pooler,apis,engine;const result={productionAccess:false,realPublishing:false,hostedMeasurement:false,checks:[],timeouts:[]};
async function held(table,id,action){
 let release,ready;const acquired=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const lock=cluster.stage.$transaction(async tx=>{await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id=$1 FOR UPDATE`,id);ready();await gate;},{timeout:30000});
 // Reject promptly if lock acquisition itself fails.
 await Promise.race([acquired,lock]);try{return await action();}finally{release();await lock;}
}
async function main(){
 cluster=await startCluster();await installFullSchema(cluster);await fixtures(cluster.stage,5,{prefix:'timeout'});pooler=await startPooler(cluster,{nativePublishing:true});
 const {createReliablePublishingStore}=load('lib/publishing/reliableStore.ts'),{reconcileReliableJob}=load('lib/publishing/reliableWorker.ts');const store=createReliablePublishingStore(pooler.db);
 apis=await createMockSocialApis({pendingReads:0});engine=compose(store,apis,{performance:true});
 const job=(await store.admit(undefined,'FACEBOOK',randomUUID(),new Date(),1,'timeout-2'))[0];assert.ok(job);
 await held('PublishingJob',job.id,async()=>{const start=performance.now();await assert.rejects(pooler.db.$executeRawUnsafe('UPDATE "PublishingJob" SET "availableAt"="availableAt" WHERE id=$1',job.id),e=>{result.timeouts.push({phase:'prepare',code:e.code,sqlState:e.meta?.code,durationMs:performance.now()-start});return e.code==='P2010'&&e.meta?.code==='57014';});assert.equal((await engine.worker.run(job)).state,'deferred');assert.equal(apis.attempts.size,0);});
 assert.equal((await store.findJob(job.id)).phase,'READY');result.checks.push('Actual blocked UPDATE times out; the worker skips the locked claim and leaves the durable job READY and sends no publishing request');
 assert.equal((await engine.worker.run(job)).state,'finalization-pending');assert.equal(apis.attempts.get(job.postId),1);assert.ok((await store.findJob(job.id)).confirmation);
 await held('CalendarPost',job.postId,async()=>{const start=performance.now();try{const ok=await reconcileReliableJob(store,job.id,engine.reconcile);assert.equal(ok,false);}catch(e){assert.notEqual(e.code,'ERR_ASSERTION');assert.match(e.message,/timeout|canceling statement/i);result.timeouts.push({phase:'finalization',code:e.code||e.name,sqlState:e.meta?.code,timeoutVerified:true,durationMs:performance.now()-start});}assert.ok((await store.findJob(job.id)).confirmation);assert.equal(apis.attempts.get(job.postId),1);});
 // Advance only this synthetic job's reconciliation backoff.
 await cluster.stage.$executeRawUnsafe('UPDATE "PublishingJob" SET "availableAt"=clock_timestamp() WHERE id=$1',job.id);
 assert.equal(await reconcileReliableJob(store,job.id,engine.reconcile),true);assert.equal((await store.findJob(job.id)).phase,'CONFIRMED');assert.equal(apis.attempts.get(job.postId),1);assert.equal(await pooler.db.publishedSocialPost.count(),1);
 result.checks.push('Finalization under a held post-row lock retains durable publication proof; after lock release reconciliation confirms and reports once without republishing');result.duplicateAttempts=0;result.confirmed=1;result.success=true;
}
main().catch(e=>{result.success=false;result.failure={code:e.code||e.name,message:e.message};process.exitCode=1;}).finally(async()=>{await engine?.worker.close();engine?.close();apis?.close();await pooler?.close();await cluster?.close();result.clusterRemoved=cluster?!fs.existsSync(cluster.directory):false;const file='/tmp/showwork-timeout-'+randomUUID()+'.json';fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,file}));});
