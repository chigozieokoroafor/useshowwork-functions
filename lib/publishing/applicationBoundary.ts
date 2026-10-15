/** Local rehearsal bridge only. No environment feature flag or automatic install. */
import type { OwnershipDatabase } from './ownership';
import {AsyncLocalStorage} from 'node:async_hooks';
const hostState=globalThis as typeof globalThis & {__showworkPublishingBoundary?:{policy:AsyncLocalStorage<string>;composition?:LocalApplicationComposition}};
const boundary=hostState.__showworkPublishingBoundary??(hostState.__showworkPublishingBoundary={policy:new AsyncLocalStorage<string>()});
const policyExecution=boundary.policy;
export const nativePolicyEntrypoints=new Set(["app/api/calendars/[id]/business-documents/[documentId]/route.ts#DELETE@14", "app/api/payments/webhook/route.ts#POST@115", "lib/syncContentWorkspaceRenewal.ts#syncContentWorkspaceRenewal@5", "app/api/calendars/subscribe/route.ts#POST@46", "app/api/calendars/cancel-subscription/route.ts#POST@16", "app/api/calendars/upgrade-to-company/route.ts#POST@39", "app/api/calendars/downgrade-to-individual/route.ts#POST@32", "app/api/calendars/verify-subscription/route.ts#POST@23", "app/api/calendars/[id]/verify-subscription/route.ts#POST@24", "app/api/calendars/[id]/retry-payment/route.ts#POST@38", "app/api/calendars/route.ts#POST@122", "app/admin/social-calendars/[id]/route.ts#PATCH@22", "app/api/admin/social-calendars/[id]/route.ts#PATCH@20", "app/api/admin/creators/[id]/route.ts#PATCH@12", "app/api/admin/creators/[id]/complimentary/route.ts#POST@9", "app/api/admin/partners/[id]/route.ts#PATCH@55", "app/api/media/[mediaId]/route.ts#DELETE@17", "app/api/media/[mediaId]/replace/complete/route.ts#POST@11", "app/api/media/[mediaId]/replace/multipart-complete/route.ts#POST@16", "app/api/portfolio/media/[mediaId]/route.ts#DELETE@8", "app/api/portfolio/sections/[sectionId]/route.ts#DELETE@52", "app/api/sections/[sectionId]/route.ts#DELETE@43", "app/api/managed-projects/[id]/brief-attachments/[attachmentId]/route.ts#DELETE@7", "app/api/admin/billing-offers/route.ts#POST@42", "app/api/admin/billing-offers/route.ts#PATCH@98", "app/api/admin/billing-offers/route.ts#PUT@136", "app/dashboard/billing/page.tsx#BillingPage@23"]);
const nativePolicyIds=nativePolicyEntrypoints;
export function nativePolicyExecutionRoot(){return policyExecution.getStore();}
export function nativePolicyExecutionAllowed(entrypoint:string){return nativePolicyIds.has(entrypoint)&&(policyExecution.getStore()===entrypoint||entrypoint==='lib/syncContentWorkspaceRenewal.ts#syncContentWorkspaceRenewal@5'&&nativePolicyIds.has(policyExecution.getStore()??''));}
/** Signed billing/renewal services may retain their established native policy
 * logic. This scope cannot bypass any publication or account-creation boundary. */
export function runNativePublishingPolicy<T>(entrypoint:string,run:()=>Promise<T>):Promise<T>{
 if(!nativePolicyIds.has(entrypoint))throw Error('NATIVE_POLICY_ENTRYPOINT_NOT_APPROVED');return policyExecution.run(entrypoint,run);
}
const proofs=new WeakSet<object>();
export type LocalIntegrationProof=Readonly<object>;
export async function proveDisposablePublishingDatabase(database:OwnershipDatabase):Promise<LocalIntegrationProof>{
 const r=await database.transaction(async tx=>(await tx.query(`SELECT current_user AS actor,current_database() AS database,inet_server_addr() AS address,current_schema() AS schema`)).rows[0]);
 if(r.actor!=='synthetic_owner'||r.database!=='postgres'||r.address!==null||!/^accelerated_[0-9]+$/.test(r.schema??''))throw Error('DISPOSABLE_DATABASE_PROOF_REQUIRED');
 const proof=Object.freeze({});proofs.add(proof);return proof;
}
export interface LocalApplicationComposition {
 proof:LocalIntegrationProof;
 invoke(entrypoint:string,args:readonly unknown[]):Promise<unknown>;
 assertLegacyAllowed(entrypoint:string):Promise<void>;
}
// Shared across separately compiled instrumentation, routes and server actions.
/** Trusted server bootstrap only. A configuration object alone performs no IO
 * or installation; callers must explicitly supply the complete handler graph.
 * Publishing remains disabled independently of database ownership. */
export function installDisabledPublishingApplication(input:{host:'NEXT'|'NETLIFY'|'VPS';publishingEnabled:false;invoke:LocalApplicationComposition['invoke']}) {
 if(!['NEXT','NETLIFY','VPS'].includes(input.host)||input.publishingEnabled!==false||typeof input.invoke!=='function'||boundary.composition)throw Error('DISABLED_APPLICATION_BOOTSTRAP_REJECTED');
 const identity=Object.freeze({});
 boundary.composition={proof:identity,invoke:input.invoke,assertLegacyAllowed:async()=>{throw Error('DISABLED_CANONICAL_HOST_PUBLICATION_FENCED');}};
 return ()=>{if(boundary.composition?.proof!==identity)throw Error('INTEGRATION_TEARDOWN_CONFLICT');boundary.composition=undefined;};
}
export function publishingIntegrationInstalled(){
 const mode=typeof process!=='undefined'?process.env.SHOWWORK_PUBLISHING_PROTOCOL:undefined;
 if(mode!==undefined&&mode!=='legacy'&&mode!=='canonical')throw Error('INVALID_PUBLISHING_PROTOCOL');
 // A flag can veto legacy execution, but can never install an adapter or grant a
 // capability. Server bootstrap installs adapters explicitly; this flag never grants send authority.
 if(mode==='canonical'&&!boundary.composition)throw Error('CANONICAL_BOOTSTRAP_REQUIRED');
 return boundary.composition!==undefined;
}
/** Non-publishing hosts still hide retained content. Reading the application
 * database does not need to install a publishing dispatcher or grant authority. */
export function publishingRetentionRequired(){
 const mode=process.env.SHOWWORK_PUBLISHING_PROTOCOL;
 if(mode!==undefined&&mode!=='legacy'&&mode!=='canonical')throw Error('INVALID_PUBLISHING_PROTOCOL');
 return mode==='canonical'||boundary.composition!==undefined;
}
/** Obsolete factories are unavailable in the canonical boundary.composition, rather
 * than constructing a second job/state/authorization implementation. */
export function assertLegacyFactoryNotRetired(entrypoint:string){
 if(publishingIntegrationInstalled())throw Error('LEGACY_FACTORY_RETIRED:'+entrypoint);
}
export function installLocalPublishingIntegration(input:LocalApplicationComposition){
 if(!proofs.has(input.proof)||boundary.composition)throw Error('ISOLATED_INTEGRATION_INSTALL_DENIED');
 boundary.composition=Object.freeze({...input});
 // Explicit test teardown only. Installation is explicit; teardown is available to tests and server shutdown.
 return ()=>{if(boundary.composition?.proof!==input.proof)throw Error('INTEGRATION_TEARDOWN_CONFLICT');boundary.composition=undefined;};
}
export async function invokePublishingEntrypoint<T>(entrypoint:string,args:readonly unknown[]):Promise<T>{
 if(!boundary.composition)throw Error('INTEGRATION_NOT_INSTALLED');return await boundary.composition.invoke(entrypoint,args) as T;
}
export async function assertLegacyPublishingAllowed(entrypoint:string){
 if(boundary.composition)await boundary.composition.assertLegacyAllowed(entrypoint);
}
