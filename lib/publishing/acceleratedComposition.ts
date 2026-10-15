import {createInactiveCanonicalWorker,type CanonicalWorkerDependencies} from './canonicalWorker';
import {createPublishingCoordination} from './executionCoordination';
import {createCanonicalStatusProjection} from './statusProjection';
import {createImmutablePublishingMedia} from './immutableMedia';
export function createAcceleratedPublishingWorker(deps:CanonicalWorkerDependencies&{
 materialize(input:{jobId:string;assetId:string;sourceKey:string;objectVersion:string;contentSha256:string}):Promise<{blobKey:string;objectVersion:string;contentSha256:string}>;
 rates:{creator:number;init:number;status:number};
}){
 const coordination=createPublishingCoordination(deps),media=createImmutablePublishingMedia(deps),original=deps.io;
 const io={...original,media:async(target:Parameters<typeof original.media>[0],assets:Parameters<typeof original.media>[1],creator?:Parameters<typeof original.media>[2])=>original.media(target,await media.pinnedAssets(target,assets),creator),
 reserveRate:async(target:Parameters<typeof original.reserveRate>[0],kind:Parameters<typeof original.reserveRate>[1])=>{await coordination.reserveRate(`${target.platform}:${target.providerAccountId}:${kind}`,deps.rates[kind],60000);if(target.platform==='TIKTOK')await coordination.reserveSpacing(`${target.platform}:${target.providerAccountId}:${kind}`,{creator:3100,init:10100,status:2100}[kind]);await original.reserveRate(target,kind);}};
 return createInactiveCanonicalWorker({...deps,io,executionCoordination:coordination,snapshotMedia:media.snapshot,projectStatus:createCanonicalStatusProjection(deps)});
}
