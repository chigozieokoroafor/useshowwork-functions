'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const {startCluster}=require('../../tests/helpers/isolated-postgres.cjs'),{startPooler}=require('../../tests/helpers/isolated-pooler.cjs'),{load}=require('../../tests/helpers/load-typescript.cjs');
const {schema,fixtures}=require('../diagnostics/gateway/staging-assessment.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const native=process.argv.includes('--native');
const assessmentController=new AbortController();let interrupted=false;
const warm=process.argv.includes('--warm-latency');
const smoke=process.argv.includes('--smoke'),count=smoke?10:250,latency=smoke?0:warm?1380:1923,controlLatency=smoke?0:320;
const result={productionAccess:false,realPublishing:false,hostedMeasurement:false,nativePayloadHelpers:native,budgetProtocol:'pre-transaction-reservation',count,globalDataBudget:3,injectedDataTransactionMs:latency,injectedControlTransactionMs:controlLatency,backendCap:5,errors:[],dataPeak:0,transactionPeak:0,backendPeak:0,measurements:[],providerAttempts:0,duplicateAttempts:0};let cluster,pooler,monitor,progress,mockPlatforms;
async function main(){
 cluster=await startCluster();await schema(cluster.stage);for(const sql of fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8').split(';').map(s=>s.trim()).filter(Boolean))await cluster.stage.$executeRawUnsafe(sql);await fixtures(cluster.stage,count,'lifecycle');
 pooler=await startPooler(cluster);
 console.log(JSON.stringify({checkpoint:'isolated-staging-ready'}));
 const {createReliablePublishingStore}=load('lib/publishing/reliableStore.ts'),{runReliableAdmission}=load('lib/publishing/reliableAdmission.ts'),{createReliableWorker,reconcileReliableJob}=load('lib/publishing/reliableWorker.ts'),{drainReliablePublishing}=load('lib/publishing/reliableConsumer.ts');
 let active=0,transactions=0;const durations=[];
 function assertRunning(){if(assessmentController.signal.aborted)throw Object.assign(new Error('Assessment interrupted'),{code:'PUBLISHING_FENCED'});}
 function database(db){return {$queryRaw:async(...args)=>{assertRunning();const start=performance.now();try{return await db.$transaction(async tx=>{await sleep(controlLatency/2);const rows=await tx.$queryRaw(...args);await sleep(controlLatency/2);return rows;},{maxWait:5000,timeout:2500});}catch(e){result.errors.push(e.code||e.name);throw e;}finally{durations.push(performance.now()-start);}},$transaction:async(cb,options)=>{assertRunning();const start=performance.now();try{return await db.$transaction(async tx=>{transactions++;result.transactionPeak=Math.max(result.transactionPeak,transactions);let acquired=false;try{await sleep(latency*.3);
  const proxy=new Proxy(tx,{get(target,key){if(key==='$queryRaw')return async sql=>{const rows=await target.$queryRaw(sql);if(!acquired&&sql.text?.includes('pg_try_advisory_xact_lock')&&rows[0]?.valid){acquired=true;active++;result.dataPeak=Math.max(result.dataPeak,active);}return rows;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  const rows=await cb(proxy);await sleep(latency*.7);return rows;}finally{transactions--;if(acquired)active--;}},options);}catch(e){if(!String(e.code||'').startsWith('PUBLISHING_'))result.errors.push(e.code||e.name);throw e;}finally{durations.push(performance.now()-start);}}};}
 const stores=Array.from({length:4},()=>createReliablePublishingStore(database(pooler.client())));
 let sampling=false;monitor=setInterval(async()=>{if(sampling)return;sampling=true;try{const rows=await cluster.admin.$queryRawUnsafe(`SELECT count(*) FILTER(WHERE backend_type='client backend')::int AS n,count(*) FILTER(WHERE backend_type<>'client backend')::int AS maintenance FROM pg_stat_activity WHERE datname=$1`,cluster.database);result.backendPeak=Math.max(result.backendPeak,rows[0].n);result.maintenancePeak=Math.max(result.maintenancePeak||0,rows[0].maintenance);}finally{sampling=false;}},100);
 // Provisioning bypass ends here; runtime clients ALL use PgBouncer.
 await cluster.stage.$disconnect();
 const start=performance.now(),ticks=[];let admissionComplete=false;
 progress=setInterval(async()=>{const states=await pooler.db.$queryRawUnsafe('SELECT phase,count(*)::int AS n FROM "PublishingJob" GROUP BY phase');console.log(JSON.stringify({elapsedSeconds:Math.round((performance.now()-start)/1000),states,dataPeak:result.dataPeak,backendPeak:result.backendPeak,errors:result.errors.length}));},30000);
 const admit=(async()=>{const overlaps=await Promise.all([runReliableAdmission(stores[0]),runReliableAdmission(stores[1])]);if(interrupted)return;assert.equal(overlaps.filter(t=>t.leader).length,1);ticks.push(...overlaps.filter(t=>t.leader));
  for(let tick=1;;tick++){const jobs=(await pooler.db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "PublishingJob"'))[0].n;if(jobs===count)break;if(tick>5)throw new Error('Admission did not drain');
   // Real one-minute ticks: do not accelerate the admission cadence.
   const wait=60000*tick-(performance.now()-start);if(wait>0)await sleep(wait);ticks.push(await runReliableAdmission(stores[0]));}
  result.admissionMs=performance.now()-start;result.admitted=(await pooler.db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "PublishingJob"'))[0].n;admissionComplete=true;
 })();
 if(native)mockPlatforms=require('./mock-platforms.cjs').createMockPlatforms();
 const calls=new Map(),finished=new Map();const workers=stores.slice(2).map(store=>createReliableWorker(store,async(job,signal)=>{
  if(signal.aborted)throw new Error('Aborted before mock provider');calls.set(job.id,(calls.get(job.id)||0)+1);result.providerAttempts++;await sleep(100);
  // This is a protocol-level mock, not a claim that production media, consent,
  // permissions, token refresh or reporting integrations have been validated.
  const confirmation=native?await mockPlatforms.publish(job,signal):'mock-confirmed-'+job.id;
  finished.set(job.id,{platform:job.platform,ms:performance.now()-start});return confirmation;
 },{concurrency:4}));
 let stop=false;const consume=async(i)=>{while(!stop&&!assessmentController.signal.aborted){if(performance.now()-start>30*60000)throw new Error('Lifecycle deadline exceeded');const round=await drainReliablePublishing(stores[i+2],workers[i],{durationMs:600000,rotation:i,signal:assessmentController.signal});result.measurements.push(round);
  if(interrupted)return;const unknown=await pooler.db.$queryRawUnsafe(`SELECT id FROM "PublishingJob" WHERE phase='OUTCOME_UNKNOWN'`);for(const j of unknown)await reconcileReliableJob(stores[i+2],j.id,async job=>finished.has(job.id)?'mock-confirmed-'+job.id:null);
  if(admissionComplete){const n=(await pooler.db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "PublishingJob" WHERE phase='CONFIRMED'`))[0].n;if(n===count){stop=true;break;}}await sleep(500);}};
 await Promise.all([admit,consume(0),consume(1)]);await Promise.all(workers.map(w=>w.close()));if(interrupted)return;
 result.completedMs=performance.now()-start;result.confirmed=(await pooler.db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "PublishingJob" WHERE phase='CONFIRMED'`))[0].n;
 result.publishedStatus=(await pooler.db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "CalendarPost" WHERE CASE WHEN platform='INSTAGRAM' THEN "instagramPublishStatus"::text WHEN platform='TIKTOK' THEN "tikTokPublishStatus"::text ELSE "publishStatus"::text END='PUBLISHED'`))[0].n;
 result.maximumMockPublishingDelayMs=Math.max(...[...finished.values()].map(v=>v.ms))+10000;result.duplicateAttempts=[...calls.values()].reduce((n,v)=>n+Math.max(0,v-1),0);result.platformCompletions=Object.fromEntries(['INSTAGRAM','TIKTOK','FACEBOOK','LINKEDIN','X'].map(p=>[p,[...finished.values()].filter(v=>v.platform===p).length]));
 durations.sort((a,b)=>a-b);result.databaseOperationMs={median:durations[Math.floor(durations.length*.5)],p95:durations[Math.floor(durations.length*.95)],max:durations.at(-1)};result.ticks=ticks;
 assert.equal(result.confirmed,count);assert.equal(result.publishedStatus,count);assert.equal(result.duplicateAttempts,0);assert.ok(result.dataPeak<=3);assert.ok(result.backendPeak<=5);assert.equal(result.errors.length,0);result.success=true;
}
process.on('SIGTERM',()=>{interrupted=true;assessmentController.abort();process.exitCode=1;clearInterval(progress);clearInterval(monitor);pooler?.close().then(()=>cluster?.close()).then(()=>process.exit(1));});
main().catch(e=>{assessmentController.abort();result.success=false;result.failure={code:e.code||e.name,message:e.message.startsWith('Admission')?e.message:'LIFECYCLE_CHECK_FAILED'};if(!interrupted)console.error(result.failure);process.exitCode=1;}).finally(async()=>{clearInterval(progress);clearInterval(monitor);mockPlatforms?.close();await pooler?.close();await cluster?.close();if(interrupted)return;const file=native?'/tmp/showwork-consumer-final-'+count+(warm?'-1380':'')+'.json':smoke?'/tmp/showwork-consumer-smoke.json':'/tmp/showwork-consumer-250.json';fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({success:result.success,file,admissionMs:result.admissionMs,completedMs:result.completedMs,backendPeak:result.backendPeak,errors:result.errors.length}));});
