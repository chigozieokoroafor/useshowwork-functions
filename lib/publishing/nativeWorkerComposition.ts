/** Explicit production transport assembly. No environment loading, connection,
 * timers or requests on construction; every submission remains capability-bound. */
import {createBoundedProviderHttpAdapter} from './providerHttpAdapter';
import {createNativeMediaPreparation} from './nativeMediaPreparation';
import {createCanonicalCredentialResolver,createCanonicalReconciliationCredentialResolver} from './credentialResolver';
import {createExternalPublicationAuthorization,type PublicationTarget} from './externalAuthorization';
import {createProviderJournal} from './providerJournal';
import {createAcceleratedPublishingWorker} from './acceleratedComposition';
import type {CanonicalWorkerDependencies} from './canonicalWorker';
import type {MockProviderIO} from './capabilityProviders';
import {policyHash} from './eligibilityPolicy';
export function createNativeCanonicalPublishingWorker(input:Omit<CanonicalWorkerDependencies,'environment'|'io'|'owner'>&{
 // Explicit veto is mandatory even for a caller with all valid credentials.
 publishingEnabled:boolean;
 fetch:Parameters<typeof createBoundedProviderHttpAdapter>[0]['fetch'];
 versions:{meta:string;linkedin:string};
 materialize:Parameters<typeof createAcceleratedPublishingWorker>[0]['materialize'];
 rates:Parameters<typeof createAcceleratedPublishingWorker>[0]['rates'];
 refresh:MockProviderIO['refresh'];creatorInfo:MockProviderIO['creatorInfo'];
 media:MockProviderIO['media'];
 readMedia:Parameters<typeof createNativeMediaPreparation>[0]['readMedia'];
 sleep:(ms:number)=>Promise<void>;
 preparationCache?:{read(jobId:string,requestHash:string):Promise<unknown>;write(jobId:string,requestHash:string,response:unknown):Promise<void>};
}){
 if(typeof input.publishingEnabled!=='boolean'||!input.fetch||!input.refresh||!input.creatorInfo||!input.media||!input.materialize||!input.readMedia||!input.sleep)throw Error('NATIVE_WORKER_DEPENDENCIES_REQUIRED');
 const credential=createCanonicalCredentialResolver(input.database),reconciliationCredential=createCanonicalReconciliationCredentialResolver(input.database);
 const authorization=createExternalPublicationAuthorization(input),journal=createProviderJournal({...input,authorization});
 const mediaPreparation=createNativeMediaPreparation({...input,credential,metaVersion:input.versions.meta,linkedinVersion:input.versions.linkedin});
 const adapter=createBoundedProviderHttpAdapter({...input,credential,reconciliationCredential,mediaPreparation,journal});
 const prepare:MockProviderIO['prepare']=async(target,operation,payload)=>{
  if(operation==='IG_CONTAINER_STATUS'){
   for(let attempt=0;attempt<5;attempt++){
    const response=await adapter.prepare(target,operation,payload),status=response.body.status_code;
    if(status==='FINISHED'||status==='ERROR'||status==='EXPIRED'||status==='PUBLISHED'||response.status>=400)return response;
    if(attempt<4)await input.sleep(1000);
   }
   return {status:200,body:{status_code:'IN_PROGRESS'}};
  }
  const cachedOperations=['IG_CONTAINER','IG_CAROUSEL','FB_PHOTO','FB_REEL_START','LI_MEDIA','X_MEDIA'];
  if(!input.preparationCache||!cachedOperations.includes(operation))return adapter.prepare(target,operation,payload);
  const requestHash=policyHash({target,operation,payload}),old=await input.preparationCache.read(target.jobId,requestHash);
  if(old)return old as Awaited<ReturnType<MockProviderIO['prepare']>>;
  const response=await adapter.prepare(target,operation,payload);
  if(response.status>=200&&response.status<300&&(!response.body.error||response.body.error.code==='ok')&&(response.body.id||response.body.video_id)){
   // Store media references before polling or subsequent steps. Never cache a
   // publication operation, status lookup, token or authorization capability.
   const body={id:response.body.id,video_id:response.body.video_id,upload_url:response.body.upload_url};
   const durable={status:response.status,body};await input.preparationCache.write(target.jobId,requestHash,durable);return durable;
  }
  return response;
 };
 const io:MockProviderIO={kind:input.publishingEnabled?'native-reviewed':'native-disabled',refresh:input.refresh,creatorInfo:input.creatorInfo,media:input.media,reserveRate:async()=>{},...adapter,prepare};
 // Shared immutable media, account execution leases, rate reservations and status
 // projection are mandatory. The worker's database authorization still decides
 // ownership/epoch/current eligibility; configuration is never send authority.
 return createAcceleratedPublishingWorker({...input,io,owner:'VPS',environment:input.publishingEnabled?'production-canonical':'production-disabled'});
}
