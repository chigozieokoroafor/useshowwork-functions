import {createHash} from 'node:crypto';
import {GetObjectCommand,PutObjectCommand,ListObjectsV2Command,HeadObjectCommand,DeleteObjectCommand,ListPartsCommand,CompleteMultipartUploadCommand,type S3Client} from '@aws-sdk/client-s3';
import type {SharedJournalStorage} from './sharedJournal';
import {policyHash} from './eligibilityPolicy';

/** Injected client only; no credential loading, connection or request on construction. */
export function createPublishingObjectStorage(deps:{client:Pick<S3Client,'send'>;bucket:string;prefix:string;maxMediaBytes?:number}) {
 if(!deps.bucket||!/^publishing\/[A-Za-z0-9_-]+\/$/.test(deps.prefix))throw Error('PUBLISHING_STORAGE_CONFIGURATION_REQUIRED');
 const limit=deps.maxMediaBytes??512*1024*1024;
 if(!Number.isSafeInteger(limit)||limit<1||limit>512*1024*1024)throw Error('INVALID_MEDIA_LIMIT');
 const key=(value:string)=>{if(!/^[A-Za-z0-9_./-]+$/.test(value)||value.split('/').some(segment=>segment==='..'||segment==='.')||value.startsWith('/'))throw Error('UNSAFE_OBJECT_KEY');return deps.prefix+value;};
 async function read(value:string,version?:string,max=4096,source=false) {
  // Application fileKey is already a complete source key. Prefix only evidence/copies.
  const storageKey=source?key(value).slice(deps.prefix.length):key(value);
  const conditional=version?.startsWith('etag:')?version.slice(5):undefined;
  if(conditional&&!/^"[A-Za-z0-9_-]+"$/.test(conditional))throw Error('STRONG_OBJECT_ETAG_REQUIRED');
  const response=await deps.client.send(new GetObjectCommand({Bucket:deps.bucket,Key:storageKey,...(conditional?{IfMatch:conditional}:version?{VersionId:version}:{})}),{abortSignal:AbortSignal.timeout(30000)});
  if(!response.Body||response.ContentLength===undefined||response.ContentLength>max)throw Error('STORAGE_OBJECT_LENGTH_REQUIRED');
  let length=0;const chunks:Buffer[]=[];
  for await(const chunk of response.Body as AsyncIterable<Uint8Array>){length+=chunk.byteLength;if(length>max)throw Error('STORAGE_OBJECT_TOO_LARGE');chunks.push(Buffer.from(chunk));}
  if(length!==response.ContentLength)throw Error('STORAGE_OBJECT_TRUNCATED');
  const actualVersion=conditional?response.ETag?'etag:'+response.ETag:undefined:response.VersionId??(response.ETag?'etag:'+response.ETag:undefined);
  return {bytes:Buffer.concat(chunks),version:actualVersion,type:response.ContentType??'application/octet-stream'};
 }
 const journal:SharedJournalStorage={
  async putIfAbsent(value,body) {
   if(!/^publishing\/[A-Za-z0-9_-]+\/[a-f0-9]{64}$/.test(value)||Buffer.byteLength(body)>4096)throw Error('INVALID_JOURNAL_OBJECT');
   try {await deps.client.send(new PutObjectCommand({Bucket:deps.bucket,Key:key(value),Body:body,ContentType:'application/json',IfNoneMatch:'*'}),{abortSignal:AbortSignal.timeout(30000)});}
   catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==412)throw error;}
   const stored=(await read(value)).bytes.toString('utf8');
   if(stored!==body){
    let equivalent=false;try{equivalent=policyHash(JSON.parse(stored))===policyHash(JSON.parse(body));}catch{/* Non-JSON evidence still requires exact bytes. */}
    if(!equivalent)throw Error('JOURNAL_STORAGE_CONFLICT');
   }
   return {durablyCommitted:true};
  },
  async read(value){return (await read(value)).bytes.toString('utf8');},
  async list(value) {
   if(!/^publishing\/[A-Za-z0-9_-]+\/$/.test(value))throw Error('INVALID_JOURNAL_PREFIX');
   let token:string|undefined;const values:string[]=[];
   do {const page=await deps.client.send(new ListObjectsV2Command({Bucket:deps.bucket,Prefix:key(value),ContinuationToken:token}),{abortSignal:AbortSignal.timeout(30000)});
    for(const item of page.Contents??[])if(item.Key)values.push(item.Key.slice(deps.prefix.length));
    if(values.length>10000)throw Error('JOURNAL_LIST_LIMIT');
    token=page.IsTruncated?page.NextContinuationToken:undefined;if(page.IsTruncated&&!token)throw Error('JOURNAL_PAGINATION_INVALID');
   }while(token);return values.sort();
  }
 };
 async function materialize(input:{jobId:string;assetId:string;sourceKey:string;objectVersion:string;contentSha256:string}) {
  if(!/^[A-Za-z0-9_-]+$/.test(input.jobId)||!/^[A-Za-z0-9_-]+$/.test(input.assetId)||!/^[a-f0-9]{64}$/.test(input.contentSha256))throw Error('INVALID_MEDIA_IDENTITY');
  const source=await read(input.sourceKey,input.objectVersion,limit,true);
  if(source.version!==input.objectVersion||createHash('sha256').update(source.bytes).digest('hex')!==input.contentSha256)throw Error('MEDIA_SOURCE_CHANGED');
  const blobKey=`publishing/${input.jobId}/${input.assetId}/${input.contentSha256}`;
  // Pins record the actual physical key used by native URL/media readers.
  try {await deps.client.send(new PutObjectCommand({Bucket:deps.bucket,Key:blobKey,Body:source.bytes,ContentType:source.type,IfNoneMatch:'*'}),{abortSignal:AbortSignal.timeout(30000)});}
  catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==412)throw error;}
  const copied=await read(blobKey,undefined,limit,true);
  if(createHash('sha256').update(copied.bytes).digest('hex')!==input.contentSha256)throw Error('IMMUTABLE_MEDIA_COPY_CONFLICT');
  return {blobKey,objectVersion:input.objectVersion,contentSha256:input.contentSha256};
 }
 async function verifySource(sourceKey:string,version?:string){const source=await read(sourceKey,version,limit,true);if(!source.version||source.version.startsWith('etag:')&&!/^etag:"[A-Za-z0-9_-]+"$/.test(source.version))throw Error('VERIFIED_SOURCE_VERSION_REQUIRED');if(version&&source.version!==version)throw Error('MEDIA_SOURCE_CHANGED');return {objectVersion:source.version,contentSha256:createHash('sha256').update(source.bytes).digest('hex'),sizeBytes:String(source.bytes.length),mediaType:source.type.startsWith('video/')?'VIDEO' as const:source.type.startsWith('image/')?'PHOTO' as const:(()=>{throw Error('INVALID_SOURCE_MEDIA_TYPE');})()};}
 const originalKey=(value:string)=>{const checked=key(value).slice(deps.prefix.length);if(checked.startsWith('publishing/'))throw Error('IMMUTABLE_STORAGE_OPERATION_FORBIDDEN');return checked;};
 async function originalVersion(value:string){try{const object=await deps.client.send(new HeadObjectCommand({Bucket:deps.bucket,Key:originalKey(value)}),{abortSignal:AbortSignal.timeout(30000)});const version=object.VersionId??(object.ETag?'etag:'+object.ETag:null);if(!version)throw Error('ORIGINAL_VERSION_REQUIRED');return version;}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)return null;throw error;}}
 async function deleteOriginalVersion(value:string,version:string){if(version.startsWith('etag:')&&!/^etag:"[A-Za-z0-9_-]+"$/.test(version))throw Error('STRONG_OBJECT_ETAG_REQUIRED');if(!version)throw Error('ORIGINAL_VERSION_REQUIRED');await deps.client.send(new DeleteObjectCommand({Bucket:deps.bucket,Key:originalKey(value),...(version.startsWith('etag:')?{IfMatch:version.slice(5)}:{VersionId:version})}),{abortSignal:AbortSignal.timeout(30000)});}
 async function completeOriginalMultipart(value:string,uploadId:string,parts:{PartNumber:number;ETag:string}[]){
  if(!uploadId||parts.length<1||parts.length>10000||parts.some((part,index)=>part.PartNumber!==index+1))throw Error('INVALID_MULTIPART_COMPLETION');
  const storageKey=originalKey(value),uploaded:{PartNumber:number;ETag:string}[]=[];let marker:string|undefined,pages=0;
  do{if(++pages>100)throw Error('MULTIPART_PAGE_LIMIT');const page=await deps.client.send(new ListPartsCommand({Bucket:deps.bucket,Key:storageKey,UploadId:uploadId,PartNumberMarker:marker}),{abortSignal:AbortSignal.timeout(30000)});for(const part of page.Parts??[])if(part.PartNumber&&part.ETag)uploaded.push({PartNumber:part.PartNumber,ETag:part.ETag});if(uploaded.length>10000)throw Error('MULTIPART_PART_LIMIT');marker=page.IsTruncated?page.NextPartNumberMarker===undefined?(()=>{throw Error('MULTIPART_PAGINATION_INVALID');})():String(page.NextPartNumberMarker):undefined;}while(marker);
  uploaded.sort((a,b)=>a.PartNumber-b.PartNumber);if(uploaded.length!==parts.length||uploaded.some((part,index)=>part.PartNumber!==parts[index].PartNumber))throw Error('MULTIPART_PARTS_INCOMPLETE');
  await deps.client.send(new CompleteMultipartUploadCommand({Bucket:deps.bucket,Key:storageKey,UploadId:uploadId,MultipartUpload:{Parts:uploaded}}),{abortSignal:AbortSignal.timeout(30000)});
 }
 async function readPinned(blobKey:string,contentSha256:string){
  if(!/^publishing\/[A-Za-z0-9_-]+\//.test(blobKey)||!/^[a-f0-9]{64}$/.test(contentSha256))throw Error('INVALID_MEDIA_PIN');
  const value=await read(blobKey,undefined,limit,true);
  if(createHash('sha256').update(value.bytes).digest('hex')!==contentSha256)throw Error('IMMUTABLE_MEDIA_COPY_CONFLICT');
  return {bytes:value.bytes,type:value.type};
 }
 async function storePrepared(jobId:string,assetId:string,bytes:Buffer,type:'image/jpeg'|'video/mp4'){
  if(!/^[A-Za-z0-9_-]+$/.test(jobId)||!/^[A-Za-z0-9_-]+$/.test(assetId)||!bytes.length||bytes.length>limit)throw Error('INVALID_PREPARED_MEDIA');
  const hash=createHash('sha256').update(bytes).digest('hex'),blobKey=`publishing/${jobId}/${assetId}/${hash}.${type==='image/jpeg'?'jpg':'mp4'}`;
  try{await deps.client.send(new PutObjectCommand({Bucket:deps.bucket,Key:blobKey,Body:bytes,ContentType:type,IfNoneMatch:'*'}),{abortSignal:AbortSignal.timeout(30000)});}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==412)throw error;}
  await readPinned(blobKey,hash);return blobKey;
 }
 const preparationKey=(jobId:string,requestHash:string)=>{
  if(!/^[A-Za-z0-9_-]+$/.test(jobId)||!/^[a-f0-9]{64}$/.test(requestHash))throw Error('INVALID_PROVIDER_PREPARATION_KEY');
  return `publishing/preparation-${jobId}/${requestHash}`;
 };
 async function readPreparation(jobId:string,requestHash:string){
  try{return JSON.parse((await read(preparationKey(jobId,requestHash))).bytes.toString('utf8'));}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)return null;throw error;}
 }
 async function writePreparation(jobId:string,requestHash:string,response:unknown){
  await journal.putIfAbsent(preparationKey(jobId,requestHash),JSON.stringify(response));
 }
 return {journal,materialize,verifySource,originalVersion,deleteOriginalVersion,completeOriginalMultipart,readPinned,storePrepared,readPreparation,writePreparation};
}
