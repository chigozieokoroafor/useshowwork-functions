import {policyHash} from './eligibilityPolicy';
import type {DurableProviderSpool,ProviderJournalEvent} from './providerSpool';
/** Trusted append-only storage port. No default filesystem/cloud connection. */
export interface SharedJournalStorage{putIfAbsent(key:string,value:string):Promise<{durablyCommitted:true}>;list(prefix:string):Promise<string[]>;read(key:string):Promise<string>}
export function createSharedPublishingJournal(storage:SharedJournalStorage):DurableProviderSpool{
 return {async append(event){
  // SQL returns fields in SELECT order, which differs from the original event.
  // Field ordering cannot turn an identical recovered event into a conflict.
  const value=JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a],[b])=>a.localeCompare(b))));
  if(Buffer.byteLength(value)>4096)throw Error('JOURNAL_EVENT_TOO_LARGE');const key=`publishing/${event.authorizationId}/${event.id}`;const receipt=await storage.putIfAbsent(key,value);if(receipt?.durablyCommitted!==true)throw Error('JOURNAL_DURABILITY_UNACKNOWLEDGED');if(policyHash(JSON.parse(await storage.read(key)))!==policyHash(JSON.parse(value)))throw Error('JOURNAL_STORAGE_CONFLICT');},
 async records(authorizationId){const keys=await storage.list(`publishing/${authorizationId}/`),rows:ProviderJournalEvent[]=[];for(const key of keys){const event=JSON.parse(await storage.read(key));const {id,...body}=event;if(event.authorizationId!==authorizationId||id!==policyHash(body))throw Error('JOURNAL_INTEGRITY_FAILED');rows.push(event);}return rows;}};
}
