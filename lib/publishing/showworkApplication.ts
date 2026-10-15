import {createShowworkPublishingAccounts} from './showworkPublishingAccounts';
/** Actual application policy services, explicitly composed; no bootstrap on import. */
import {getCurrentCreator,verifyViewerTokenClaims,hashPassword,verifyPassword,verifyCreatorSessionClaims} from '../auth';
import {publicUrlFor} from '../r2';
import {validateCanonicalWorkspaceUsage} from '../contentWorkspacePolicy';
import {generateContentCalendar,regeneratePost} from '../openai';
import {policyHash} from './eligibilityPolicy';
import {createCanonicalApplicationActions} from './applicationActions';
import {createCanonicalRouteDispatcher,createDisabledCanonicalApplication} from './applicationComposition';
import type {OwnershipDatabase} from './ownership';
import {createCanonicalShowworkOAuth} from './showworkOAuth';
import {installDisabledPublishingApplication} from './applicationBoundary';
import {createCanonicalShowworkUploadVerifier} from './showworkUploads';
import {createPublishingValidationAdapters} from './validationAdapters';
import {createPublishingCoordination} from './executionCoordination';
import {queryTikTokCreatorInfo} from '../tiktok';
import {fetchCustomerSubscriptions} from '../paystack';
import {withNativeApplicationContext,readOnlyApplicationDatabase} from './nativeApplicationContext';
import type {PublicationTarget} from './externalAuthorization';
import {headers} from 'next/headers';
import {isAdminEmail} from '../admin';
import {createNativePolicyAdapters} from './nativePolicyAdapters';

export function createShowworkPublishingApplication(input:{
 database:OwnershipDatabase;
 worker:Parameters<typeof createCanonicalRouteDispatcher>[0]['worker'];
 actions:Omit<Parameters<typeof createCanonicalApplicationActions>[0],'database'|'policy'|'validateUsage'|'generateContent'|'regenerateContent'|'creatorInfo'>&Partial<Pick<Parameters<typeof createCanonicalApplicationActions>[0],'validateUsage'|'generateContent'|'regenerateContent'|'creatorInfo'>>;
 verifyRetryEvidence:Parameters<typeof createCanonicalApplicationActions>[0]['policy']['verifyRetryEvidence'];
 verifyUpload?:Parameters<typeof createCanonicalRouteDispatcher>[0]['verifyUpload'];
 storage?:Parameters<typeof createCanonicalShowworkUploadVerifier>[0]['storage'];
 cronSecret:string;host:'NEXT'|'NETLIFY'|'VPS';publishingEnabled:false;
 oauthServices?:Parameters<typeof createCanonicalShowworkOAuth>[0]['services'];
 accountFetch?:typeof globalThis.fetch;
 nativePolicyHandlers?:Parameters<typeof createCanonicalRouteDispatcher>[0]['nativePolicyHandlers'];
 nativePolicy?:Omit<Parameters<typeof createNativePolicyAdapters>[0],'database'|'authenticate'|'operationId'>;
 nativeReadHandlers?:Record<string,(...args:any[])=>Promise<unknown>>;
 cleanupOriginals?:(operationId:string)=>Promise<unknown>;
}) {
 if(!input.cronSecret||input.publishingEnabled!==false)throw Error('DISABLED_SHOWWORK_CONFIGURATION_REQUIRED');
 const currentCreator=()=>input.nativePolicy?withNativeApplicationContext({database:input.nativePolicy.prisma,billingFetch:async()=>{throw Error('AUTH_HTTP_FORBIDDEN');}},()=>getCurrentCreator()):getCurrentCreator();
 const policy={verifyRetryEvidence:input.verifyRetryEvidence,verifyViewer:async(_tx:unknown,request:{calendarId:string;credential:string})=>{
  const claims=verifyViewerTokenClaims(request.credential,request.calendarId);if(!claims)throw Error('VIEWER_DENIED');
  return {principalId:policyHash({calendarId:request.calendarId,email:claims.email}).slice(0,40),calendarId:request.calendarId,expiresAt:claims.expiresAt};
 }};
 const authorizeCreatorDeletion=async(tx:import('./ownership').OwnershipTransaction,actor:string,_subject:string)=>{const administrator=(await tx.query(`SELECT email,"isDeactivated" FROM "Creator" WHERE id=$1`,[actor])).rows[0];if(!administrator||administrator.isDeactivated||!isAdminEmail(administrator.email))throw Error('ADMIN_PERMISSION_DENIED');};
 const validation=createPublishingValidationAdapters({database:input.database,...policy}),coordination=createPublishingCoordination({database:input.database,validation});
 const {accountIO,ensureFreshAccount}=createShowworkPublishingAccounts(input,validation,coordination);
 const creatorInfo=input.actions.creatorInfo??(async(calendarId:string,accountId:string)=>{
  const bound=await input.database.transaction(async tx=>(await tx.query(`SELECT b.id,b."currentVersion",s.id AS "connectionId",s."platformAccountId" FROM "PublishingAccountBinding" b JOIN "PublishingAccountVersion" v ON v."bindingId"=b.id AND v.version=b."currentVersion" JOIN "SocialConnection" s ON s.id=v."connectionId" WHERE b."calendarId"=$1 AND b.platform='TIKTOK' AND b.state='CONNECTED' AND s.status='CONNECTED' AND s."platformAccountId"=$2`,[calendarId,accountId])).rows[0]);if(!bound)throw Error('TIKTOK_ACCOUNT_CHANGED');
  const target={jobId:'account-read',intentId:'account-read',revision:1,generation:1,platform:'TIKTOK',accountBindingId:bound.id,accountVersion:bound.currentVersion,providerAccountId:accountId,connectionId:bound.connectionId,contentHash:'account-read'} as PublicationTarget;await ensureFreshAccount(target);
  const token=await input.database.transaction(async tx=>(await tx.query(`SELECT "accessToken" FROM "SocialConnection" WHERE id=$1 AND status='CONNECTED' AND "platformAccountId"=$2`,[bound.connectionId,accountId])).rows[0]?.accessToken);if(!token)throw Error('ACCOUNT_DISCONNECTED');
  await coordination.reserveSpacing('TIKTOK:'+accountId+':creator',3100);return accountIO(()=>queryTikTokCreatorInfo(token));
 });
 const actions=createCanonicalApplicationActions({...input.actions,authorizeCreatorDeletion,database:input.database,policy,creatorInfo,hashViewerPassword:input.actions.hashViewerPassword??hashPassword,validateUsage:input.actions.validateUsage??validateCanonicalWorkspaceUsage,generateContent:input.actions.generateContent??(async request=>generateContentCalendar(request as Parameters<typeof generateContentCalendar>[0])),regenerateContent:input.actions.regenerateContent??(async request=>regeneratePost(request as Parameters<typeof regeneratePost>[0]))});
 const resolveCalendar=async(request:Request,params:Record<string,string>)=>{
  if(params.id)return params.id;
  const slug=params.slug??new URL(request.url).pathname.match(/\/social-calendar\/([^/]+)\//)?.[1];
  if(!slug)throw Error('WORKSPACE_IDENTITY_REQUIRED');
  const calendar=await input.database.transaction(async tx=>(await tx.query(`SELECT id FROM "SocialCalendar" WHERE slug=$1`,[slug])).rows[0]);
  if(!calendar)throw Error('WORKSPACE_MISSING');return calendar.id as string;
 };
 const nativePolicyHandlers=input.nativePolicy?createNativePolicyAdapters({...input.nativePolicy,database:input.database,authenticate:async()=>{const actor=await currentCreator();return actor?{id:actor.id}:null;},operationId:async()=>(await headers()).get('idempotency-key')??undefined}):input.nativePolicyHandlers;
 for(const [entrypoint,handler] of Object.entries(input.nativeReadHandlers??{})){
  if(entrypoint!=='app/dashboard/billing/page.tsx#BillingPage@23'||!input.nativePolicy)throw Error('UNREVIEWED_NATIVE_READ_HANDLER');
  nativePolicyHandlers![entrypoint]=(...args:any[])=>withNativeApplicationContext({database:readOnlyApplicationDatabase(input.nativePolicy!.prisma),billingFetch:async(request,init)=>{const url=new URL(typeof request==='string'?request:request instanceof Request?request.url:String(request));if(url.hostname!=='api.paystack.co'||url.protocol!=='https:'||(init?.method??'GET')!=='GET')throw Error('READ_ONLY_BILLING_HTTP_REQUIRED');return input.nativePolicy!.billingFetch(request,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});}},()=>handler(...args));
 }
 const application=createDisabledCanonicalApplication({database:input.database,worker:input.worker,actions,resolveCalendar,publicUrlFor,nativePolicyHandlers,serverOperationId:async()=>{const id=(await headers()).get('idempotency-key');if(!id)throw Error('Stable operation ID required');return id;},
  authenticateCreator:async()=>{const creator=await currentCreator();return creator?{id:creator.id}:null;},
  confirmCreatorDeletion:async(actor,password)=>{const creator=await currentCreator();return creator?.id===actor&&typeof password==='string'&&await verifyPassword(password,creator.passwordHash)?{passwordHash:creator.passwordHash}:null;},
  authenticateCron:async value=>{const supplied=value instanceof Request?value.headers.get('authorization'):(value as {headers?:Record<string,string>})?.headers?.authorization;return supplied===`Bearer ${input.cronSecret}`;},
  viewerCredential:async request=>{const id=await resolveCalendar(request,{}),name=`calendar_viewer_${id}=`;return (request.headers.get('cookie')??'').split(';').map(p=>p.trim()).find(p=>p.startsWith(name))?.slice(name.length)??'';},
  verifyUpload:input.verifyUpload??(input.storage?createCanonicalShowworkUploadVerifier({database:input.database,storage:input.storage}):async()=>{throw Error('IMMUTABLE_STORAGE_ADAPTER_REQUIRED');}),
 },{host:input.host,publishingEnabled:false});
 const oauth=createCanonicalShowworkOAuth({database:input.database,actions,policy:{database:input.database,...policy},authenticate:async()=>{const c=await currentCreator();return c?{id:c.id}:null;},services:input.oauthServices,fetch:input.accountFetch});
 const invoke=async(entrypoint:string,args:readonly unknown[])=>{
  if(entrypoint.startsWith('app/api/account/route.ts#DELETE')&&args[0] instanceof Request){
   const request=args[0],operationId=request.headers.get('idempotency-key'),token=(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('spotlite_session='))?.slice('spotlite_session='.length),claims=token?verifyCreatorSessionClaims(token):null;
   if(claims&&operationId&&/^[a-zA-Z0-9_-]{1,90}$/.test(operationId)){
    const receipt=await input.database.transaction(async tx=>{
     const deleted=(await tx.query(`SELECT 1 FROM "PublishingResourceTombstone" WHERE "resourceType"='CREATOR' AND "resourceId"=$1 AND "operationId"=$2`,[claims.creatorId,operationId])).rows[0];if(!deleted)return null;
     const row=(await tx.query(`SELECT o.*,c."passwordHash" FROM "PublishingApplicationOperation" o JOIN "Creator" c ON c.id=o.actor WHERE o."operationId"=$1 AND o.actor=$2`,[operationId,claims.creatorId])).rows[0];if(!row||row.requestHash!==policyHash({operationId,actor:claims.creatorId,confirmationHash:policyHash(row.passwordHash)}))return null;return row;
    });
    if(receipt){const body=await request.clone().json().catch(()=>null);if(typeof body?.password==='string'&&await verifyPassword(body.password,receipt.passwordHash))return Response.json({ok:true},{headers:{'Set-Cookie':'spotlite_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'}});}
   }
  }

  if(entrypoint==='lib/syncContentWorkspaceRenewal.ts#syncContentWorkspaceRenewal@5'){
   if(!input.nativePolicy)throw Error('BILLING_READ_ADAPTER_REQUIRED');const actor=await currentCreator();if(!actor||actor.id!==args[0])throw Error('BILLING_OWNER_REQUIRED');
   const original=await input.nativePolicy.prisma.creator.findUnique({where:{id:actor.id},select:{contentWorkspaceBillingStatus:true,contentWorkspacePaystackCustomerCode:true,contentWorkspacePaystackSubscriptionCode:true,contentWorkspaceSubscriptionRenewsAt:true}});if(!original)return null;
   if(original.contentWorkspaceBillingStatus!=='ACTIVE'||!original.contentWorkspacePaystackCustomerCode||!original.contentWorkspacePaystackSubscriptionCode)return original.contentWorkspaceSubscriptionRenewsAt;
   try{
    const result=await withNativeApplicationContext({database:input.nativePolicy.prisma,billingFetch:async(request,init)=>{const url=new URL(typeof request==='string'?request:request instanceof Request?request.url:String(request));if(url.hostname!=='api.paystack.co'||url.protocol!=='https:'||url.pathname!=='/subscription'||(init?.method??'GET')!=='GET')throw Error('READ_ONLY_RENEWAL_LOOKUP_REQUIRED');return input.nativePolicy!.billingFetch(request,{...init,signal:AbortSignal.timeout(15000),redirect:'error'});}},()=>fetchCustomerSubscriptions(original.contentWorkspacePaystackCustomerCode!));
    const matched=result.data?.find((subscription:{subscription_code:string})=>subscription.subscription_code===original.contentWorkspacePaystackSubscriptionCode),next=matched?.next_payment_date?new Date(matched.next_payment_date):null;
    if(next&&Number.isFinite(next.getTime())){const changed=await input.nativePolicy.prisma.creator.updateMany({where:{id:actor.id,isDeactivated:false,contentWorkspaceBillingStatus:'ACTIVE',contentWorkspacePaystackCustomerCode:original.contentWorkspacePaystackCustomerCode,contentWorkspacePaystackSubscriptionCode:original.contentWorkspacePaystackSubscriptionCode},data:{contentWorkspaceSubscriptionRenewsAt:next}});if(changed.count)return next;}
   }catch{}
   return original.contentWorkspaceSubscriptionRenewsAt;
  }
  const response=await oauth(entrypoint,args);if(response)return response;
  const result=await application.invoke(entrypoint,args);
  if(entrypoint.startsWith('app/api/calendars/[id]/posts/[postId]/route.ts#DELETE')&&args[0] instanceof Request){const operationId=args[0].headers.get('idempotency-key');if(operationId)try{await input.cleanupOriginals?.(operationId);}catch{/* durable cleanup plan remains recoverable */}}
  return result;
 };
 return {...application,actions,invoke,ensureFreshAccount,installExplicitly:()=>installDisabledPublishingApplication({host:input.host,publishingEnabled:false,invoke})};
}
