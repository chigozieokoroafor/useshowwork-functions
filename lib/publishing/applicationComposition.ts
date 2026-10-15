/** Local-only route composition. Every unported path fails closed; no legacy fallback. */
import {policyHash} from './eligibilityPolicy';
import {calendarPostData} from '../calendarPosts';
import type {SocialPlatform} from '@prisma/client';
import type {OwnershipDatabase} from './ownership';
import type {createCanonicalApplicationActions} from './applicationActions';
import type {createInactiveCanonicalWorker} from './canonicalWorker';
import type {createPublishingIntegrationControl} from './integrationControl';
import {proveDisposablePublishingDatabase,installLocalPublishingIntegration,installDisabledPublishingApplication,runNativePublishingPolicy} from './applicationBoundary';
export function createCanonicalRouteDispatcher(deps:{actions:ReturnType<typeof createCanonicalApplicationActions>;worker:ReturnType<typeof createInactiveCanonicalWorker>;database:OwnershipDatabase;
 authenticateCreator(request:Request):Promise<{id:string}|null>;authenticateCron(input:unknown):Promise<boolean>;viewerCredential(request:Request):Promise<string>;
 resolveCalendar(request:Request,params:Record<string,string>):Promise<string>;
 confirmCreatorDeletion?:(actor:string,password:unknown)=>Promise<{passwordHash:string}|null>;
 publicUrlFor?:(key:string)=>string;
 nativePolicyHandlers?:Record<string,(...args:any[])=>Promise<unknown>>;
 serverOperationId?:()=>Promise<string>;
 verifyUpload(upload:unknown):Promise<{fileKey:string;objectVersion:string;contentSha256:string;mediaType:'PHOTO'|'VIDEO';sizeBytes:string;verifiedFor:{calendarId:string;postId:string};reservationId?:string;sourceAssetId?:string;sourcePostId?:string}>;
}){
 return async(entrypoint:string,args:readonly unknown[])=>{
  const path=entrypoint.split('#')[0],request=args[0];
  const native=deps.nativePolicyHandlers?.[entrypoint];if(native){
   await deps.database.transaction(async tx=>{
    if(!(await tx.query(`SELECT to_regclass('"PublishingEligibilityFence"') IS NOT NULL AND to_regclass('"PublishingEligibilityHold"') IS NOT NULL AS present`)).rows[0].present)throw Error('POLICY_FENCE_SCHEMA_REQUIRED');
    const triggers=(await tx.query(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND t.tgenabled='O'`)).rows.map(r=>r.tgname);
    if(!['publishing_creator_eligibility','publishing_calendar_eligibility','publishing_member_eligibility','publishing_post_eligibility','publishing_asset_eligibility','publishing_connection_eligibility','publishing_entitlement_hold','publishing_principal_hold'].every(name=>triggers.includes(name)))throw Error('POLICY_FENCE_TRIGGERS_REQUIRED');
    await tx.query(`SELECT version FROM "PublishingEligibilityFence" WHERE id=1 FOR SHARE`);
   });
   return runNativePublishingPolicy(entrypoint,()=>native(...args));
  }
  if(path==='lib/calendarImport/confirmation.ts'){const actor=await deps.authenticateCreator(new Request('http://localhost/internal-import'));if(!actor||actor.id!==args[1])throw Error('Unauthorized import actor');return deps.actions.importPosts(String(args[0]),actor.id,args[2]);}
  if(path==='lib/calendarTeamService.ts'&&/\#(editTeammate|removeTeammate)@/.test(entrypoint)){
   const actor=await deps.authenticateCreator(new Request('http://localhost/internal-team'));if(!actor||actor.id!==(args[2] as {id:string})?.id)throw Error('Unauthorized team actor');const operationId=await deps.serverOperationId?.();if(!operationId)throw Error('Stable operation ID required');
   return deps.actions.membershipById({operationId,actor:actor.id,calendarId:String(args[0]),collaboratorId:String(args[1]),assignment:args[3]??{},remove:entrypoint.includes('#removeTeammate@')});
  }
  if(path==='lib/calendarTeamService.ts'&&entrypoint.includes('#acceptTeamInvite@')){const actor=await deps.authenticateCreator(new Request('http://localhost/internal-invite'));if(!actor||actor.id!==(args[1] as {id:string})?.id)throw Error('Unauthorized invitation actor');const operationId=await deps.serverOperationId?.();if(!operationId)throw Error('Stable operation ID required');return deps.actions.acceptInvitation({operationId,actor:actor.id,token:String(args[0])});}
  if(path.startsWith('netlify/')||path.startsWith('app/api/cron/')){
   if(!await deps.authenticateCron(request))return path.startsWith('netlify/')?{statusCode:401,body:'Unauthorized'}:Response.json({error:'Unauthorized'},{status:401});
   const o=await deps.database.transaction(async tx=>(await tx.query(`SELECT * FROM "PublishingOwnership" WHERE id=1`)).rows[0]);
   if(o.state!=='NETLIFY')return path.startsWith('netlify/')?{statusCode:503,body:'Publishing ownership fenced'}:Response.json({error:'Publishing ownership fenced'},{status:503});
   const result=await deps.worker.pollOnce();return path.startsWith('netlify/')?{statusCode:200,body:JSON.stringify(result)}:Response.json(result);
  }
  if(!(request instanceof Request))throw Error('CANONICAL_REQUEST_REQUIRED');
  const context=args[1] as {params?:Promise<Record<string,string>>}|undefined,params=await context?.params??{};
  const body=await request.clone().json().catch(()=>({})) as Record<string,any>;
  const operationId=request.headers.get('idempotency-key')??body.operationId;
  if(request.method!=='GET'&&(typeof operationId!=='string'||!/^[a-zA-Z0-9_-]{1,90}$/.test(operationId)))return Response.json({error:'Stable operation ID required'},{status:400});
  const view=async(calendarId:string,postId:string)=>{const p=await deps.actions.postView(calendarId,postId);return {...p,assets:p.assets.map((a):Record<string,any>=>({...a,...(deps.publicUrlFor?{contentUrl:deps.publicUrlFor(a.fileKey)}:{})}))};};
  const applied=(result:any)=>{if(result.outcome&&result.outcome!=='APPLIED')throw Error(result.code??result.outcome);return result;};
  try{
   if(path==='app/api/account/deactivate/route.ts'){const actor=await deps.authenticateCreator(request);if(!actor)return Response.json({error:'Unauthorized'},{status:401});await deps.actions.deactivate({operationId,actor:actor.id});return Response.json({ok:true},{headers:{'Set-Cookie':'spotlite_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'}});}
   if(path.endsWith('/invites/[token]/accept/route.ts')){const actor=await deps.authenticateCreator(request);if(!actor)return Response.json({error:'Unauthorized'},{status:401});return Response.json(await deps.actions.acceptInvitation({operationId,actor:actor.id,token:params.token}));}
   if(path.endsWith('/admin/creators/[id]/route.ts')&&request.method==='DELETE'){
    const actor=await deps.authenticateCreator(request);if(!actor)return Response.json({error:'Unauthorized'},{status:401});try{await deps.actions.eraseAdminCreator({operationId,actor:actor.id,subjectId:params.id});}catch(error){if(error instanceof Error&&error.message==='ADMIN_PERMISSION_DENIED')return Response.json({error:'Unauthorized'},{status:401});if(error instanceof Error&&error.message==='ADMIN_CANNOT_DELETE_SELF')return Response.json({error:"You can't delete your own account from here"},{status:400});throw error;}return Response.json({ok:true});
   }
   if(path.endsWith('/account/route.ts')&&request.method==='DELETE'){
    const actor=await deps.authenticateCreator(request);if(!actor)return Response.json({error:'Unauthorized'},{status:401});
    if(typeof body.password!=='string'||!body.password)return Response.json({error:'Enter your password to confirm'},{status:400});
    if(!deps.confirmCreatorDeletion)throw Error('TRUSTED_DELETION_CONFIRMATION_REQUIRED');const proof=await deps.confirmCreatorDeletion(actor.id,body.password);if(!proof)return Response.json({error:'Incorrect password'},{status:400});
    await deps.actions.eraseCreator({operationId,actor:actor.id,confirmedPasswordHash:proof.passwordHash});return Response.json({ok:true},{headers:{'Set-Cookie':'spotlite_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'}});
   }
   const calendarId=await deps.resolveCalendar(request,params);
   if(path.endsWith('/social-calendar/[slug]/respond/route.ts'))return Response.json(await deps.actions.plan({operationId,calendarId,credential:await deps.viewerCredential(request),action:body.action,note:body.note}));
   if(path.includes('social-calendar/')&&path.includes('/review/')){
    if(!['approve','request_revision'].includes(body.action))throw Error('INVALID_REVIEW_ACTION');await deps.actions.review({operationId,calendarId,postId:params.postId,credential:await deps.viewerCredential(request),approved:body.action==='approve',note:body.note});return Response.json({post:await view(calendarId,params.postId)});
   }
   const actor=await deps.authenticateCreator(request);if(!actor)return Response.json({error:'Unauthorized'},{status:401});
   if(path.endsWith('/tiktok/creator-info/route.ts'))return Response.json(await deps.actions.creatorMetadata(actor.id,calendarId),{headers:{'Cache-Control':'no-store'}});
   const postId=params.postId??body.postId;
   if(path.endsWith('/posts/route.ts')&&request.method==='GET'){
    const allowed=['id','postDate','platform','postType','category','hook','script','caption','contentIdea','cta','hashtags','taggedAccounts','linkUrl','approvalStatus','approvalNote','publishStatus','publishError','publishPermalink','instagramPublishStatus','instagramPermalink','instagramPublishError','tikTokPublishStatus','tikTokPrivacyLevel','tikTokSettings','tikTokConsentAt','tikTokInitStartedAt','tikTokPublishId','tikTokPublishError'];
    const rows=await deps.actions.listPosts(actor.id,calendarId);return Response.json({posts:rows.map(p=>({...Object.fromEntries(allowed.map(k=>[k,(p as Record<string,any>)[k]])),assets:p.assets.map(a=>({id:a.id,fileKey:a.fileKey,mediaType:a.mediaType,contentUrl:deps.publicUrlFor?.(a.fileKey)})),videoComments:p.videoComments,customFields:p.customFields,publishing:p.publishing}))},{headers:{'Cache-Control':'no-store'}});
   }
   if(path.endsWith('/imports/confirm/route.ts'))return Response.json(await deps.actions.importPosts(calendarId,actor.id,body),{headers:{'Cache-Control':'no-store'}});
   if(path.endsWith('/calendars/[id]/route.ts')&&request.method==='PATCH'&&body.action==='publish')return Response.json(await deps.actions.plan({operationId,actor:actor.id,calendarId,action:body.action}));
   if(path.endsWith('/calendars/[id]/route.ts')&&request.method==='PATCH'&&['update_details','set_password','regenerate_password'].includes(body.action))return Response.json(await deps.actions.workspaceDetails({operationId,actor:actor.id,calendarId,action:body.action,clientName:body.clientName,password:body.password}));
   if(path.endsWith('/calendars/[id]/reset/route.ts'))return Response.json(await deps.actions.resetCalendar({operationId,actor:actor.id,calendarId,confirmation:body.confirmation}));
   if(postId&&request.method!=='DELETE'&&(path.includes('/posts/')||path.includes('/ai-drafts/'))){
    const scoped=await deps.database.transaction(async tx=>(await tx.query(`SELECT id FROM "CalendarPost" WHERE id=$1 AND "calendarId"=$2`,[postId,calendarId])).rows.length===1);
    if(!scoped)throw Error('POST_WORKSPACE_SCOPE_CONFLICT');
   }
   if(path.includes('/posts/[postId]/publish/')||path.endsWith('/posts/[postId]/publish/route.ts')){
    if(request.method==='GET')return Response.json(await deps.actions.metadata(actor.id,calendarId,postId),{headers:{'Cache-Control':'no-store'}});
    if(!Number.isSafeInteger(body.expectedRevision)||!body.destination||typeof body.intentId!=='string')throw Error('EXACT_INTENT_REQUEST_REQUIRED');
    const input={operationId,actor:actor.id,calendarId,intentId:body.intentId,postId,platform:body.platform,expectedRevision:body.expectedRevision,dueAt:body.dueAt?new Date(body.dueAt):body.action==='publish'?new Date(0):undefined,destination:body.destination,evidenceId:body.evidenceId};
    if(input.platform==='TIKTOK'&&['save','schedule','publish','reschedule','retry'].includes(body.action)){const result=applied(await deps.actions.tikTok({...input,calendarId,settings:body.settings,accountId:body.accountId,consent:body.consent===true,saveOnly:body.action==='save',reschedule:body.action==='reschedule',retry:body.action==='retry'}));const meta=await deps.actions.metadata(actor.id,calendarId,postId);return Response.json({ok:true,status:meta.status,publishing:meta,...result});}
    if(!['schedule','publish','cancel','reschedule','retry'].includes(body.action))throw Error('INVALID_PUBLISHING_ACTION');const result=applied(await deps.actions.publishing(input,body.action==='publish'?'schedule':body.action));const meta=await deps.actions.metadata(actor.id,calendarId,postId);return Response.json({ok:true,status:meta.status,publishing:meta,...result});
   }
   if(path.endsWith('/posts/route.ts')&&request.method==='POST'){
    const platforms=Array.isArray(body.platforms)&&body.platforms.length?[...new Set(body.platforms)]:[body.platform];
    for(const platform of platforms)calendarPostData(calendarId,body,platform as SocialPlatform);
    const result=await deps.actions.createBatch({operationId,actor:actor.id,calendarId,platforms,caption:body.caption??'',postDate:new Date(body.postDate),fields:body});
    const posts=await Promise.all(result.posts.map(p=>view(calendarId,p.postId)));return Response.json({post:posts[0],posts});
   }
   if(path.endsWith('/posts/[postId]/resubmit/route.ts')){await deps.actions.resubmit({operationId,actor:actor.id,calendarId,postId});return Response.json({post:await view(calendarId,postId)});}
   if(path.includes('/ai-generate/'))return Response.json(await deps.actions.generate({operationId,actor:actor.id,calendarId,body}));
   if(path.includes('/ai-drafts/')){
    if(request.method==='DELETE')return Response.json(await deps.actions.deletePlanningPosts({operationId,actor:actor.id,calendarId,postId,draftOnly:true}));
    if(request.method==='POST'&&path.endsWith('/restore/route.ts')){await deps.actions.restoreDraft({operationId,actor:actor.id,calendarId,postId,generationId:body.generationId});return Response.json({post:await view(calendarId,postId)});}
    if(request.method==='PATCH'){await deps.actions.changeContent({operationId,actor:actor.id,calendarId,postId,caption:body.caption,promoteAi:true,patch:Object.fromEntries(Object.entries(body).filter(([k])=>!['operationId','caption'].includes(k)))});return Response.json({post:await view(calendarId,postId)});}
    if(request.method==='POST'&&postId)return Response.json(await deps.actions.regenerate({operationId,actor:actor.id,calendarId,postId,body}));
   }
   if(path.endsWith('/posts/[postId]/route.ts')){
    if(request.method==='PATCH'&&Object.keys(body).some(k=>!['operationId','caption','postDate','platform','postType','category','hook','script','contentIdea','cta','hashtags','taggedAccounts','linkUrl','tikTokPrivacyLevel'].includes(k)))return Response.json({error:'Canonical metadata-field adapter required'},{status:503});
    if(request.method==='PATCH'){await deps.actions.changeContent({operationId,actor:actor.id,calendarId,postId,caption:body.caption,patch:Object.fromEntries(Object.entries(body).filter(([k])=>!['operationId','caption'].includes(k)))});return Response.json({post:await view(calendarId,postId)});}
    if(request.method==='DELETE'){await deps.actions.deletePlanningPosts({operationId,actor:actor.id,calendarId,postId});return Response.json({ok:true});}
   }
   if(path.includes('/posts/[postId]/')&&(/upload-complete|attach-asset|assets\/\[assetId\]/.test(path))){
    const result=await deps.actions.media({operationId,actor:actor.id,calendarId,postId,assetId:params.assetId??body.assetId??policyHash({operationId,postId}).slice(0,40),remove:request.method==='DELETE',upload:body},deps.verifyUpload);
    if(request.method==='DELETE')return Response.json({ok:true});const p=await view(calendarId,postId);return Response.json({asset:p.assets.find(a=>a.id===result.assetId),post:p});
   }
   if(path.endsWith('/disconnect/route.ts')){
    const channel=params.channel??(path.includes('/instagram/')?'instagram':path.includes('/tiktok/')?'tiktok':'');
    const platform={instagram:'INSTAGRAM',tiktok:'TIKTOK',facebook:'FACEBOOK',linkedin:'LINKEDIN',x:'X'}[channel as 'x'];
    return Response.json(await deps.actions.bindVerifiedAccount({operationId,actor:actor.id,calendarId,platform,disconnect:true}));
   }
   if(path.includes('/collaborators/'))return Response.json(await deps.actions.membershipById({operationId,actor:actor.id,calendarId,collaboratorId:params.collaboratorId,assignment:body,remove:request.method==='DELETE'}));
   if(path.endsWith('/calendars/[id]/route.ts')&&request.method==='DELETE'){await deps.actions.erase({operationId,actor:actor.id,calendarId,resourceType:'WORKSPACE',resourceId:calendarId});return Response.json({ok:true});}
   if(path.endsWith('/account/route.ts')&&request.method==='DELETE')return Response.json(await deps.actions.erase({operationId,actor:actor.id,calendarId,resourceType:'CREATOR',resourceId:actor.id}));
   // OAuth exchange, multi-workspace cascades, billing-provider callbacks and
   // specialized uploads require explicit reviewed adapters; never call legacy.
   return Response.json({error:'Canonical adapter required',entrypoint},{status:503});
  }catch(error){const message=error instanceof Error?error.message:'Canonical request failed',code=error&&typeof error==='object'&&'code'in error?String(error.code):message;
   const status=/PERMISSION_DENIED|ENTITLEMENT_DENIED|ACTOR_DEACTIVATED|LIMIT_REACHED/.test(code)?403:/POST_MISSING|POST_RETIRED|WORKSPACE_MISSING|WORKSPACE_RETIRED|not found/i.test(code)?404:/INVALID_|valid .* required|must be text|Custom fields|valid generation|Invalid generation/i.test(message)?400:409;
   return Response.json({error:message,code:code==='APPROVED_CONTENT_LOCKED'?'POST_APPROVED_LOCKED':code},{status});}
 };
}
export async function installCanonicalLocalApplication(deps:{database:OwnershipDatabase;control:ReturnType<typeof createPublishingIntegrationControl>;invoke:(entrypoint:string,args:readonly unknown[])=>Promise<unknown>}){
 const proof=await proveDisposablePublishingDatabase(deps.database);return installLocalPublishingIntegration({proof,invoke:deps.invoke,assertLegacyAllowed:()=>deps.control.assertLegacyAllowed()});
}
export function createDisabledCanonicalApplication(deps:Parameters<typeof createCanonicalRouteDispatcher>[0],config:{host:'NEXT'|'NETLIFY'|'VPS';publishingEnabled:false}) {
 if(!['NEXT','NETLIFY','VPS'].includes(config.host)||config.publishingEnabled!==false)throw Error('DISABLED_APPLICATION_CONFIGURATION_REQUIRED');
 // Do not even construct/inspect the supplied worker on a disabled host.
 const worker={pollOnce:async()=>({publishingEnabled:false,admitted:0,maySend:false})} as unknown as Parameters<typeof createCanonicalRouteDispatcher>[0]['worker'];
 const invoke=createCanonicalRouteDispatcher({...deps,worker});
 return {invoke,publishingEnabled:false as const,installExplicitly:()=>installDisabledPublishingApplication({host:config.host,publishingEnabled:false,invoke})};
}
