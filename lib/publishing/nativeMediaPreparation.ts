/** Native upload protocols extracted from providers.ts. No post-creation endpoints. */
import type { PublicationTarget } from './externalAuthorization';
import type { PreparationOperation, MockProviderResponse } from './capabilityProviders';

export function createNativeMediaPreparation(deps:{
 fetch:(url:string,init:RequestInit)=>Promise<Response>;
 credential(target:PublicationTarget):Promise<{token:string;connectionId:string;providerAccountId:string;accountBindingId:string;accountVersion:number}>;
 // Must read pinned immutable storage, not arbitrary user URLs.
 readMedia(target:PublicationTarget,source:string):Promise<{bytes:Uint8Array;type:string}>;
 sleep(ms:number):Promise<void>; metaVersion:string; linkedinVersion:string; timeoutMs?:number;
}) {
 const timeout=deps.timeoutMs??10000;
 if(!/^v\d+\.\d+$/.test(deps.metaVersion)||!/^\d{6}$/.test(deps.linkedinVersion)||timeout<1||timeout>30000)throw Error('INVALID_MEDIA_CONFIGURATION');
 async function bounded<T>(run:(signal:AbortSignal)=>Promise<T>) {
  const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>;
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('MEDIA_OPERATION_TIMEOUT'));},timeout);});
  try{return await Promise.race([run(controller.signal),expired]);}finally{clearTimeout(timer!);controller.abort();}
 }
 return async(target:PublicationTarget,operation:PreparationOperation,payload:Record<string,unknown>):Promise<MockProviderResponse>=>{
  const expected=operation==='X_MEDIA'?'X':operation==='LI_MEDIA'?'LINKEDIN':operation==='FB_REEL_UPLOAD'?'FACEBOOK':null;
  if(!expected||target.platform!==expected)throw Error('MEDIA_OPERATION_MISMATCH');
  const credential=await bounded(()=>deps.credential(target));
  if(!credential.token||credential.connectionId!==target.connectionId||credential.providerAccountId!==target.providerAccountId||credential.accountBindingId!==target.accountBindingId||credential.accountVersion!==target.accountVersion)throw Error('MEDIA_CREDENTIAL_BINDING_REQUIRED');
  const headers:Record<string,string>={Authorization:`Bearer ${credential.token}`};
  if(expected==='LINKEDIN')Object.assign(headers,{'LinkedIn-Version':deps.linkedinVersion,'X-Restli-Protocol-Version':'2.0.0'});
  async function request(url:string,method:string,body?:RequestInit['body'],extra:Record<string,string>={}) {
   return bounded(async signal=>{
    const response=await deps.fetch(url,{method,headers:{...headers,...extra},body,signal,redirect:'error'});
    const raw=await response.json().catch(()=>({}));
    const value:Record<string,any>=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,any>:{};
    if(!response.ok)throw Error(`MEDIA_PROVIDER_REJECTED_${response.status}`);
    return {value,etag:response.headers.get('etag')};
   });
  }
  const json=(url:string,value:unknown)=>request(url,'POST',JSON.stringify(value),{'Content-Type':'application/json'});
  if(operation==='FB_REEL_UPLOAD') {
   // Construct the native upload URL; never accept a caller-controlled endpoint.
   const id=String(payload.video_id??'');if(!/^\d+$/.test(id)||typeof payload.media!=='string'||!/^https:\/\//.test(payload.media))throw Error('INVALID_REEL_UPLOAD');
   const uploadUrl=new URL(typeof payload.uploadUrl==='string'?payload.uploadUrl:`https://rupload.facebook.com/video-upload/${deps.metaVersion}/${id}`);
   if(uploadUrl.protocol!=='https:'||uploadUrl.hostname!=='rupload.facebook.com'||uploadUrl.username||uploadUrl.password||!uploadUrl.pathname.startsWith('/video-upload/'))throw Error('REEL_UPLOAD_HOST_DENIED');
   await request(uploadUrl.toString(),'POST',undefined,{Authorization:`OAuth ${credential.token}`,file_url:payload.media});
   return {status:200,body:{id}};
  }
  if(typeof payload.media!=='string')throw Error('PINNED_MEDIA_REQUIRED');
  const media=await bounded(()=>deps.readMedia(target,payload.media as string));
  if(!media.bytes.byteLength||media.bytes.byteLength>512*1024*1024||!/^(image|video)\/[a-zA-Z0-9.+-]+$/.test(media.type))throw Error('INVALID_MEDIA_BYTES');
  const video=payload.mediaType==='VIDEO';
  if(operation==='X_MEDIA') {
   const base='https://api.x.com/2/media/upload';
   const initialized=await json(`${base}/initialize`,{media_type:media.type,total_bytes:media.bytes.byteLength,media_category:video?'tweet_video':media.type==='image/gif'?'tweet_gif':'tweet_image'});
   const id=initialized.value.data?.id;if(typeof id!=='string'||!/^\d+$/.test(id))throw Error('X_MEDIA_ID_REQUIRED');
   for(let start=0,segment=0;start<media.bytes.byteLength;start+=4*1024*1024,segment++) {
    const form=new FormData();form.set('segment_index',String(segment));form.set('media',new Blob([Buffer.from(media.bytes.subarray(start,start+4*1024*1024))],{type:media.type}),'chunk');
    await request(`${base}/${id}/append`,'POST',form);
   }
   let result=(await request(`${base}/${id}/finalize`,'POST')).value;
   for(let attempt=0;attempt<40;attempt++) {
    const info=result.data?.processing_info;
    if(!info||info.state==='succeeded')return {status:200,body:{id}};
    if(info.state==='failed')throw Error('X_MEDIA_PROCESSING_FAILED');
    await deps.sleep(Math.min(10,Math.max(1,info.check_after_secs||2))*1000);
    result=(await request(`${base}?command=STATUS&media_id=${id}`,'GET')).value;
   }
   throw Error('X_MEDIA_PROCESSING_TIMEOUT');
  }
  const author=target.providerAccountId.startsWith('urn:li:')?target.providerAccountId:`urn:li:person:${target.providerAccountId}`;
  const resource=video?'videos':'images',base=`https://api.linkedin.com/rest/${resource}`;
  const initialized=await json(`${base}?action=initializeUpload`,{initializeUploadRequest:{owner:author,...(video?{fileSizeBytes:media.bytes.byteLength,uploadCaptions:false,uploadThumbnail:false}:{})}});
  const value=initialized.value.value,id=video?value?.video:value?.image;
  if(typeof id!=='string'||!id.startsWith(`urn:li:${video?'video':'image'}:`))throw Error('LINKEDIN_MEDIA_ID_REQUIRED');
  const parts=video?value.uploadInstructions:value.uploadUrl?[{uploadUrl:value.uploadUrl}]:[];
  if(!Array.isArray(parts)||!parts.length||parts.length>1000)throw Error('LINKEDIN_UPLOAD_PARTS_REQUIRED');
  const partIds:string[]=[];
  for(const part of parts) {
   const url=new URL(part.uploadUrl);
   if(url.protocol!=='https:'||!(url.hostname==='linkedin.com'||url.hostname.endsWith('.linkedin.com'))||url.username||url.password)throw Error('LINKEDIN_UPLOAD_HOST_DENIED');
   const first=video?part.firstByte:0,last=video?part.lastByte:media.bytes.byteLength-1;
   if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<0||last<first||last>=media.bytes.byteLength)throw Error('LINKEDIN_UPLOAD_RANGE_INVALID');
   const uploaded=await request(url.toString(),'PUT',Buffer.from(media.bytes.subarray(first,last+1)),{'Content-Type':media.type});
   if(video&&!uploaded.etag)throw Error('LINKEDIN_UPLOAD_ACK_REQUIRED');
   if(uploaded.etag)partIds.push(uploaded.etag.replace(/"/g,''));
  }
  if(video) {
   await json(`${base}?action=finalizeUpload`,{finalizeUploadRequest:{video:id,uploadToken:value.uploadToken??'',uploadedPartIds:partIds}});
   for(let attempt=0;attempt<40;attempt++) {
    const status=(await request(`${base}/${encodeURIComponent(id)}`,'GET')).value.status;
    if(status==='AVAILABLE')return {status:200,body:{id}};
    if(status==='PROCESSING_FAILED')throw Error('LINKEDIN_MEDIA_PROCESSING_FAILED');
    await deps.sleep(3000);
   }
   throw Error('LINKEDIN_MEDIA_PROCESSING_TIMEOUT');
  }
  return {status:200,body:{id}};
 };
}
