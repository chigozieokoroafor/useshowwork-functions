/** Pure policy bridge: no global ORM, session, token or provider imports. */
import { createHash } from 'node:crypto';
import { workspaceComplimentaryPlan, type ComplimentaryAccount } from '../complimentaryAccess';
import { CONTENT_WORKSPACE_PLANS, type ContentWorkspacePlan } from '../contentWorkspaceEntitlements';
import { buildCaption } from './state';
export interface PublishingPolicyOwner extends ComplimentaryAccount {
  id:string;isDeactivated:boolean;contentWorkspacePlan:ContentWorkspacePlan|null;
  contentWorkspaceBillingStatus:string;contentWorkspaceTrialEndsAt:Date|null;
}
export function workspaceEligibility(owner:PublishingPolicyOwner,ordinal:number,now:Date) {
  const trial=['TRIAL','ACTIVE'].includes(owner.contentWorkspaceBillingStatus)&&!!owner.contentWorkspaceTrialEndsAt&&owner.contentWorkspaceTrialEndsAt>now;
  const complimentary=workspaceComplimentaryPlan(owner,now);
  const access=!!complimentary||owner.contentWorkspaceBillingStatus==='ACTIVE'&&!!owner.contentWorkspacePlan||owner.contentWorkspaceBillingStatus==='TRIAL'&&!!owner.contentWorkspacePlan&&trial;
  const order=['CREATOR','STUDIO','UNLIMITED'];
  const plan:ContentWorkspacePlan|null=trial?'UNLIMITED':complimentary?
    owner.contentWorkspaceBillingStatus==='ACTIVE'&&owner.contentWorkspacePlan&&order.indexOf(owner.contentWorkspacePlan)>order.indexOf(complimentary)?owner.contentWorkspacePlan:complimentary:owner.contentWorkspacePlan;
  return {allowed:!!access&&!!plan&&Number.isInteger(ordinal)&&ordinal>0&&ordinal<=(plan?CONTENT_WORKSPACE_PLANS[plan]?.activeWorkspaces??0:0),plan};
}
function stable(v:any):any {return v instanceof Date?v.toISOString():Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;}
export function policyHash(value:unknown){return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');}
export function accountAuthorizationHash(c:{id:string;platform:string;platformAccountId:string;tokenScopes:string|null}) {
  return policyHash({connectionId:c.id,platform:c.platform,providerAccountId:c.platformAccountId,scopes:[...new Set((c.tokenScopes??'').split(/[\s,]+/).filter(Boolean))].sort()});
}
export function publishingContentHash(post:any,assets:any[]) {
  return policyHash({platform:post.platform,postType:post.postType??null,caption:buildCaption(post),
    tikTokSettings:post.platform==='TIKTOK'?post.tikTokSettings:null,
    assets:[...assets].sort((a,b)=>a.displayOrder-b.displayOrder||a.id.localeCompare(b.id)).map(a=>({id:a.id,fileKey:a.fileKey,mediaType:a.mediaType,displayOrder:a.displayOrder,...(a.objectVersion!=null&&a.contentSha256!=null?{objectVersion:a.objectVersion,contentSha256:a.contentSha256}:{})}))});
}
