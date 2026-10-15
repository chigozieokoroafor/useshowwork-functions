'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const sharp=require('sharp');
exports.createMockSocialApis=async function(options={}){
 const scope=new AsyncLocalStorage(),attempts=new Map(),accepted=new Map(),statusReads=new Map(),failures=new Map(),uploads=new Map(),operations=[];
 const original=global.fetch,envKeys=['TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET','X_CLIENT_ID','X_CLIENT_SECRET','LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET'];const env=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));for(const key of envKeys)process.env[key]='synthetic-staging-only';
 const photo=await sharp({create:{width:640,height:360,channels:3,background:'#467989'}}).png().toBuffer();let converted=0;
 const creator={creator_nickname:'Synthetic',creator_username:'synthetic',creator_avatar_url:'https://synthetic.invalid/avatar',privacy_level_options:['SELF_ONLY'],comment_disabled:false,duet_disabled:false,stitch_disabled:false,max_video_post_duration_sec:60};
 const json=(value,status=200,headers={})=>Response.json(value,{status,headers});
 global.fetch=async(input,init={})=>{
  const u=new URL(typeof input==='string'?input:input.url??input.href),job=scope.getStore();if(init.signal?.aborted)throw Error('Mock request aborted');
  if(!['synthetic-media.invalid','synthetic-upload.invalid','graph.facebook.com','graph-video.facebook.com','rupload.facebook.com','api.x.com','api.linkedin.com','www.linkedin.com','open.tiktokapis.com'].includes(u.hostname))throw Error('Mock egress denied');
  let body={};try{body=typeof init.body==='string'?JSON.parse(init.body):{};}catch{}
  const method=(init.method||'GET').toUpperCase(),text=typeof init.body==='string'?init.body:'';
  const publishing=method==='POST'&&(u.pathname.endsWith('/media_publish')||u.pathname.endsWith('/feed')||u.hostname==='graph-video.facebook.com'&&u.pathname.endsWith('/videos')||u.pathname.endsWith('/video_reels')&&text.includes('"finish"')||u.pathname==='/2/tweets'||u.pathname==='/rest/posts'||/\/(content|video)\/init\/$/.test(u.pathname));
  if(publishing){if(!job)throw Error('Synthetic publication identity required');attempts.set(job,(attempts.get(job)||0)+1);await options.onAttempt?.(job);
   if(options.reject?.has(job)){failures.set(job,'definite-rejection');return u.hostname==='open.tiktokapis.com'?json({error:{code:'scope_not_authorized'},data:{}},400):json({error:{message:'Synthetic definitive rejection'}},400);}
   accepted.set(job,'published-'+job);await options.onAccepted?.(job);if(options.lostReply?.has(job))throw Error('Synthetic accepted request lost its reply');
  }
  operations.push({kind:publishing?'publish':u.pathname.includes('oauth')?'refresh':u.pathname.includes('status')?'status':'media-or-read',platform:u.hostname,postId:job??null});
  if(options.delayMs)await new Promise(r=>setTimeout(r,options.delayMs));
  if(u.hostname==='synthetic-media.invalid'){
   const data=uploads.get(u.pathname.slice(1))||photo;
   if(method==='HEAD')return new Response(null,{headers:{'content-length':String(data.length),'content-type':u.pathname.endsWith('.mp4')?'video/mp4':'image/png'}});
   const range=init.headers?.Range;if(range){const match=range.match(/bytes=(\d+)-(\d+)/);return new Response(data.subarray(Number(match[1]),Number(match[2])+1),{status:206,headers:{'content-type':'image/png'}});}
   return new Response(data,{headers:{'content-type':'image/png','content-length':String(data.length)}});
  }
  if(u.hostname==='synthetic-upload.invalid')return new Response(null,{status:200,headers:{etag:'synthetic-etag'}});
  if(u.pathname.includes('oauth')||u.pathname.includes('/oauth2/token')){
   const fields=new URLSearchParams(init.body);const account=(fields.get('refresh_token')||'').replace(/^synthetic-refresh-/,'');
   return json({open_id:account,access_token:'refreshed-'+account,refresh_token:'rotated-'+account,expires_in:3600,refresh_expires_in:86400,scope:'video.publish tweet.write media.write w_member_social'});
  }
  if(u.hostname==='open.tiktokapis.com'){
   let data;
   if(u.pathname.includes('creator_info'))data=creator;
   else if(u.pathname.includes('/status/')){await options.onStatus?.(job);const n=(statusReads.get(job)||0)+1;statusReads.set(job,n);data={status:options.failedStatus?.has(job)?'FAILED':n<=(options.pendingReads??1)?'PROCESSING_UPLOAD':'PUBLISH_COMPLETE',fail_reason:'synthetic_terminal_failure',publicaly_available_post_id:['published-'+job]};}
   else data={publish_id:'operation-'+job};
   return json({error:{code:'ok'},data});
  }
  if(u.hostname==='api.x.com'){
   if(u.pathname.includes('/initialize'))return json({data:{id:'upload-'+job}});
   if(u.pathname.includes('/append')||u.pathname.includes('/finalize'))return json({data:{processing_info:{state:'succeeded'}}});
   return json({data:{id:'published-'+job}});
  }
  if(u.hostname==='api.linkedin.com'){
   if(u.search.includes('initializeUpload'))return json({value:{image:'urn:li:image:'+job,video:'urn:li:video:'+job,uploadUrl:'https://synthetic-upload.invalid/'+job,uploadInstructions:[{uploadUrl:'https://synthetic-upload.invalid/'+job,firstByte:0,lastByte:(body.initializeUploadRequest?.fileSizeBytes??photo.length)-1}],uploadToken:'synthetic-upload'}});
   if(method==='GET')return json({status:'AVAILABLE'});
   return new Response('',{status:201,headers:{'x-restli-id':'published-'+job}});
  }
  if(u.hostname==='rupload.facebook.com')return json({success:true});
  if(u.pathname.endsWith('/video_reels')&&!publishing)return json({video_id:'published-'+job,upload_url:'https://rupload.facebook.com/synthetic/'+job});
  if(u.searchParams.get('fields')==='status')return json({status:{video_status:'ready',publishing_phase:{status:'complete'}}});
  if(u.searchParams.get('fields')?.includes('status_code'))return json({status_code:'FINISHED',status:'Finished'});
  return json({id:publishing?'published-'+job:'container-'+job,permalink:'https://synthetic.invalid/published/'+job});
 };
 const mockedFetch=global.fetch;
 global.fetch=async(input,init={})=>{const started=performance.now();try{return await mockedFetch(input,init);}finally{const u=new URL(typeof input==='string'?input:input.url??input.href);options.onRequestTiming?.({postId:scope.getStore(),host:u.hostname,durationMs:performance.now()-started});}};
 return {run:(id,fn)=>scope.run(id,fn),seedMedia:(key,bytes)=>uploads.set(key,Buffer.from(bytes)),attempts,accepted,operations,failures,statusReads,storage:{publicUrlFor:key=>'https://synthetic-media.invalid/'+key,putTikTokPreparedFile:async(key,bytes)=>{converted++;uploads.set(key,Buffer.from(bytes));}},get converted(){return converted;},close(){global.fetch=original;for(const key of envKeys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}};
};
