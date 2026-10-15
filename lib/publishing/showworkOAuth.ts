/** Existing signed OAuth/selection services, joined to canonical account actions. */
import {NextRequest,NextResponse} from 'next/server';
import {verifyChannelOAuthState,channelOAuthCookieOptions,xPkceCookieName,createChannelOAuthState,type PublishingChannel} from '../channelOAuthState';
import {exchangeChannelCode,getXMember,getLinkedInMember,exchangeForLongLivedFacebookToken,getFacebookPages,getFacebookGrantedPermissions} from '../channelOAuth';
import {createFacebookPageSelection,verifyFacebookPageSelection,facebookPageSelectionCookieName,facebookPageSelectionCookieOptions} from '../facebookPageSelection';
import {appUrl} from '../url';
import {policyHash} from './eligibilityPolicy';
import {createPublishingValidationAdapters,type ValidationDependencies} from './validationAdapters';
import type {createCanonicalApplicationActions} from './applicationActions';
import type {OwnershipDatabase} from './ownership';
import {withPublishingAccountIO} from './executionContext';
import {buildInstagramAuthUrl,exchangeCodeForToken,exchangeForLongLivedToken,listManagedPages,listInstagramGrantedPermissions,getInstagramUsername} from '../instagram';
import {exchangeCodeForTikTokTokens,getTikTokDisplayName} from '../tiktok';
import {readTikTokVerifier,TIKTOK_PKCE_COOKIE} from '../tiktokOAuthPkce';
import {linkedInPages} from '../linkedin/pages';
import {linkedInMessagingAccess} from '../linkedin/messagingAccess';
import type {SocialConnection} from '@prisma/client';

export function createCanonicalShowworkOAuth(deps:{database:OwnershipDatabase;actions:ReturnType<typeof createCanonicalApplicationActions>;policy:ValidationDependencies;
 authenticate():Promise<{id:string}|null>;fetch?:typeof globalThis.fetch;services?:Partial<{exchange:typeof exchangeChannelCode;xMember:typeof getXMember;linkedinMember:typeof getLinkedInMember;linkedinPages:typeof linkedInPages;facebookLong:typeof exchangeForLongLivedFacebookToken;facebookPages:typeof getFacebookPages;facebookPermissions:typeof getFacebookGrantedPermissions;instagramExchange:typeof exchangeCodeForToken;instagramLong:typeof exchangeForLongLivedToken;instagramPages:typeof listManagedPages;instagramPermissions:typeof listInstagramGrantedPermissions;instagramUsername:typeof getInstagramUsername;tiktokExchange:typeof exchangeCodeForTikTokTokens;tiktokName:typeof getTikTokDisplayName}>}) {
 const defaults={exchange:exchangeChannelCode,xMember:getXMember,linkedinMember:getLinkedInMember,linkedinPages:linkedInPages,facebookLong:exchangeForLongLivedFacebookToken,facebookPages:getFacebookPages,facebookPermissions:getFacebookGrantedPermissions,instagramExchange:exchangeCodeForToken,instagramLong:exchangeForLongLivedToken,instagramPages:listManagedPages,instagramPermissions:listInstagramGrantedPermissions,instagramUsername:getInstagramUsername,tiktokExchange:exchangeCodeForTikTokTokens,tiktokName:getTikTokDisplayName};
 const services=Object.fromEntries(Object.entries(defaults).map(([key,native])=>[key,(...args:any[])=>{const override=(deps.services as Record<string,Function>|undefined)?.[key];if(override)return override(...args);if(!deps.fetch)throw Error('EXPLICIT_ACCOUNT_HTTP_REQUIRED');return withPublishingAccountIO({fetch:deps.fetch,signal:AbortSignal.timeout(30000)},()=>Reflect.apply(native,null,args));}])) as typeof defaults;
 const validation=createPublishingValidationAdapters(deps.policy);
 const expires=(seconds?:number)=>seconds&&Number.isFinite(seconds)?new Date(Date.now()+seconds*1000):null;
 async function bounded<T>(run:()=>Promise<T>){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([run(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('OAUTH_PENDING_RECONNECT_REQUIRED')),30000);})]);}finally{clearTimeout(timer!);}}
 return async(entrypoint:string,args:readonly unknown[]):Promise<Response|undefined>=>{
  const path=entrypoint.split('#')[0];if(!['app/api/calendars/channels/[channel]/callback/route.ts','app/api/calendars/[id]/channels/facebook/select-page/route.ts','app/api/calendars/[id]/channels/linkedin/pages/route.ts','app/api/calendars/[id]/instagram/connect/route.ts','app/api/calendars/[id]/instagram/select-account/route.ts','app/api/calendars/instagram/callback/route.ts','app/api/calendars/tiktok/callback/route.ts'].includes(path))return;
  const request=args[0] as NextRequest,params=await (args[1] as {params:Promise<Record<string,string>>})?.params??{},creator=await deps.authenticate();
  if(!creator)return NextResponse.redirect(appUrl()+'/login',303);
  if(path.endsWith('/instagram/select-account/route.ts')){
   const ticketId=request.cookies.get('showwork_instagram_account_selection')?.value;
   const ticket=await deps.database.transaction(async tx=>{await validation.validateWorkspacePermission(tx,{actor:creator.id,calendarId:params.id,permission:'channels.manage'});return (await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1 AND actor=$2`,[ticketId,creator.id])).rows[0];});
   const selection=verifyFacebookPageSelection(ticket?.result?.encryptedSelection);
   if(!selection||selection.calendarId!==params.id)return NextResponse.json({error:'The account selection expired. Reconnect Instagram.'},{status:409});
   const binding=await deps.database.transaction(async tx=>(await tx.query(`SELECT * FROM "PublishingAccountBinding" WHERE "calendarId"=$1 AND platform='INSTAGRAM'`,[params.id])).rows[0]);
   const options=selection.pages.map(page=>({...JSON.parse(page.id) as {pageId:string;accountId:string},name:page.name}));
   if(request.method==='GET')return NextResponse.json({accounts:options,expectedVersion:binding?.currentVersion??0},{headers:{'Cache-Control':'no-store'}});
   if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Invalid request origin.'},{status:403});
   const body=await request.clone().json(),operationId=request.headers.get('idempotency-key'),index=options.findIndex(option=>option.accountId===body.accountId);
   if(!operationId||!Number.isSafeInteger(body.expectedVersion)||index<0)return NextResponse.json({error:'Select the exact account and current connection revision.'},{status:400});
   const option=options[index],page=selection.pages[index],name=await bounded(()=>services.instagramUsername(option.accountId,page.accessToken));
   await deps.actions.bindVerifiedAccount({operationId,actor:creator.id,calendarId:params.id,platform:'INSTAGRAM',expectedAccountVersion:body.expectedVersion,selectionOperationId:ticketId,operationRequest:{selectionId:ticketId,accountId:option.accountId,expectedVersion:body.expectedVersion},evidence:{platform:'INSTAGRAM',providerAccountId:option.accountId,connectionId:policyHash({calendarId:params.id,platform:'INSTAGRAM',id:option.accountId}).slice(0,40),accessToken:page.accessToken,expiresAt:selection.userTokenExpiresAt?new Date(selection.userTokenExpiresAt):null,tokenScopes:selection.grantedPermissions.join(','),accountName:name,username:name,instagramPageId:option.pageId}});
   const response=NextResponse.json({ok:true,accountName:name});response.cookies.set('showwork_instagram_account_selection','',facebookPageSelectionCookieOptions(0));return response;
  }
  if(path.endsWith('/channels/linkedin/pages/route.ts')){
   const stored=await deps.database.transaction(async tx=>{await validation.validateWorkspacePermission(tx,{actor:creator.id,calendarId:params.id,permission:'channels.manage'});return (await tx.query(`SELECT s.*,b."currentVersion" FROM "PublishingAccountBinding" b JOIN "PublishingAccountVersion" v ON v."bindingId"=b.id AND v.version=b."currentVersion" JOIN "SocialConnection" s ON s.id=v."connectionId" WHERE b."calendarId"=$1 AND b.platform='LINKEDIN' AND b.state='CONNECTED' AND s.status='CONNECTED'`,[params.id])).rows[0];});
   if(!stored||!stored.accessToken||stored.accessTokenExpiresAt&&stored.accessTokenExpiresAt<=new Date())throw Error('RECONNECT_LINKEDIN_REQUIRED');
   if(request.method==='GET'){
    if(request.nextUrl.searchParams.get('capabilities')==='true'){const scopes=new Set((stored.tokenScopes??'').split(/[\s,]+/)),page=stored.platformAccountId.startsWith('urn:li:organization:'),messaging=linkedInMessagingAccess(stored as SocialConnection);return NextResponse.json({accountType:page?'Company Page':'Personal profile',publishing:scopes.has(page?'w_organization_social':'w_member_social'),analytics:scopes.has(page?'rw_organization_admin':'r_member_postAnalytics'),messaging:messaging.available,messagingNote:messaging.reason});}
    return NextResponse.json({pages:await bounded(()=>services.linkedinPages(stored as SocialConnection))});
   }
   if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Invalid request origin.'},{status:403});
   const body=await request.clone().json(),operationId=request.headers.get('idempotency-key');if(!operationId)throw Error('Stable operation ID required');
   const member=await bounded(()=>services.linkedinMember(stored.accessToken)),page=body.pageId==='personal'?{id:member.sub,name:member.name??'LinkedIn member'}:(await bounded(()=>services.linkedinPages(stored as SocialConnection))).find(p=>p.id===body.pageId);
   if(!page)return NextResponse.json({error:'Select a Page you currently administer.'},{status:403});
   await deps.actions.bindVerifiedAccount({operationId,actor:creator.id,calendarId:params.id,platform:'LINKEDIN',expectedAccountVersion:stored.currentVersion,operationRequest:{pageId:body.pageId},evidence:{connectionId:policyHash({calendarId:params.id,platform:'LINKEDIN',providerAccountId:page.id}).slice(0,40),providerAccountId:page.id,platform:'LINKEDIN',accessToken:stored.accessToken,expiresAt:stored.accessTokenExpiresAt,refreshToken:stored.refreshToken??undefined,refreshTokenExpiresAt:stored.refreshTokenExpiresAt??undefined,tokenScopes:stored.tokenScopes??'',accountName:page.name,linkedinMemberId:member.sub}});return NextResponse.json({accountName:page.name});
  }
  if(path.endsWith('/instagram/connect/route.ts')){
   await deps.database.transaction(tx=>validation.validateWorkspacePermission(tx,{actor:creator.id,calendarId:params.id,permission:'channels.manage'}));
   const state=createChannelOAuthState('instagram',params.id),response=NextResponse.redirect(buildInstagramAuthUrl({redirectUri:appUrl()+'/api/calendars/instagram/callback',state:state.state}));response.cookies.set(state.cookieName,state.nonce,channelOAuthCookieOptions('instagram',state.maxAge));return response;
  }
  if(path==='app/api/calendars/instagram/callback/route.ts'||path==='app/api/calendars/tiktok/callback/route.ts'){
   const channel=path.includes('/instagram/')?'instagram':'tiktok',state=request.nextUrl.searchParams.get('state'),calendarId=verifyChannelOAuthState(channel,state,request.cookies.get(`showwork_${channel}_oauth_state`)?.value),code=request.nextUrl.searchParams.get('code');
   if(!calendarId||!code||request.nextUrl.searchParams.get('error'))return NextResponse.json({error:'The OAuth session expired or was denied. Reconnect.'},{status:409});
   const operationId=policyHash({channel,state,actor:creator.id});
   const fresh=await deps.database.transaction(async tx=>{await validation.lockForPolicyChange(tx);await validation.validateWorkspacePermission(tx,{actor:creator.id,calendarId,permission:'channels.manage'});
    if((await tx.query(`SELECT 1 FROM "PublishingApplicationOperation" WHERE "operationId"=$1 AND actor=$2`,[operationId,creator.id])).rows.length)return false;
    if((await tx.query(`SELECT 1 FROM "PublishingApplicationOperation" WHERE "operationId"=$1 AND actor=$2`,[operationId+'-selection',creator.id])).rows.length)return false;
    if((await tx.query(`SELECT 1 FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[operationId+'-oauth'])).rows.length)throw Error('OAUTH_PENDING_RECONNECT_REQUIRED');
    await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[operationId+'-oauth',creator.id,policyHash({calendarId,code}),{exchangeReserved:true}]);return true;
   });
   if(fresh){
    if(channel==='tiktok'){
     const verifier=readTikTokVerifier(request.cookies.get(TIKTOK_PKCE_COOKIE)?.value,request.cookies.get('showwork_tiktok_oauth_state')?.value);if(!verifier)throw Error('TIKTOK_PKCE_REQUIRED');
     const tokens=await bounded(()=>services.tiktokExchange(code,appUrl()+'/api/calendars/tiktok/callback',verifier));if(!tokens.scope.split(/[\s,]+/).includes('video.publish'))throw Error('TIKTOK_PERMISSION_REQUIRED');const name=await bounded(()=>services.tiktokName(tokens.access_token));
     await deps.actions.bindVerifiedAccount({operationId,actor:creator.id,calendarId,platform:'TIKTOK',evidence:{platform:'TIKTOK',providerAccountId:tokens.open_id,connectionId:policyHash({calendarId,platform:'TIKTOK',id:tokens.open_id}).slice(0,40),accessToken:tokens.access_token,refreshToken:tokens.refresh_token,expiresAt:expires(tokens.expires_in),refreshTokenExpiresAt:expires(tokens.refresh_expires_in)??undefined,tokenScopes:tokens.scope,accountName:name,username:name}});
    }else{
     const short=await bounded(()=>services.instagramExchange(code,appUrl()+'/api/calendars/instagram/callback')),tokens=await bounded(()=>services.instagramLong(short.access_token)),pages=await bounded(()=>services.instagramPages(tokens.access_token)),permissions=await bounded(()=>services.instagramPermissions(tokens.access_token));
     const candidates=pages.filter(p=>p.instagram_business_account),existing=await deps.database.transaction(async tx=>(await tx.query(`SELECT v."providerAccountId" FROM "PublishingAccountBinding" b JOIN "PublishingAccountVersion" v ON v."bindingId"=b.id AND v.version=b."currentVersion" WHERE b."calendarId"=$1 AND b.platform='INSTAGRAM'`,[calendarId])).rows[0]);
     const selected=existing?candidates.find(p=>p.instagram_business_account!.id===existing.providerAccountId):candidates.length===1?candidates[0]:undefined;
     if(!selected){
      if(!candidates.length)throw Error('INSTAGRAM_ELIGIBLE_ACCOUNT_REQUIRED');
      const selection=createFacebookPageSelection({calendarId,pages:candidates.map(page=>({id:JSON.stringify({pageId:page.id,accountId:page.instagram_business_account!.id}),name:page.instagram_business_account!.id,accessToken:page.access_token})),grantedPermissions:permissions,userTokenExpiresAt:expires(tokens.expires_in??60*24*60*60)?.getTime()??null});
      await deps.database.transaction(async tx=>{await validation.lockForPolicyChange(tx);await validation.validateWorkspacePermission(tx,{actor:creator.id,calendarId,permission:'channels.manage'});await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[operationId+'-selection',creator.id,policyHash({calendarId,channel}),{encryptedSelection:selection.value}]);});
     }else{
     const id=selected.instagram_business_account!.id,name=await bounded(()=>services.instagramUsername(id,selected.access_token));
     await deps.actions.bindVerifiedAccount({operationId,actor:creator.id,calendarId,platform:'INSTAGRAM',evidence:{platform:'INSTAGRAM',providerAccountId:id,connectionId:policyHash({calendarId,platform:'INSTAGRAM',id}).slice(0,40),accessToken:selected.access_token,expiresAt:expires(tokens.expires_in??60*24*60*60),tokenScopes:permissions.join(','),accountName:name,username:name,instagramPageId:selected.id}});
     }
    }
   }
   const awaitingSelection=channel==='instagram'&&await deps.database.transaction(async tx=>(await tx.query(`SELECT 1 FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[operationId+'-selection'])).rows.length>0);
   const response=NextResponse.redirect(appUrl()+(awaitingSelection?`/dashboard/calendars/${calendarId}/instagram/select-account`:`/dashboard/calendars/${calendarId}?view=channels&${channel}Connected=true`));if(awaitingSelection)response.cookies.set('showwork_instagram_account_selection',operationId+'-selection',facebookPageSelectionCookieOptions(600));response.cookies.set(`showwork_${channel}_oauth_state`,'',channelOAuthCookieOptions(channel,0));if(channel==='tiktok')response.cookies.set(TIKTOK_PKCE_COOKIE,'',channelOAuthCookieOptions('tiktok',0));return response;
  }
  if(path.includes('/select-page/')){
   const selection=verifyFacebookPageSelection(request.cookies.get(facebookPageSelectionCookieName())?.value);
   if(!selection||selection.calendarId!==params.id)return NextResponse.json({error:'The account selection expired. Reconnect.'},{status:409});
   const pageId=(await request.clone().formData()).get('pageId'),page=selection.pages.find(p=>p.id===pageId);
   if(!page)return NextResponse.json({error:'Select a verified Page.'},{status:400});
   const operationId=policyHash({selection:request.cookies.get(facebookPageSelectionCookieName())?.value,pageId,actor:creator.id});
   await deps.actions.bindVerifiedAccount({operationId,actor:creator.id,calendarId:selection.calendarId,platform:'FACEBOOK',evidence:{connectionId:policyHash({calendarId:selection.calendarId,platform:'FACEBOOK',account:page.id}).slice(0,40),platform:'FACEBOOK',providerAccountId:page.id,accountName:page.name,accessToken:page.accessToken,tokenScopes:selection.grantedPermissions.join(','),expiresAt:selection.userTokenExpiresAt?new Date(selection.userTokenExpiresAt):null}});
   const response=NextResponse.redirect(appUrl()+`/dashboard/calendars/${selection.calendarId}?view=channels&facebookConnected=true`,303);response.cookies.set(facebookPageSelectionCookieName(),'',facebookPageSelectionCookieOptions(0));return response;
  }
  const channel=params.channel as PublishingChannel;if(!['facebook','linkedin','x'].includes(channel))return NextResponse.json({error:'Unknown publishing channel.'},{status:404});
  const state=request.nextUrl.searchParams.get('state'),calendarId=verifyChannelOAuthState(channel,state,request.cookies.get(`showwork_${channel}_oauth_state`)?.value);
  if(!calendarId)return NextResponse.json({error:'The OAuth state expired. Reconnect.'},{status:409});
  const code=request.nextUrl.searchParams.get('code');if(!code||request.nextUrl.searchParams.get('error'))return NextResponse.redirect(appUrl()+`/dashboard/calendars/${calendarId}?view=channels&${channel}Error=denied`);
  const operationId=policyHash({channel,state,actor:creator.id}),hash=policyHash({channel,calendarId,code});
  const reserved=await deps.database.transaction(async tx=>{
   await validation.lockForPolicyChange(tx);await validation.validateWorkspacePermission(tx,{actor:creator.id,calendarId,permission:'channels.manage'});
   const completed=(await tx.query(`SELECT result FROM "PublishingApplicationOperation" WHERE "operationId"=$1 AND actor=$2`,[operationId,creator.id])).rows[0];if(completed)return false;
   const old=(await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[operationId+'-oauth'])).rows[0];if(old)throw Error('OAUTH_PENDING_RECONNECT_REQUIRED');
   await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[operationId+'-oauth',creator.id,hash,{exchangeReserved:true}]);return true;
  });
  const clear=(response:NextResponse)=>{response.cookies.set(`showwork_${channel}_oauth_state`,'',channelOAuthCookieOptions(channel,0));if(channel==='x')response.cookies.set(xPkceCookieName(),'',{...channelOAuthCookieOptions(channel,0),path:'/api/calendars/channels/x/callback'});return response;};
  if(!reserved)return clear(NextResponse.redirect(appUrl()+`/dashboard/calendars/${calendarId}?view=channels&${channel}Connected=true`));
  const tokens=await bounded(()=>services.exchange({channel,code,redirectUri:appUrl()+`/api/calendars/channels/${channel}/callback`,codeVerifier:channel==='x'?request.cookies.get(xPkceCookieName())?.value:undefined}));
  if(!tokens.access_token)throw Error('OAUTH_TOKEN_REQUIRED');
  if(channel==='facebook'){
   const long=await bounded(()=>services.facebookLong(tokens.access_token)),pages=await bounded(()=>services.facebookPages(long.access_token)),permissions=await bounded(()=>services.facebookPermissions(long.access_token));
   if(!pages.length)throw Error('FACEBOOK_PAGE_SELECTION_REQUIRED');
   const selection=createFacebookPageSelection({calendarId,pages:pages.map(p=>({id:p.id,name:p.name,accessToken:p.access_token})),grantedPermissions:permissions,userTokenExpiresAt:expires(long.expires_in)?.getTime()??null});
   const response=clear(NextResponse.redirect(appUrl()+`/dashboard/calendars/${calendarId}/facebook/select-page`));response.cookies.set(selection.cookieName,selection.value,facebookPageSelectionCookieOptions(selection.maxAge));return response;
  }
  const member=channel==='x'?await bounded(()=>services.xMember(tokens.access_token)):await bounded(()=>services.linkedinMember(tokens.access_token));
  let providerAccountId=channel==='x'?(member as Awaited<ReturnType<typeof getXMember>>).id:(member as Awaited<ReturnType<typeof getLinkedInMember>>).sub;
  // Reconnecting an organization must not silently replace it with a member.
  const existing=await deps.database.transaction(async tx=>(await tx.query(`SELECT v."providerAccountId" FROM "PublishingAccountBinding" b JOIN "PublishingAccountVersion" v ON v."bindingId"=b.id AND v.version=b."currentVersion" WHERE b."calendarId"=$1 AND b.platform=$2`,[calendarId,channel==='x'?'X':'LINKEDIN'])).rows[0]);
  if(channel==='linkedin'&&existing?.providerAccountId.startsWith('urn:li:organization:')){const old=await deps.database.transaction(async tx=>(await tx.query(`SELECT s.* FROM "PublishingAccountVersion" v JOIN "SocialConnection" s ON s.id=v."connectionId" WHERE v."providerAccountId"=$1 AND s."calendarId"=$2 ORDER BY v.version DESC LIMIT 1`,[existing.providerAccountId,calendarId])).rows[0]);const pages=await bounded(()=>services.linkedinPages({...old,accessToken:tokens.access_token,tokenScopes:tokens.scope??old.tokenScopes} as SocialConnection));if(!pages.some(p=>p.id===existing.providerAccountId))throw Error('LINKEDIN_ORGANIZATION_SELECTION_REQUIRED');providerAccountId=existing.providerAccountId;}
  const platform=channel==='x'?'X':'LINKEDIN';
  await deps.actions.bindVerifiedAccount({operationId,actor:creator.id,calendarId,platform,evidence:{connectionId:policyHash({calendarId,platform,providerAccountId}).slice(0,40),platform,providerAccountId,accessToken:tokens.access_token,expiresAt:expires(tokens.expires_in),refreshToken:tokens.refresh_token,refreshTokenExpiresAt:expires(tokens.refresh_token_expires_in)??undefined,tokenScopes:tokens.scope??'',accountName:'name'in member?member.name:undefined,username:'username'in member?member.username:undefined,...(channel==='linkedin'?{linkedinMemberId:(member as Awaited<ReturnType<typeof getLinkedInMember>>).sub}:{})}});
  return clear(NextResponse.redirect(appUrl()+`/dashboard/calendars/${calendarId}?view=channels&${channel}Connected=true`));
 };
}
