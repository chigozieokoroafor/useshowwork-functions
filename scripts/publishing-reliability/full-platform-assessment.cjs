'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const {startCluster}=require('../../tests/helpers/isolated-postgres.cjs'),{startPooler}=require('../../tests/helpers/isolated-pooler.cjs'),{installFullSchema,fixtures}=require('../../tests/helpers/full-publishing-stage.cjs'),{load}=require('../../tests/helpers/load-typescript.cjs'),{createMockSocialApis}=require('./mock-social-apis.cjs');
const smoke=process.argv.includes('--smoke'),count=smoke?10:250,latency=smoke?0:process.argv.includes('--tail')?1923:1380,control=smoke?0:320;
const runId=randomUUID(),file=path.join('/tmp','showwork-full-platform-'+runId+'.json'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const shutdown=new AbortController();
const result={runId,productionAccess:false,realPublishing:false,hostedMeasurement:false,count,injectedTransactionMs:latency,controlLatencyMs:control,backendCap:5,reconciliationTimeoutMs:120000,errors:[],platformFailures:{},backendPeak:0,dataPeak:0,modelCalls:{},ticks:[],transactionErrors:[],consumerRounds:[],acceptanceChecks:[],backpressure:0};
let cluster,pooler,apis,monitor,progress;let interrupted=false,stopping=false;const consumers=[],workers=[],consumerLeases=[],heartbeats=[];
async function main(){
 cluster=await startCluster();await installFullSchema(cluster);const seeded=await fixtures(cluster.stage,count);pooler=await startPooler(cluster,{nativePublishing:true});await cluster.stage.$disconnect();apis=await createMockSocialApis({pendingReads:1,delayMs:5});
 const deny=new Proxy({}, {get(){throw Error('Unbudgeted default database access prohibited');}}),mocks={'@/lib/db':{db:deny},'@/lib/r2':apis.storage};const cache=new Map();
 const {createReliablePublishingStore}=load('lib/publishing/reliableStore.ts',mocks,cache),{createBudgetedPublishingDatabase}=load('lib/publishing/budgetedDatabase.ts',mocks,cache),{createPlatformIntegration}=load('lib/publishing/platformIntegration.ts',mocks,cache),{createReliableWorker,reconcileReliableJob}=load('lib/publishing/reliableWorker.ts',mocks,cache),{runReliableAdmission}=load('lib/publishing/reliableAdmission.ts',mocks,cache),{drainReliablePublishing}=load('lib/publishing/reliableConsumer.ts',mocks,cache);
 const {withPublishingExecution}=load('lib/publishing/executionContext.ts',mocks,cache);
 let active=0,sampling=false;const txTimes=[];
 function describe(error,kind,trace,elapsedMs){
  const code=error.code||error.name;
  if(String(code).startsWith('PUBLISHING_')){result.backpressure++;return;}
  result.errors.push(code);result.transactionErrors.push({kind,code,name:error.name,message:String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[redacted-database-url]').slice(-1800),elapsedMs,trace});
 }
 function wrap(db){return{$queryRaw:async(...args)=>{
  if(stopping)throw Object.assign(Error('Stopped'),{code:'PUBLISHING_FENCED'});
  const started=performance.now(),sql=String(args[0]?.text||args[0]?.sql||'control');
  // Simulate round-trip time, not a fictitious transaction retaining row locks
  // after its single autocommit statement has completed.
  try{await sleep(control/2);const rows=await db.$queryRaw(...args);await sleep(control/2);return rows;}
  catch(e){describe(e,'control',[sql.slice(0,240)],performance.now()-started);throw e;}
 },$transaction:async(cb,options)=>{
  if(stopping)throw Object.assign(Error('Stopped'),{code:'PUBLISHING_FENCED'});
  const started=performance.now(),trace=[];
  try{return await db.$transaction(async tx=>{active++;result.dataPeak=Math.max(result.dataPeak,active);
   try{await sleep(latency*.3);const proxy=new Proxy(tx,{get(target,key){const value=target[key];
    if(typeof value==='function')return(...args)=>{trace.push(String(key)+':'+String(args[0]?.text||args[0]?.sql||'').slice(0,160));return value.apply(target,args);};
    if(value&&typeof value==='object')return new Proxy(value,{get(delegate,method){const fn=delegate[method];if(typeof fn!=='function')return fn;return(...args)=>{const label=String(key)+'.'+String(method);trace.push(label);result.modelCalls[label]=(result.modelCalls[label]||0)+1;return fn.apply(delegate,args);};}});return value;}});
    const rows=await cb(proxy);await sleep(latency*.7);return rows;
   }finally{active--;}}
   ,options);
  }catch(e){describe(e,'data',trace,performance.now()-started);throw e;}
  finally{txTimes.push(performance.now()-started);}
 }};}

 const stores=Array.from({length:4},()=>createReliablePublishingStore(wrap(pooler.client())));
 for(let i=0;i<2;i++){
  const root=stores[i+2],lease=await root.acquireConsumer(randomUUID());assert.ok(lease);consumerLeases.push({root,lease});heartbeats.push(setInterval(()=>root.renewConsumer(lease).catch(()=>{}),15000));
  const store={...root,prepare:(job,token)=>root.prepare(job,token,lease),prepareMany:requests=>root.prepareMany(requests,lease),beginExternal:(job,token,_owner,account,init)=>root.beginExternal(job,token,lease,account,init)},port=createBudgetedPublishingDatabase(store),native=createPlatformIntegration(port,{verifyPublication:(job,account)=>root.assertPublication(job,account,lease),beginPublication:async(job,account,init)=>{
   for(let retry=0;retry<20;retry++){try{return (await store.beginExternal(job,job.workerToken,undefined,account,init)).length===1;}catch(e){if(e.code==='PUBLISHING_DEFERRED'){await sleep(1000);continue;}const saved=await store.findJob(job.id).catch(()=>null);if(saved?.phase==='EXTERNAL_PENDING'&&saved.workerToken===job.workerToken)return true;throw e;}}throw Object.assign(Error('Database capacity unavailable before publishing'),{code:'PUBLISHING_DEFERRED'});
  }});consumers.push(native);
  workers.push(createReliableWorker(store,(j,s)=>apis.run(j.postId,()=>native.publish(j,s)),{concurrency:4,lateBoundary:true,preflight:(j,s)=>apis.run(j.postId,()=>withPublishingExecution({signal:s,postId:j.postId},()=>native.preflight(j))),afterJob:native.forget,knownProof:native.knownProof,knownReference:native.knownReference,abortOutcome:native.abortOutcome}));
 }
 const reconciliationPort=createBudgetedPublishingDatabase(stores[1]),reconciliationNative=createPlatformIntegration(reconciliationPort);consumers.push(reconciliationNative);
 monitor=setInterval(async()=>{if(sampling||stopping)return;sampling=true;try{const rows=await cluster.admin.$queryRawUnsafe(`SELECT count(*) FILTER(WHERE backend_type='client backend')::int AS n FROM pg_stat_activity WHERE datname=$1`,cluster.database);result.backendPeak=Math.max(result.backendPeak,rows[0].n);}catch{}finally{sampling=false;}},100);
 const started=performance.now();let admissionDone=false,done=false;
 let progressActive=false;progress=setInterval(async()=>{if(stopping||progressActive)return;progressActive=true;try{const states=await pooler.db.$queryRawUnsafe('SELECT phase,count(*)::int AS n FROM "PublishingJob" GROUP BY phase');result.lastCheckpoint={elapsedMs:performance.now()-started,states};result.duplicateAttempts=[...apis.attempts.values()].reduce((n,v)=>n+Math.max(0,v-1),0);fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({runId,seconds:Math.round((performance.now()-started)/1000),states,errors:result.errors.length,backendPeak:result.backendPeak}));}catch(e){if(!stopping)describe(e,'harness-progress',[],0);}finally{progressActive=false;}},30000);
 console.log(JSON.stringify({runId,file,checkpoint:'full-synthetic-schema-ready',latency}));
 const admission=(async()=>{const overlap=await Promise.all([runReliableAdmission(stores[0]),runReliableAdmission(stores[1])]);assert.equal(overlap.filter(t=>t.leader).length,1);result.ticks.push(...overlap.filter(t=>t.leader));
  for(let tick=1;!done&&!stopping;tick++){const n=(await pooler.db.$queryRawUnsafe('SELECT count(DISTINCT "postId")::int AS n FROM "PublishingJob"'))[0].n;if(n===count&&!admissionDone){result.admissionMs=performance.now()-started;admissionDone=true;}await new Promise(resolve=>{const timer=setTimeout(resolve,Math.max(0,60000*tick-(performance.now()-started)));shutdown.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});if(done||stopping)break;result.ticks.push(await runReliableAdmission(stores[0]));}})();
 async function consume(i){while(!done&&!stopping){if(performance.now()-started>90*60000)throw Error('Full lifecycle deadline exceeded');const round=await drainReliablePublishing(stores[i+2],workers[i],{durationMs:60000,rotation:i,signal:shutdown.signal});result.platformFailures[i]=(result.platformFailures[i]||0)+round.errors;result.consumerRounds.push({consumer:i,...round});
  if(admissionDone){const n=(await pooler.db.$queryRawUnsafe(`SELECT count(DISTINCT "postId")::int AS n FROM "PublishingJob" WHERE phase='CONFIRMED'`))[0].n;if(n===count){result.totalPublishingMs=performance.now()-started;done=true;shutdown.abort();break;}const rejected=(await pooler.db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "PublishingJob" WHERE phase='REJECTED'`))[0].n;if(rejected){result.rejections=await pooler.db.$queryRawUnsafe(`SELECT platform,"lastError" FROM "PublishingJob" WHERE phase='REJECTED'`);throw Error('Native platform rejection in happy-path load');}}await sleep(200);}}
 async function reconcileLoop(){while(!done&&!stopping){
  const pending=await stores[1].reconciliationJobs(2);
  await Promise.all(pending.map(job=>apis.run(job.postId,()=>withPublishingExecution({signal:AbortSignal.timeout(result.reconciliationTimeoutMs),postId:job.postId},()=>reconcileReliableJob(stores[1],job.id,j=>reconciliationNative.reconcile(j)))).catch(e=>{describe(e,'reconciliation',[job.id],0);} )));
  for(const job of await stores[1].reportingJobs(2))await apis.run(job.postId,async()=>{try{if(await reconciliationNative.repairReporting(job))await stores[1].markReported(job.id);}catch{}});
  await sleep(pending.length?100:1000);
 }}
 const loops=[admission,consume(0),consume(1),reconcileLoop()];
 try{await Promise.all(loops);}catch(e){stopping=true;shutdown.abort();await Promise.allSettled(loops);throw e;}await Promise.all(workers.map(w=>w.close()));
 const published=await pooler.db.$queryRawUnsafe(`SELECT p.platform,count(*)::int AS n,max(extract(epoch FROM (COALESCE(p."instagramPublishedAt",p."tikTokPublishedAt",p."publishedAt")-p."postDate"))*1000)::float8 AS "maximumDelayMs" FROM "CalendarPost" p WHERE CASE WHEN p.platform='INSTAGRAM' THEN p."instagramPublishStatus"::text WHEN p.platform='TIKTOK' THEN p."tikTokPublishStatus"::text ELSE p."publishStatus"::text END='PUBLISHED' GROUP BY p.platform`);
 result.published=published;result.confirmed=(await pooler.db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "PublishingJob" WHERE phase='CONFIRMED'`))[0].n;result.reportingRows=await pooler.db.publishedSocialPost.count();result.maximumPublishingDelayMs=Math.max(...published.map(p=>p.maximumDelayMs));result.duplicateAttempts=[...apis.attempts.values()].reduce((n,v)=>n+Math.max(0,v-1),0);result.publishAttempts=Object.fromEntries(apis.attempts);result.tikTokConvertedImages=apis.converted;result.refreshRequests=apis.operations.filter(o=>o.kind==='refresh').length;
 txTimes.sort((a,b)=>a-b);result.transactionMs={p50:txTimes[Math.floor(txTimes.length*.5)],p95:txTimes[Math.floor(txTimes.length*.95)],max:txTimes.at(-1),count:txTimes.length};
 const checks={published:published.reduce((n,p)=>n+p.n,0)===count,confirmed:result.confirmed===count,reporting:result.reportingRows===count,duplicates:result.duplicateAttempts===0,dataBudget:result.dataPeak<=3,backendBudget:result.backendPeak<=5,databaseErrors:result.errors.length===0};
 result.acceptanceChecks=Object.entries(checks).map(([name,passed])=>({name,passed}));result.success=Object.values(checks).every(Boolean);if(!result.success)process.exitCode=1;
}
process.on('SIGTERM',()=>{interrupted=true;stopping=true;shutdown.abort();});
main().catch(e=>{stopping=true;shutdown.abort();result.success=false;result.failure={code:e.code||e.name,message:e.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[redacted-database-url]').slice(-1800)};process.exitCode=1;}).finally(async()=>{stopping=true;clearInterval(monitor);clearInterval(progress);for(const h of heartbeats)clearInterval(h);await Promise.all(workers.map(w=>w.close()));if(pooler){try{result.finalStates=await pooler.db.$queryRawUnsafe('SELECT platform,phase,count(*)::int AS n FROM "PublishingJob" GROUP BY platform,phase');result.confirmed=(await pooler.db.$queryRawUnsafe("SELECT count(*)::int AS n FROM \"PublishingJob\" WHERE phase='CONFIRMED'"))[0].n;result.reportingRows=await pooler.db.publishedSocialPost.count();}catch(e){result.snapshotFailure=e.code||e.name;}}result.duplicateAttempts=apis?[...apis.attempts.values()].reduce((n,v)=>n+Math.max(0,v-1),0):null;for(const c of consumers)c.close();for(const {root,lease} of consumerLeases)await root.releaseConsumer(lease).catch(()=>{});apis?.close();await pooler?.close();await cluster?.close();result.clusterRemoved=cluster?!fs.existsSync(cluster.directory):false;result.interrupted=interrupted;fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({file,success:result.success,interrupted,failure:result.failure,rejections:result.rejections,admissionMs:result.admissionMs,totalPublishingMs:result.totalPublishingMs,errors:result.errors.length}));});
