/** Production-shaped dependency graph, permanently disabled in this release. */
import {validateDisabledPublishingDeployment} from '@/lib/publishing/deploymentReadiness';
import {createInactiveCanonicalWorker,type CanonicalWorkerDependencies} from '@/lib/publishing/canonicalWorker';
import {createPublishingValidationAdapters} from '@/lib/publishing/validationAdapters';

export function createDisabledVpsWorker(configuration:unknown,deps:Omit<CanonicalWorkerDependencies,'environment'|'owner'|'concurrency'>){
 const config=validateDisabledPublishingDeployment(configuration);
 if(deps.io.kind!=='native-disabled')throw Error('DISABLED_NATIVE_PROVIDER_PORTS_REQUIRED');
 return createInactiveCanonicalWorker({...deps,environment:'production-disabled',owner:'VPS',concurrency:config.workerConcurrency});
}
/** Offline construction check: any accidental dependency call fails the check.
 * No credentials, pools, storage clients, sockets or worker timers are created. */
export async function checkDisabledVpsComposition(configuration:unknown){
 const denied=async()=>{throw Error('DISABLED_CHECK_IO_FORBIDDEN');},database={transaction:denied},validation=createPublishingValidationAdapters({database,verifyViewer:denied,verifyRetryEvidence:denied});
 const io={kind:'native-disabled' as const,refresh:denied,reserveRate:denied,creatorInfo:denied,media:denied,prepare:denied,submit:denied,lookup:denied},spool={append:denied,records:denied};
 const worker=createDisabledVpsWorker(configuration,{database,validation,io,spool,actor:'disabled-check',epoch:BigInt(1)});
 const result=await worker.pollOnce();await worker.close();return {state:result.state,publishingEnabled:false,databaseConnected:false,maySend:false};
}
