import {createCanonicalStatusProjection} from '@/lib/publishing/statusProjection';
import {canonicalPublicationTarget} from '@/lib/publishing/canonicalWorkerStore';
import {prepareCanonicalTikTokMedia} from '@/lib/publishing/nativeTikTokMedia';
/** Runnable native assembly; only the explicit runner calls this. No clients on import. */
import {Pool} from 'pg';
import {S3Client} from '@aws-sdk/client-s3';
import {createPublishingTransactionDatabase,type PublishingPool} from '@/lib/publishing/transactionDatabase';
import {createPublishingObjectStorage} from '@/lib/publishing/objectStorageAdapters';
import {createSharedPublishingJournal} from '@/lib/publishing/sharedJournal';
import {createPublishingValidationAdapters} from '@/lib/publishing/validationAdapters';
import {createPublishingCoordination} from '@/lib/publishing/executionCoordination';
import {createShowworkPublishingAccounts} from '@/lib/publishing/showworkPublishingAccounts';
import {createCanonicalCredentialResolver} from '@/lib/publishing/credentialResolver';
import {queryTikTokCreatorInfo} from '@/lib/tiktok';
import {createNativeCanonicalPublishingWorker} from '@/lib/publishing/nativeWorkerComposition';
import type {PublishingHostConfiguration} from '@/lib/publishing/hostConfiguration';
import {installDisabledPublishingApplication} from '@/lib/publishing/applicationBoundary';
export async function createNativePublishingHost(configuration:PublishingHostConfiguration,fetch:typeof globalThis.fetch,clients?:{storageClient:Pick<S3Client,'send'|'destroy'>;preparedLeaseMs?:number},mode:'publish'|'reconcile'='publish'){
 if(!configuration.databaseUrl||!(mode==='publish'?configuration.enabled:configuration.reconciliation))throw Error('NATIVE_HOST_DISABLED');
 const config=configuration as Extract<PublishingHostConfiguration,{databaseUrl:string}>;
 const pool=new Pool({connectionString:config.databaseUrl,max:config.poolMax,connectionTimeoutMillis:5000,application_name:'showwork-canonical-vps'});
 const storageClient=clients?.storageClient??new S3Client({endpoint:config.endpoint,region:'auto',credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED'});
 const database=createPublishingTransactionDatabase(pool as unknown as PublishingPool,{schema:config.schema});
 try{
  await database.transaction(async tx=>{const ownership=(await tx.query('SELECT state,enabled,epoch FROM "PublishingOwnership" WHERE id=1')).rows[0];if(!ownership?.enabled||ownership.state!==(mode==='publish'?'VPS':'DRAINING')||BigInt(ownership.epoch)!==config.epoch)throw Error('NATIVE_HOST_OWNERSHIP_REJECTED');});
  const providerFetch:typeof fetch=(url,init)=>{
   if(mode==='reconcile'){
    const endpoint=new URL(typeof url==='string'?url:url instanceof Request?url.url:String(url)),method=(init?.method??'GET').toUpperCase();
    const readonly=method==='GET'||method==='HEAD',auxiliary=method==='POST'&&((endpoint.hostname==='open.tiktokapis.com'&&['/v2/post/publish/status/fetch/','/v2/oauth/token/'].includes(endpoint.pathname))||(endpoint.hostname==='api.x.com'&&endpoint.pathname==='/2/oauth2/token')||(endpoint.hostname==='www.linkedin.com'&&endpoint.pathname==='/oauth/v2/accessToken'));
    if(!readonly&&!auxiliary)throw Error('RECONCILIATION_PUBLICATION_FORBIDDEN');
   }
   return fetch(url,init);
  };
  const storage=createPublishingObjectStorage({client:storageClient,bucket:config.bucket,prefix:config.prefix});
  const validation=createPublishingValidationAdapters({database,verifyViewer:async()=>{throw Error('WORKER_VIEWER_AUTHORITY_FORBIDDEN');},verifyRetryEvidence:async()=>{throw Error('TRUSTED_RETRY_RECONCILIATION_REQUIRED');}});
  const coordination=createPublishingCoordination({database,validation}),accounts=createShowworkPublishingAccounts({database,accountFetch:providerFetch},validation,coordination),credential=createCanonicalCredentialResolver(database);
  const mediaUrl=(key:string)=>config.origin.replace(/\/$/,'')+'/'+key.split('/').map(encodeURIComponent).join('/');
  const worker=createNativeCanonicalPublishingWorker({database,validation,spool:createSharedPublishingJournal(storage.journal),actor:'vps-worker',epoch:config.epoch,publishingEnabled:true,fetch:providerFetch,versions:config.versions,concurrency:config.concurrency,jobTimeoutMs:60000,preparedLeaseMs:clients?.preparedLeaseMs,rates:{creator:10,init:5,status:20},materialize:storage.materialize,preparationCache:{read:storage.readPreparation,write:storage.writePreparation},
   refresh:async(target,options)=>{await accounts.ensureFreshAccount(target,options);},
   creatorInfo:async target=>accounts.accountIO(async()=>queryTikTokCreatorInfo((await credential(target)).token)),
   media:async(target,assets,creator)=>{const pins=await database.transaction(async tx=>(await tx.query('SELECT * FROM "PublishingMediaSnapshot" WHERE "jobId"=$1',[target.jobId])).rows),urls:string[]=[];for(const asset of assets){const pin=pins.find(p=>p.assetId===asset.id&&p.blobKey===asset.fileKey);if(!pin)throw Error('IMMUTABLE_MEDIA_PIN_MISSING');let key=pin.blobKey;if(target.platform==='TIKTOK'){if(!creator)throw Error('CURRENT_TIKTOK_CREATOR_REQUIRED');const source=await storage.readPinned(pin.blobKey,pin.contentSha256),prepared=await prepareCanonicalTikTokMedia({...source,fileKey:pin.sourceKey,mediaType:String(asset.mediaType),creator});if(prepared)key=await storage.storePrepared(target.jobId,String(asset.id),prepared.bytes,prepared.type);}urls.push(mediaUrl(key));}return urls;},
   readMedia:async(target,source)=>{const pins=await database.transaction(async tx=>(await tx.query('SELECT * FROM "PublishingMediaSnapshot" WHERE "jobId"=$1',[target.jobId])).rows);const pin=pins.find(p=>mediaUrl(p.blobKey)===source);if(!pin)throw Error('IMMUTABLE_MEDIA_URL_REQUIRED');return storage.readPinned(pin.blobKey,pin.contentSha256);},
   sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
  const uninstall=installDisabledPublishingApplication({host:'VPS',publishingEnabled:false,invoke:async()=>{throw Error('WORKER_CANNOT_INVOKE_APPLICATION_HANDLERS');}});
  const projection=createCanonicalStatusProjection({database,validation});
  async function repairProjections(){
   const ids=await database.transaction(async tx=>{
    const reports=(await tx.query(`SELECT to_regclass('"PublishedSocialPost"') IS NOT NULL AS present`)).rows[0].present;
    return (await tx.query(`SELECT j.id FROM "PublishingJob" j JOIN "PublishingIntent" i ON i.id=j."intentId" JOIN "CalendarPost" p ON p.id=j."postId" JOIN "PublishingCanonicalRevision" r ON r."jobId"=j.id JOIN "PublishingAccountVersion" v ON v."bindingId"=r."accountBindingId" AND v.version=r."accountVersion" WHERE j.phase='CONFIRMED' AND j."intentRevision"=i."currentRevision" AND NOT EXISTS(SELECT 1 FROM "PublishingResourceTombstone" t WHERE (t."resourceType"='POST' AND t."resourceId"=p.id) OR (t."resourceType"='WORKSPACE' AND t."resourceId"=p."calendarId")) AND ((CASE WHEN j.platform='INSTAGRAM' THEN p."instagramPublishStatus"::text WHEN j.platform='TIKTOK' THEN p."tikTokPublishStatus"::text ELSE p."publishStatus"::text END) IS DISTINCT FROM 'PUBLISHED' ${reports?`OR NOT EXISTS(SELECT 1 FROM "PublishedSocialPost" report WHERE report."calendarPostId"=p.id AND report."socialConnectionId"=v."connectionId")`:''}) ORDER BY j."updatedAt",j.id LIMIT 3`)).rows.map(r=>r.id as string);
   });
   for(const id of ids)await projection(canonicalPublicationTarget(await validation.canonicalStore().findJob(id)));
   return ids.length;
  }
  let closing:Promise<void>|undefined;
  return {worker,repairProjections,close:()=>closing??=(async()=>{const result=await worker.close();if(!result.quiescent)throw Error('WORKER_SHUTDOWN_UNSETTLED');uninstall();await pool.end();storageClient.destroy();})()};
 }catch(error){await pool.end();storageClient.destroy();throw error;}
}
