'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID}=require('node:crypto'),{performance}=require('node:perf_hooks');
const {startCluster}=require('../../tests/helpers/isolated-postgres.cjs'),{startPooler}=require('../../tests/helpers/isolated-pooler.cjs'),{installFullSchema,fixtures}=require('../../tests/helpers/full-publishing-stage.cjs'),{load}=require('../../tests/helpers/load-typescript.cjs');
let cluster,pooler,release;const result={productionAccess:false,realPublishing:false,hostedMeasurement:false};
async function main(){
 cluster=await startCluster();await installFullSchema(cluster);await fixtures(cluster.stage,5);pooler=await startPooler(cluster,{nativePublishing:true});await cluster.stage.$disconnect();
 const {createReliablePublishingStore}=load('lib/publishing/reliableStore.ts'),root=createReliablePublishingStore(pooler.db);const job=(await root.admit(undefined,'INSTAGRAM',randomUUID(),new Date(),1))[0];let entered;const locked=new Promise(r=>entered=r),hold=new Promise(r=>release=r),client=pooler.client();
 const first=client.$transaction(async tx=>{await tx.$queryRawUnsafe('SELECT id FROM "PublishingJob" WHERE id=$1 FOR UPDATE',job.id);entered();await hold;});await locked;
 const started=performance.now();const second=await root.prepareMany([{id:job.id,token:'second-private-token'}]);result.skippedLockedClaimMs=performance.now()-started;assert.equal(second.length,0);assert.ok(result.skippedLockedClaimMs<1000);release();await first;assert.equal((await root.prepareMany([{id:job.id,token:'first-private-token'}])).length,1);assert.equal((await root.findJob(job.id)).workerToken,'first-private-token');result.success=true;
}
process.on('SIGTERM',()=>{release?.();});
main().catch(e=>{release?.();result.success=false;result.failure={code:e.code||e.name,message:e.message};process.exitCode=1;}).finally(async()=>{await pooler?.close();await cluster?.close();result.clusterRemoved=cluster?!fs.existsSync(cluster.directory):false;const file='/tmp/showwork-claim-contention-'+randomUUID()+'.json';fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,file}));});
