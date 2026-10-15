/** Stage 4C.5 inactive composition. Factory has no IO, timers or activation. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createCanonicalWorkerStore } from './canonicalWorkerStore';
import { createExternalPublicationAuthorization, type PublicationTarget, type ProviderObservation } from './externalAuthorization';
import { createCapabilityProviderIntegration, type MockProviderIO } from './capabilityProviders';
import type { createPublishingValidationAdapters } from './validationAdapters';
import type { OwnershipDatabase } from './ownership';
import type { DurableProviderSpool } from './providerSpool';
export interface CanonicalWorkerResult {
 state:'confirmed'|'provider-pending'|'rejected'|'outcome-unknown'|'deferred'|'blocked'|'fenced'|'stopping';
 jobId:string;code?:string;reference?:string;
}
export interface CanonicalWorkerDependencies {
 environment:'isolated-mock'|'production-disabled'|'production-canonical';database:OwnershipDatabase;validation:ReturnType<typeof createPublishingValidationAdapters>;
 spool:DurableProviderSpool;io:MockProviderIO;actor:string;owner:'NETLIFY'|'VPS';epoch:bigint;
 concurrency?:number;jobTimeoutMs?:number;shutdownGraceMs?:number;preparedLeaseMs?:number;
 executionCoordination?:{acquire(input:{target:PublicationTarget;workerToken:string;owner:'NETLIFY'|'VPS';epoch:bigint}):Promise<unknown>;release(input:{target:PublicationTarget;workerToken:string}):Promise<unknown>};
 snapshotMedia?:(target:PublicationTarget)=>Promise<void>;
 projectStatus?:(target:PublicationTarget)=>Promise<unknown>;
}
export function createInactiveCanonicalWorker(deps:CanonicalWorkerDependencies){
 const disabled=deps.environment==='production-disabled'&&deps.io.kind==='native-disabled';
 const native=deps.environment==='production-canonical'&&deps.io.kind==='native-reviewed';
 if(!disabled&&!native&&(deps.environment!=='isolated-mock'||deps.io.kind!=='local-mock'))throw Error('INACTIVE_MOCK_WORKER_REQUIRED');
 if(native&&(!deps.executionCoordination||!deps.snapshotMedia||!deps.projectStatus))throw Error('NATIVE_DURABLE_COORDINATION_REQUIRED');
 const concurrency=deps.concurrency??2,timeout=deps.jobTimeoutMs??30_000,grace=deps.shutdownGraceMs??5_000;
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3||!Number.isInteger(timeout)||timeout<1||timeout>60_000||!Number.isInteger(grace)||grace<0||grace>10_000)throw Error('INVALID_WORKER_BOUNDS');
 const store=createCanonicalWorkerStore(deps),actor=deps.actor,owner=deps.owner,epoch=deps.epoch;
 const authorization=createExternalPublicationAuthorization(deps);
 const controllers=new Set<AbortController>(),active=new Set<Promise<CanonicalWorkerResult>>(),unsettled=new Set<Promise<CanonicalWorkerResult>>(),jobs=new Set<string>();
 let stopping=false,closing:Promise<{quiescent:boolean;pendingOperations:number}>|undefined;
 function result(jobId:string,state:CanonicalWorkerResult['state'],code?:string):CanonicalWorkerResult{return {jobId,state,...(code?{code}:{})};}
 function observation(jobId:string,o:ProviderObservation):CanonicalWorkerResult{return {jobId,state:{CONFIRMED:'confirmed',ACCEPTED:'provider-pending',REJECTED:'rejected',UNKNOWN:'outcome-unknown'}[o.outcome] as CanonicalWorkerResult['state'],...('reference'in o&&o.reference?{reference:o.reference}:{})};}
 function checkpoint(signal:AbortSignal){if(stopping||signal.aborted)throw Error('WORKER_STOPPING');}
 function layer(signal:AbortSignal){return createCapabilityProviderIntegration({environment:native?'production-canonical':'isolated-mock',database:deps.database,validation:deps.validation,authorization,spool:deps.spool,io:deps.io,signal});}
 async function work(target:PublicationTarget,signal:AbortSignal,stage:{authorizationStarted:boolean},recoverOnly:boolean):Promise<CanonicalWorkerResult>{
  let claim:Awaited<ReturnType<typeof store.claim>>|undefined;
  try{
   checkpoint(signal);
   const {job,cap}=await store.recovery(target);checkpoint(signal);
   if(job.phase==='CONFIRMED')return result(job.id,'confirmed');
   if(job.phase==='REJECTED')return result(job.id,'rejected');
   if(job.phase==='CANCELLED')return result(job.id,'blocked','CANCELLED');
   if(cap){
    // Issued/revoked authorization stays a durable unresolved fact. No restore,
    // consumption, replacement mint, token recovery or automatic retry here.
    if(cap.state!=='CONSUMED')return result(job.id,'outcome-unknown','AUTHORIZATION_REQUIRES_RECONCILIATION');
    if(cap.phase==='EXTERNAL_PENDING'&&!cap.expired)return result(job.id,'deferred','ATTEMPT_MAY_BE_ACTIVE');
    const outcome=await layer(signal).reconcile(cap.id);if(['CONFIRMED','REJECTED'].includes(outcome.outcome)&&job.workerToken)await deps.executionCoordination?.release({target,workerToken:job.workerToken}).catch(()=>{});return observation(job.id,outcome);
   }
   if(recoverOnly)return result(job.id,'deferred','NO_AUTHORIZED_ATTEMPT');
   if(native){
    const current=await deps.database.transaction(async tx=>(await tx.query(`SELECT enabled,state,epoch FROM "PublishingOwnership" WHERE id=1 FOR SHARE`)).rows[0]);
    if(!current?.enabled||current.state!==owner||BigInt(current.epoch)!==epoch)throw Error('OWNERSHIP_FENCED');
    // An expired credential must be refreshable before admission checks it.
    // This read/rotation grants no send authority: claim, preparation and final
    // authorization still revalidate exact destination, policy and ownership.
    await deps.io.refresh(target);checkpoint(signal);
   }
   const claimed=claim=await store.claim(target);checkpoint(signal);
   await deps.executionCoordination?.acquire(claimed);checkpoint(signal);
   await deps.snapshotMedia?.(claimed.target);checkpoint(signal);
   const providers=layer(signal);await providers.prepare(claimed.target);checkpoint(signal);
   // Rechecks current ownership, claim, content and transactional eligibility.
   // Conservative result classification if COMMIT acknowledgement is lost. This
   // flag is not durable authorization or proof that any provider call started.
   stage.authorizationStarted=true;const grant=await authorization.authorize({...claimed.target,operationId:randomUUID(),actor,owner,epoch,workerToken:claimed.workerToken});
   checkpoint(signal);
   if(!grant.maySend)return result(job.id,'outcome-unknown','NO_FRESH_SEND_CAPABILITY');
   return observation(job.id,await providers.publish({target:claimed.target,capability:grant.capability}));
  }catch(error){
   const code=error instanceof Error?(('code'in error&&typeof error.code==='string')?error.code:error.message):'WORKER_OPERATION_FAILED';
   if(stage.authorizationStarted)return result(target.jobId,'outcome-unknown',code);
   if(stopping||signal.aborted)return result(target.jobId,'deferred','WORKER_STOPPING');
   if(/OWNERSHIP|EPOCH/.test(code))return result(target.jobId,'fenced',code);
   if(/JOB_NOT_ELIGIBLE|NOT_DUE|UNCONFIRMED|TRANSACTION/.test(code))return result(target.jobId,'deferred',code);
   await store.parkUnsent(target,code).catch(()=>{});
   return result(target.jobId,'blocked',code);
  }finally{if(claim)await deps.executionCoordination?.release(claim).catch(()=>{});await deps.projectStatus?.(target).catch(()=>{});}
 }
 function run(target:PublicationTarget,recoverOnly=false,budgetMs=timeout):Promise<CanonicalWorkerResult>{
  // Hints are immutable exact tuples, not authority or provider payloads.
  if(!target||typeof target.jobId!=='string')return Promise.reject(Error('EXACT_PUBLICATION_HINT_REQUIRED'));
  if(disabled)return Promise.resolve(result(target.jobId,'blocked','PUBLISHING_DISABLED'));
  target=Object.freeze({...target});
  if(stopping)return Promise.resolve(result(target.jobId,'stopping'));
  if(jobs.has(target.jobId)||jobs.size>=concurrency)return Promise.resolve(result(target.jobId,'deferred','LOCAL_WORKER_CAPACITY'));
  jobs.add(target.jobId);const controller=new AbortController(),stage={authorizationStarted:false};controllers.add(controller);
  let abortListener:()=>void;
  const interrupted=new Promise<CanonicalWorkerResult>(resolve=>{abortListener=()=>resolve(result(target.jobId,stage.authorizationStarted?'outcome-unknown':'deferred','WORKER_DEADLINE_OR_SHUTDOWN'));controller.signal.addEventListener('abort',abortListener,{once:true});});
  const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(timeout,budgetMs)));
  const task=work(target,controller.signal,stage,recoverOnly);unsettled.add(task);
  // Retain a local slot until provider work actually settles. A timed-out IO
  // cannot accumulate unbounded orphan work inside one worker.
  void task.finally(()=>{unsettled.delete(task);jobs.delete(target.jobId);controllers.delete(controller);});
  const bounded=Promise.race([task,interrupted]).finally(()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',abortListener);active.delete(bounded);});
  active.add(bounded);return bounded;
 }
 async function pollOnce(limit=concurrency,deadline?:number){
  if(!Number.isInteger(limit)||limit<1||limit>5)throw Error('INVALID_WORKER_POLL_LIMIT');
  if(disabled)return {state:'disabled' as const,results:[] as CanonicalWorkerResult[]};
  if(stopping)return {state:'stopping' as const,results:[] as CanonicalWorkerResult[]};
  if(jobs.size>=concurrency)return {state:'busy' as const,results:[] as CanonicalWorkerResult[]};
  const hints=await store.poll(Math.min(limit,concurrency-jobs.size));
  const remaining=()=>deadline===undefined?timeout:Math.max(0,deadline-performance.now());
  const recovery=remaining()>0?await Promise.all(hints.recovery.map(t=>run(t,true,remaining()))):[];
  const fresh=remaining()>0?await Promise.all(hints.ready.map(t=>run(t,false,remaining()))):[];
  return {state:hints.fenced?'fenced' as const:'polled' as const,results:[...recovery,...fresh]};
 }
 async function drain(options:{durationMs:number;maxRounds:number}){
  if(!Number.isInteger(options.durationMs)||options.durationMs<1||options.durationMs>60_000||!Number.isInteger(options.maxRounds)||options.maxRounds<1||options.maxRounds>100)throw Error('INVALID_WORKER_DRAIN_BOUNDS');
  const start=performance.now(),rounds=[];
  // Explicit finite polling only, no scheduler/wake delivery or background timer.
  for(let n=0;n<options.maxRounds&&!stopping&&performance.now()-start<options.durationMs;n++){
   const r=await pollOnce(concurrency,start+options.durationMs);rounds.push(r);if(!r.results.length)break;
  }
  return rounds;
 }
 function close(){
  if(closing)return closing;stopping=true;
  if(disabled)return closing=Promise.resolve({quiescent:true,pendingOperations:0});
  closing=(async()=>{const timer=setTimeout(()=>{for(const c of controllers)c.abort();},grace);
   try{await Promise.allSettled([...active]);}finally{clearTimeout(timer);for(const c of controllers)c.abort();}
   return {quiescent:unsettled.size===0,pendingOperations:unsettled.size};
  })();return closing;
 }
 return {run:(t:PublicationTarget)=>run(t),recover:(t:PublicationTarget)=>run(t,true),pollOnce:(limit?:number)=>pollOnce(limit),drain,close,
  status:()=>({stopping,available:Math.max(0,concurrency-jobs.size),pendingOperations:unsettled.size})};
}
