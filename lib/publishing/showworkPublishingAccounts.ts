/** Shared native account refresh for application and VPS worker. No IO on import. */
import type {OwnershipDatabase} from './ownership';
import type {PublicationTarget} from './externalAuthorization';
import type {createPublishingValidationAdapters} from './validationAdapters';
import type {createPublishingCoordination} from './executionCoordination';
import {createFencedTokenRefresh} from './tokenRefreshFence';
import {withPublishingAccountIO} from './executionContext';
import {refreshTikTokAccessToken} from '../tiktok';
import {requestSocialTokenRefresh} from './nativeTokenServices';
import {getXMember,getLinkedInMember} from '../channelOAuth';
import {linkedInPages} from '../linkedin/pages';
import type {SocialConnection} from '@prisma/client';
export function createShowworkPublishingAccounts(input:{database:OwnershipDatabase;accountFetch?:typeof fetch},validation:ReturnType<typeof createPublishingValidationAdapters>,coordination:ReturnType<typeof createPublishingCoordination>){
 async function accountIO<T>(run:()=>Promise<T>){if(!input.accountFetch)throw Error('EXPLICIT_ACCOUNT_HTTP_REQUIRED');return withPublishingAccountIO({fetch:input.accountFetch,signal:AbortSignal.timeout(30000)},run);}
 const refresh=createFencedTokenRefresh({database:input.database,validation,coordination,refresh:async target=>{
  if(!target.refreshToken)throw Error('RECONNECT_REQUIRED');
  if(target.platform==='TIKTOK'){const tokens=await accountIO(()=>refreshTikTokAccessToken(target.refreshToken!));return {accountId:tokens.open_id,accessToken:tokens.access_token,expiresAt:new Date(Date.now()+tokens.expires_in*1000),scopes:tokens.scope,refreshToken:tokens.refresh_token,refreshTokenExpiresAt:new Date(Date.now()+tokens.refresh_expires_in*1000)};}
  if(target.platform!=='X'&&target.platform!=='LINKEDIN')throw Error('RECONNECT_EXACT_ACCOUNT_REQUIRED');
  const stored=await input.database.transaction(async tx=>(await tx.query(`SELECT s.*,c."linkedinMemberId" FROM "SocialConnection" s JOIN "SocialCalendar" c ON c.id=s."calendarId" WHERE s.id=$1`,[target.connectionId])).rows[0]);if(!stored)throw Error('ACCOUNT_DISCONNECTED');
  const tokens=await accountIO(()=>requestSocialTokenRefresh(target.platform as 'X'|'LINKEDIN',target.refreshToken!)),member=target.platform==='X'?await accountIO(()=>getXMember(tokens.access_token)):await accountIO(()=>getLinkedInMember(tokens.access_token));
  const id='id'in member?member.id:member.sub,organization=target.accountId.startsWith('urn:li:organization:');if(id!==(organization?stored.linkedinMemberId:target.accountId.replace(/^urn:li:person:/,'')))throw Error('REFRESH_ACCOUNT_CHANGED');
  if(organization){const pages=await accountIO(()=>linkedInPages({...stored,accessToken:tokens.access_token,tokenScopes:tokens.scope??stored.tokenScopes} as SocialConnection));if(!pages.some(page=>page.id===target.accountId))throw Error('LINKEDIN_ORGANIZATION_PERMISSION_REVOKED');}
  const connection=await input.database.transaction(async tx=>(await tx.query(`SELECT "tokenScopes" FROM "SocialConnection" WHERE id=$1`,[target.connectionId])).rows[0]);
  return {accountId:target.accountId,accessToken:tokens.access_token,expiresAt:new Date(Date.now()+tokens.expires_in*1000),scopes:tokens.scope??connection.tokenScopes??'',refreshToken:tokens.refresh_token,refreshTokenExpiresAt:tokens.refresh_token_expires_in?new Date(Date.now()+tokens.refresh_token_expires_in*1000):undefined};
 }});
 async function ensureFreshAccount(target:PublicationTarget,options?:{reconciliation:true}){
  if(options?.reconciliation){
   const history=await input.database.transaction(async tx=>(await tx.query(`SELECT s.*,b."currentVersion",currentv."providerAccountId" AS "currentAccountId",currentv."connectionId" AS "currentConnectionId" FROM "PublishingAccountVersion" v JOIN "SocialConnection" s ON s.id=v."connectionId" JOIN "PublishingAccountBinding" b ON b.id=v."bindingId" JOIN "PublishingAccountVersion" currentv ON currentv."bindingId"=b.id AND currentv.version=b."currentVersion" JOIN "PublishingSendCapability" c ON c."jobId"=$1 AND c.state='CONSUMED' WHERE v."bindingId"=$2 AND v.version=$3 AND s.id=$4 AND s."platformAccountId"=$5 AND s.platform=$6 AND s.status='CONNECTED' AND c."intentId"=$7 AND c.revision=$8 AND c.generation=$9 AND c."contentHash"=$10`,[target.jobId,target.accountBindingId,target.accountVersion,target.connectionId,target.providerAccountId,target.platform,target.intentId,target.revision,target.generation,target.contentHash])).rows[0]);
   if(!history?.accessToken)throw Error('HISTORICAL_ACCOUNT_UNAVAILABLE');
   if(!history.accessTokenExpiresAt||history.accessTokenExpiresAt.getTime()>Date.now()+60000)return {maySend:false};
   if(history.currentAccountId!==target.providerAccountId||history.currentConnectionId!==target.connectionId)throw Error('RECONNECT_HISTORICAL_ACCOUNT_FOR_RECONCILIATION');
   return refresh.refresh({...target,accountVersion:history.currentVersion});
  }
  const connection=await input.database.transaction(async tx=>(await tx.query(`SELECT s.* FROM "PublishingAccountBinding" b JOIN "PublishingAccountVersion" v ON v."bindingId"=b.id AND v.version=b."currentVersion" JOIN "SocialConnection" s ON s.id=v."connectionId" WHERE b.id=$1 AND b."currentVersion"=$2 AND b.state='CONNECTED' AND s.id=$3 AND s.status='CONNECTED' AND s."platformAccountId"=$4`,[target.accountBindingId,target.accountVersion,target.connectionId,target.providerAccountId])).rows[0]);if(!connection?.accessToken)throw Error('ACCOUNT_DISCONNECTED');
  if(!connection.accessTokenExpiresAt||connection.accessTokenExpiresAt.getTime()>Date.now()+60000)return {maySend:false};
  if(connection.refreshTokenExpiresAt&&connection.refreshTokenExpiresAt<=new Date())throw Error('RECONNECT_REQUIRED');return refresh.refresh(target);
 }
 /** Reporting and inbox callers reuse rotation fencing without obtaining a job,
  * capability, or additional product permissions. Caller authorization stays at
  * the existing route/cron boundary. Never return a replacement connection. */
 async function freshConnection(original:SocialConnection):Promise<SocialConnection>{
  if(original.status!=='CONNECTED'||!['X','LINKEDIN','TIKTOK'].includes(original.platform))throw Error('ACCOUNT_DISCONNECTED');
  const read=()=>input.database.transaction(async tx=>(await tx.query(`SELECT s.*,b.id AS "bindingId",b."currentVersion" FROM "PublishingAccountBinding" b JOIN "PublishingAccountVersion" v ON v."bindingId"=b.id AND v.version=b."currentVersion" JOIN "SocialConnection" s ON s.id=v."connectionId" WHERE b."calendarId"=$1 AND b.platform=$2 AND b.state='CONNECTED' AND s.id=$3 AND s.status='CONNECTED' AND s."platformAccountId"=$4 AND s."connectedAt"=$5 AND s.platform=b.platform AND v."providerAccountId"=s."platformAccountId"`,[original.calendarId,original.platform,original.id,original.platformAccountId,original.connectedAt])).rows[0]);
  const current=await read();if(!current?.accessToken)throw Error('ACCOUNT_DISCONNECTED');
  await ensureFreshAccount({jobId:'account-read',intentId:'account-read',revision:1,generation:1,platform:original.platform,accountBindingId:current.bindingId,accountVersion:current.currentVersion,providerAccountId:original.platformAccountId,connectionId:original.id,contentHash:'account-read'} as PublicationTarget);
  const updated=await read();if(!updated?.accessToken||updated.bindingId!==current.bindingId||updated.currentVersion!==current.currentVersion)throw Error('ACCOUNT_CHANGED_DURING_REFRESH');
  const {bindingId:_binding,currentVersion:_version,...connection}=updated;return connection as SocialConnection;
 }
 return {accountIO,ensureFreshAccount,freshConnection};
}
