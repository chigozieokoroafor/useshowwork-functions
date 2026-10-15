'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startCluster}=require('../../tests/helpers/isolated-postgres.cjs'),{startPooler}=require('../../tests/helpers/isolated-pooler.cjs'),{load}=require('../../tests/helpers/load-typescript.cjs');
const {schema,fixtures}=require('../diagnostics/gateway/staging-assessment.cjs'),{createMockPlatforms}=require('./mock-platforms.cjs');
let cluster,pooler,mock,worker;const result={productionAccess:false,realPublishing:false,backendCap:5,acceleratedAdmissionMinutes:true,injectedLatencyMs:0,rounds:[]};
async function main(){cluster=await startCluster();await schema(cluster.stage);for(const sql of fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8').split(';').map(s=>s.trim()).filter(Boolean))await cluster.stage.$executeRawUnsafe(sql);pooler=await startPooler(cluster);await cluster.stage.$disconnect();const db=pooler.db;
 const {createReliablePublishingStore}=load('lib/publishing/reliableStore.ts'),{runReliableAdmission}=load('lib/publishing/reliableAdmission.ts'),{createReliableWorker}=load('lib/publishing/reliableWorker.ts'),{drainReliablePublishing}=load('lib/publishing/reliableConsumer.ts');const store=createReliablePublishingStore(db);mock=createMockPlatforms();worker=createReliableWorker(store,mock.publish,{concurrency:4});
 await fixtures(db,100,'hot-instagram','INSTAGRAM');
 for(let wave=0;wave<5;wave++){
  await fixtures(db,5,'arrivals-'+wave);await db.$executeRawUnsafe('UPDATE "PublishingLeader" SET "lastMinute"=-1');const admission=await runReliableAdmission(store);
  const consumed=await drainReliablePublishing(store,worker,{durationMs:1500,rotation:wave});const confirmations=await db.$queryRawUnsafe(`SELECT platform,count(*)::int AS n FROM "PublishingJob" WHERE phase='CONFIRMED' GROUP BY platform`);const counts=Object.fromEntries(confirmations.map(r=>[r.platform,r.n]));
  for(const platform of ['TIKTOK','FACEBOOK','LINKEDIN','X'])assert.equal(counts[platform],wave+1);result.rounds.push({wave,admissionMs:admission.durationMs,consumerMs:consumed.durationMs,opportunities:consumed.opportunities,confirmed:counts});
 }
 result.duplicateAttempts=[...mock.attempts.values()].reduce((n,v)=>n+Math.max(0,v-1),0);assert.equal(result.duplicateAttempts,0);result.success=true;
}
main().catch(e=>{result.success=false;result.failure={code:e.code||e.name,message:'FAIRNESS_CHECK_FAILED'};process.exitCode=1;}).finally(async()=>{await worker?.close();mock?.close();await pooler?.close();await cluster?.close();fs.writeFileSync('/tmp/showwork-consumer-fairness.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));});
