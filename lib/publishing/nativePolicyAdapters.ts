/** Transaction-aware reuse of reviewed native product rules. Inactive explicit DI only. */
import type {PrismaClient} from '@prisma/client';
import {policyHash} from './eligibilityPolicy';
import type {OwnershipDatabase} from './ownership';
import {withNativeApplicationContext,type NativeApplicationContext} from './nativeApplicationContext';
import {nativePolicyEntrypoints,runNativePublishingPolicy} from './applicationBoundary';
import {verifyWebhookSignature} from '../paystack';
import {randomUUID} from 'node:crypto';

export function createNativePolicyAdapters(deps:{database:OwnershipDatabase;prisma:PrismaClient;
 handlers:Record<string,(...args:any[])=>Promise<Response>>;
 authenticate():Promise<{id:string}|null>;
 operationId?:()=>Promise<string|undefined>;
 /** Explicitly reviewed replacement for native SERIALIZABLE callback scopes:
  * all policy predicates are protected by ordered writer-excluding table locks,
  * while eligibility triggers require READ COMMITTED. NOWAIT prevents a writer
  * already waiting for the fence from forming a table/fence deadlock. No implicit downgrade. */
 isolation:'read-committed-with-policy-locks';
 billingFetch:typeof fetch;notify?:NativeApplicationContext['notify'];
 onTransactionFailure?:(error:unknown)=>void;
 cleanupOriginals?:(operationId:string)=>Promise<unknown>;
 completeMultipartUpload?:NativeApplicationContext['completeMultipartUpload'];
}){
 if(deps.isolation!=='read-committed-with-policy-locks')throw Error('NATIVE_ISOLATION_CONTRACT_REQUIRED');
 const handlers:Record<string,(...args:any[])=>Promise<Response>>={};
 for(const [entrypoint,handler] of Object.entries(deps.handlers)){
  if(!nativePolicyEntrypoints.has(entrypoint)||typeof handler!=='function')throw Error('UNREVIEWED_NATIVE_POLICY');
  handlers[entrypoint]=async(...args:any[])=>{
   try{
   const request=args[0] instanceof Request?args[0] as Request:undefined;
   const webhook=entrypoint==='app/api/payments/webhook/route.ts#POST@115';
   const raw=request?await request.clone().text():null;
   if(webhook&&(!request||raw===null||Buffer.byteLength(raw)>1024*1024||!verifyWebhookSignature(raw,request.headers.get('x-paystack-signature')??'')))return Response.json({error:'Invalid signature'},{status:401});
   const actor=webhook?{id:'native-billing-webhook'}:await deps.authenticate();if(!actor)return Response.json({error:'Unauthorized'},{status:401});
   const operationId=webhook?'billing-webhook-'+policyHash(raw):request?.headers.get('idempotency-key')??await deps.operationId?.();
   if(!operationId||!/^[a-zA-Z0-9_-]{1,90}$/.test(operationId))return Response.json({error:'Stable operation ID required'},{status:400});
   const payload=request?raw:args,params=await (args[1] as {params?:Promise<unknown>}|undefined)?.params??null;
   const hash=policyHash({entrypoint,actor:actor.id,payload,params,path:request?new URL(request.url).pathname+new URL(request.url).search:null,method:request?.method??null});
   const reservation='native-reservation-'+operationId;
   const databaseWitness=randomUUID();
   const saved=await deps.database.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['native:'+operationId]);
    const old=(await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[operationId])).rows[0];
    if(old){if(old.actor!==actor.id||old.requestHash!==hash)throw Error('OPERATION_CONFLICT');return old.result;}
    const pending=(await tx.query(`SELECT * FROM "PublishingApplicationOperation" WHERE "operationId"=$1`,[reservation])).rows[0];
    if(pending){if(pending.actor!==actor.id||pending.requestHash!==hash)throw Error('OPERATION_CONFLICT');throw Error('NATIVE_OPERATION_PENDING_RECONCILIATION');}
    await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[reservation,actor.id,hash,{entrypoint,pending:true,databaseWitness}]);return null;
   });
   if(saved)return new Response(saved.body,{status:saved.status,headers:saved.headers});
   let ordinal=0,verifiedPayment=false;let verifiedPaymentReference:string|undefined,verifiedPaymentAt:Date|undefined;const heldOwners=new Set<string>();
   const journal=async(label:string,result:unknown)=>deps.database.transaction(async tx=>{await tx.query(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4)`,[label,actor.id,hash,result]);});
   const billingFetch:typeof fetch=async(input,init)=>{
    const original=input instanceof Request?input:new Request(input,init),url=new URL(original.url),method=(init?.method??original.method).toUpperCase();
    if(url.protocol!=='https:'||url.hostname!=='api.paystack.co'||url.port||url.username||url.password||!['GET','POST','PUT'].includes(method)||!/^\/(transaction|subscription|plan|customer|dedicated_account)(\/|$)/.test(url.pathname))throw Error('BILLING_ENDPOINT_DENIED');
    const invocation=operationId+'-billing-'+(++ordinal),body=await original.clone().text();
    let reference:string|undefined;try{const value=JSON.parse(body);if(typeof value.reference==='string')reference=value.reference;}catch{}
    await journal(invocation,{entrypoint,method,path:url.pathname,requestHash:policyHash(body),reference,invocationReserved:true});
    if(method==='POST'&&url.pathname==='/subscription/disable'){
     const code=JSON.parse(body).code;if(typeof code!=='string'||!code)throw Error('BILLING_SUBSCRIPTION_IDENTITY_REQUIRED');
     await deps.database.transaction(async tx=>{
      const owners=(await tx.query(`SELECT id FROM "Creator" WHERE "contentWorkspacePaystackSubscriptionCode"=$1`,[code])).rows;
      for(const owner of owners){heldOwners.add(owner.id);await tx.query(`INSERT INTO "PublishingBillingRevocationHold"("ownerId","operationId","invocationId","cancelledSubscriptionHash") VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[owner.id,operationId,invocation,policyHash(code)]);
       await tx.query(`INSERT INTO "PublishingEligibilityHold"("intentId",revision,reason) SELECT p."intentId",p.revision,'BILLING_CANCELLATION_REVIEW_REQUIRED' FROM "PublishingRevisionPolicy" p JOIN "PublishingCanonicalRevision" r ON r."intentId"=p."intentId" AND r.revision=p.revision JOIN "PublishingJob" j ON j.id=r."jobId" WHERE p."ownerId"=$1 AND j.phase IN ('READY','PREPARED','EXTERNAL_PENDING') ON CONFLICT DO NOTHING`,[owner.id]);}
     });
    }
    const signal=AbortSignal.any([AbortSignal.timeout(30000),...(init?.signal?[init.signal]:[])]);
    const response=await deps.billingFetch(input,{...init,signal,redirect:'error'});
    const evidence=await response.clone().text();if(evidence.length>1024*1024)throw Error('BILLING_RESPONSE_TOO_LARGE');
    // Record response evidence without persisting secrets, payment details or tokens.
    await journal(invocation+'-response',{status:response.status,responseHash:policyHash(evidence),responseObserved:true});if(method==='GET'&&url.pathname.startsWith('/transaction/verify/')&&(entrypoint.includes('/verify-subscription/route.ts')||webhook)&&response.ok){try{const charge=JSON.parse(evidence).data,requested=decodeURIComponent(url.pathname.slice('/transaction/verify/'.length));const paidAt=new Date(charge?.paid_at);if(charge?.status==='success'&&charge.reference===requested&&Number.isFinite(paidAt.getTime())){verifiedPayment=true;verifiedPaymentReference=requested;verifiedPaymentAt=paidAt;}}catch{}}return response;
   };
   // Native SERIALIZABLE callbacks join this explicitly locked transaction.
   // READ COMMITTED is mandatory for durable eligibility triggers. Never retry
   // this whole callback after an external billing operation or unknown commit.
   let context:NativeApplicationContext|undefined;
   try{const response=await deps.prisma.$transaction(async tx=>{
    const sameDatabase=await tx.$queryRawUnsafe<{result:{databaseWitness:string}}[]>(`SELECT result FROM "PublishingApplicationOperation" WHERE "operationId"=$1 AND actor=$2 AND "requestHash"=$3`,reservation,actor.id,hash);
    if(sameDatabase[0]?.result.databaseWitness!==databaseWitness)throw Error('CANONICAL_DATABASE_MISMATCH');
    await tx.$executeRawUnsafe(`SET LOCAL timezone='UTC'`);
    await tx.$queryRawUnsafe(`SELECT version FROM "PublishingEligibilityFence" WHERE id=1 FOR UPDATE`);
    await tx.$executeRawUnsafe(`LOCK TABLE "BillingBenefitNotification","BillingOffer","BillingOfferCharge","BillingOfferRecipient","BillingOfferRedemption","BillingOfferSubscription","BriefAttachment","CalendarBusinessDocument","CalendarCollaborator","CalendarInvite","ContentWorkspaceStorageReservation","ContentWorkspaceUsage","Creator","ManagedProject","Media","MediaSection","Portfolio","PortfolioMedia","PortfolioSection","Project","ProjectCollaborator","SocialCalendar","TaskAsset" IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    if(!webhook){const current=await tx.creator.findUnique({where:{id:actor.id},select:{isDeactivated:true}});if(!current||current.isDeactivated)throw Error('ACTOR_DEACTIVATED');}
    let nestedFailure:unknown;
    const database=new Proxy(tx as unknown as PrismaClient,{get(target,key){
     if(key==='$transaction')return async(callback:unknown,options?:{isolationLevel?:string})=>{if(typeof callback!=='function'||options?.isolationLevel&&options.isolationLevel!=='Serializable')throw Error('NATIVE_NESTED_TRANSACTION_CONTRACT');try{return await callback(database);}catch(error){nestedFailure=error;deps.onTransactionFailure?.(error);throw error;}};
     const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const deletionKeys=new Set<string>();
    context={database,billingFetch,notify:deps.notify,deleteObject:async key=>{if(typeof key!=='string'||key.length>1024||deletionKeys.size>=1000)throw Error('INVALID_ORIGINAL_DELETION');deletionKeys.add(key);},completeMultipartUpload:deps.completeMultipartUpload};
    let signedSubscription:any,pendingReference:string|undefined;
    if(webhook){try{const event=JSON.parse(raw!);if(event.event==='subscription.create'){signedSubscription=event.data;const email=event.data?.customer?.email;if(typeof email==='string')pendingReference=(await tx.creator.findUnique({where:{email},select:{contentWorkspacePendingSubscriptionRef:true}}))?.contentWorkspacePendingSubscriptionRef??undefined;}}catch{}}
    const response=await withNativeApplicationContext(context,()=>runNativePublishingPolicy(entrypoint,()=>handler(...args)));
    if(nestedFailure)throw nestedFailure;
    const body=await response.clone().text(),headers=Object.fromEntries(response.headers),result={body,status:response.status,headers};
    if(deletionKeys.size)await tx.$executeRawUnsafe(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4::jsonb)`,operationId+'-cleanup-plan',actor.id,hash,JSON.stringify({keys:[...deletionKeys],entrypoint}));
    await tx.$executeRawUnsafe(`INSERT INTO "PublishingApplicationOperation"("operationId",actor,"requestHash",result) VALUES($1,$2,$3,$4::jsonb)`,operationId,actor.id,hash,JSON.stringify(result));
    if(response.ok&&signedSubscription){const reference=typeof signedSubscription.reference==='string'?signedSubscription.reference:pendingReference;if(reference){const paid=await tx.paymentRecord.findUnique({where:{paystackReference:reference},select:{creatorId:true,type:true,revenueStatus:true,createdAt:true}});const current=paid?await tx.creator.findUnique({where:{id:paid.creatorId},select:{contentWorkspacePaystackSubscriptionCode:true,contentWorkspaceBillingStatus:true}}):null;if(paid?.type.startsWith('CONTENT_WORKSPACE_')&&paid.revenueStatus!=='UNVERIFIED'&&current?.contentWorkspaceBillingStatus==='ACTIVE'&&current.contentWorkspacePaystackSubscriptionCode===signedSubscription.subscription_code){verifiedPayment=true;verifiedPaymentReference=reference;verifiedPaymentAt=paid.createdAt;}}}
    if(response.ok&&(verifiedPayment||heldOwners.size)){
     const verifiedOwners=new Set<string>();if(verifiedPayment&&!webhook)verifiedOwners.add(actor.id);if(verifiedPayment&&webhook&&verifiedPaymentReference){const paid=await tx.paymentRecord.findUnique({where:{paystackReference:verifiedPaymentReference},select:{creatorId:true,type:true,revenueStatus:true}});if(paid?.type.startsWith('CONTENT_WORKSPACE_')&&paid.revenueStatus!=='UNVERIFIED')verifiedOwners.add(paid.creatorId);}
     const owners=new Set([...heldOwners,...verifiedOwners]);
     for(const ownerId of owners){const current=await tx.creator.findUnique({where:{id:ownerId},select:{contentWorkspaceBillingStatus:true,contentWorkspacePaystackSubscriptionCode:true}});if(!current)continue;const verified=verifiedOwners.has(ownerId)&&current.contentWorkspaceBillingStatus==='ACTIVE';if(!verified&&(!heldOwners.has(ownerId)||current.contentWorkspaceBillingStatus==='ACTIVE'))continue;
      await tx.$executeRawUnsafe(`INSERT INTO "PublishingBillingRevocationResolution"("ownerId","holdOperationId","operationId",reason) SELECT h."ownerId",h."operationId",$2,$3 FROM "PublishingBillingRevocationHold" h WHERE h."ownerId"=$1 AND (($3='TRUSTED_PAYMENT_VERIFIED' AND h."cancelledSubscriptionHash"<>$4 AND (SELECT min(prior."createdAt") FROM "PublishingBillingRevocationHold" prior WHERE prior."ownerId"=h."ownerId" AND prior."cancelledSubscriptionHash"=h."cancelledSubscriptionHash" AND NOT EXISTS(SELECT 1 FROM "PublishingBillingRevocationResolution" done WHERE done."ownerId"=prior."ownerId" AND done."holdOperationId"=prior."operationId"))<=$5::timestamptz) OR $3='LOCAL_REVOCATION_COMMITTED' AND h."operationId"=$2) ON CONFLICT DO NOTHING`,ownerId,operationId,verified?'TRUSTED_PAYMENT_VERIFIED':'LOCAL_REVOCATION_COMMITTED',current.contentWorkspacePaystackSubscriptionCode?policyHash(current.contentWorkspacePaystackSubscriptionCode):null,verifiedPaymentAt?.toISOString()??null);
     }
    }
    return response;
   },{isolationLevel:'ReadCommitted',timeout:60000,maxWait:5000});
   // Next after() work uses the committed queue and injected client, never the
   // closed request transaction. Failed commits cannot run external follow-ups.
   if(context)context.database=deps.prisma;
   // Cleanup is optional follow-up to a durable plan. A failure never rolls back
   // committed product records or loses the keys needed for later recovery.
   try{await deps.cleanupOriginals?.(operationId);}catch{}
   return response;
   }catch(error){if(context){context.billingFetch=async()=>{throw Error('NATIVE_COMMIT_UNCONFIRMED');};context.notify=async()=>{throw Error('NATIVE_COMMIT_UNCONFIRMED');};}throw error;}
   }catch(error){const message=error instanceof Error?error.message:'',code=['OPERATION_CONFLICT','NATIVE_OPERATION_PENDING_RECONCILIATION','ACTOR_DEACTIVATED','CANONICAL_DATABASE_MISMATCH'].includes(message)?message:'NATIVE_OPERATION_UNCONFIRMED';return Response.json({error:code==='OPERATION_CONFLICT'?'This operation identifier belongs to a different request.':'The operation could not be confirmed. Reconcile its durable record before retrying.',code},{status:code==='NATIVE_OPERATION_UNCONFIRMED'?503:409});}
  };
 }
 return handlers;
}
