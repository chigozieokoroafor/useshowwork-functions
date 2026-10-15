'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {load}=require('../../tests/helpers/load-typescript.cjs');
// Existing HTTP payload builders and validation run unchanged. ALL fetch calls
// are intercepted in-process. This fixture cannot fall through to the network.
exports.createMockPlatforms=function({delayMs=20,tikTokPending=false}={}){
 const context=new AsyncLocalStorage(),attempts=new Map(),responses=new Map();const original=global.fetch;
 const deny=new Proxy({}, {get(){throw new Error('Provider contract fixture cannot access application database');}});
 const mocks={'@/lib/db':{db:deny},'@/lib/r2':{publicUrlFor:key=>'https://synthetic-media.invalid/'+key}};
 const cache=new Map(),providers=load('lib/publishing/providers.ts',mocks,cache),ig=load('lib/instagram.ts',mocks,cache),tt=load('lib/tiktok.ts',mocks,cache),settings=load('lib/tiktokSettings.ts',mocks,cache),consent=load('lib/tiktokConsent.ts',mocks,cache),state=load('lib/publishing/state.ts',mocks,cache),tokens=load('lib/socialTokens.ts',mocks,cache);
 const creator={creator_nickname:'Synthetic',creator_username:'synthetic',creator_avatar_url:'https://synthetic.invalid/avatar',privacy_level_options:['SELF_ONLY'],comment_disabled:false,duet_disabled:false,stitch_disabled:false,max_video_post_duration_sec:60};
 global.fetch=async(url,init={})=>{
  const job=context.getStore();if(!job)throw new Error('Mock API requires synthetic job context');if(init.signal?.aborted)throw new Error('Mock API aborted');
  const u=new URL(String(url));const allowed=['graph.facebook.com','api.x.com','api.linkedin.com','open.tiktokapis.com'];if(!allowed.includes(u.hostname))throw new Error('Mock API destination denied');
  const publish=u.pathname.endsWith('/media_publish')||u.pathname.endsWith('/feed')||u.pathname==='/2/tweets'||u.pathname==='/rest/posts'||u.pathname.endsWith('/content/init/');
  if(publish){attempts.set(job.id,(attempts.get(job.id)||0)+1);responses.set(job.id,'mock-confirmed-'+job.id);}
  await new Promise(r=>setTimeout(r,delayMs));const id='mock-confirmed-'+job.id;
  if(u.hostname==='open.tiktokapis.com'){
   const data=u.pathname.includes('creator_info')?creator:u.pathname.includes('/status/')?{status:tikTokPending?'PROCESSING_UPLOAD':'PUBLISH_COMPLETE',publicaly_available_post_id:[id]}:{publish_id:'operation-'+job.id};
   return Response.json({error:{code:'ok'},data});
  }
  if(u.hostname==='api.x.com')return Response.json({data:{id}});
  if(u.hostname==='api.linkedin.com')return new Response('',{status:201,headers:{'x-restli-id':id}});
  return Response.json({id,permalink:'https://synthetic.invalid/'+id});
 };
 async function publish(job,signal){return context.run(job,async()=>{
  if(signal.aborted)throw new Error('Aborted before provider');const photo=['INSTAGRAM','TIKTOK'].includes(job.platform);
  const post={id:job.postId,calendarId:'synthetic-calendar',caption:'Synthetic publication '+job.id,cta:null,hashtags:null,taggedAccounts:null,linkUrl:null,postType:'Feed',platformPostId:null,assets:photo?[{id:'asset',fileKey:'synthetic.jpg',mediaType:'PHOTO',displayOrder:0}]:[]};
  state.validatePublishContent(job.platform,post.assets,state.buildCaption(post),post.postType);
  const connection={platform:job.platform,platformAccountId:'synthetic-account',accessToken:'synthetic-token',tokenScopes:'pages_manage_posts pages_read_engagement tweet.write w_member_social video.publish',status:'CONNECTED',accessTokenExpiresAt:new Date(Date.now()+3600000)};
  if(job.platform==='FACEBOOK')return (await providers.publishFacebook(post,connection)).id;
  if(job.platform==='LINKEDIN')return (await providers.publishLinkedIn(post,connection)).id;
  if(job.platform==='X')return (await providers.publishX(post,connection)).id;
  if(job.platform==='INSTAGRAM'){
   const container=await ig.createMediaContainer({igUserId:connection.platformAccountId,pageAccessToken:connection.accessToken,imageUrl:'https://synthetic-media.invalid/synthetic.jpg',caption:post.caption});
   const id=await ig.publishContainer(connection.platformAccountId,container,connection.accessToken);await ig.getMediaPermalink(id,connection.accessToken);return id;
  }
  tokens.requireScopes(connection,['video.publish']);const choices=settings.parseTikTokSettings({...settings.emptyTikTokSettings,privacyLevel:'SELF_ONLY'});
  const hash=consent.tikTokConsentHash(post,choices,connection.platformAccountId);if(hash!==consent.tikTokConsentHash(post,choices,connection.platformAccountId))throw new Error('Consent changed');
  const info=await tt.queryTikTokCreatorInfo(connection.accessToken);settings.validateTikTokSettings(choices,info,false);
  const accepted=await tt.initTikTokPhotoPublish({accessToken:connection.accessToken,photoUrls:['https://synthetic-media.invalid/synthetic.jpg'],caption:post.caption,privacyLevel:choices.privacyLevel,postInfo:settings.tikTokPostInfo(choices,info,false)});
  const status=await tt.checkTikTokPublishStatus(connection.accessToken,accepted.publish_id);
  return status.status==='PUBLISH_COMPLETE'?String(status.publicaly_available_post_id[0]):{state:'accepted',reference:accepted.publish_id};
 });}
 return {publish,attempts,responses,close(){global.fetch=original;}};
};
