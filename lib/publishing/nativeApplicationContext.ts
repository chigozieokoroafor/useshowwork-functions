/** Explicit dependency scope for reviewed native application policies. No bootstrap. */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {PrismaClient} from '@prisma/client';
import {publishingRetentionRequired} from './applicationBoundary';
import {retainedPublishingModel,RETAINED_VISIBILITY_SQL} from './retainedVisibility';
type Email=Record<string,unknown>;
export interface NativeApplicationContext {
 database:PrismaClient;
 billingFetch:typeof globalThis.fetch;
 notify?:(payload:Email,idempotencyKey?:string)=>Promise<{data:{id:string}|null;error:unknown}>;
 deleteObject?:(key:string)=>Promise<void>;
 completeMultipartUpload?:(key:string,uploadId:string,parts:{PartNumber:number;ETag:string}[])=>Promise<unknown>;
}
const host=globalThis as typeof globalThis & {__showworkNativeApplicationScope?:AsyncLocalStorage<NativeApplicationContext>};
const scope=host.__showworkNativeApplicationScope??(host.__showworkNativeApplicationScope=new AsyncLocalStorage<NativeApplicationContext>());
const facades=new WeakMap<object,object>();
export const nativeApplicationContext=()=>scope.getStore();
export function withNativeApplicationContext<T>(context:NativeApplicationContext,run:()=>Promise<T>){return scope.run(context,run);}
/** Preserve native Prisma semantics outside an explicitly injected composition. */
export function scopedApplicationDatabase<T extends object>(fallback:T):T{
 const existing=facades.get(fallback);if(existing)return existing as T;
 const facade=new Proxy(fallback,{get(target,key){const selected=scope.getStore()?.database??target,value=Reflect.get(selected,key);if(typeof key==='string'&&!key.startsWith('$')&&value&&typeof value==='object'&&publishingRetentionRequired())return retainedPublishingModel(selected,key,value);return typeof value==='function'?value.bind(selected):value;}});facades.set(fallback,facade);return facade;
}
export const nativeBillingFetch:typeof fetch=(input,init)=>{
 const current=scope.getStore();return current?current.billingFetch(input,init):globalThis.fetch(input,init);
};
/** A page render cannot become an unjournaled native mutation boundary. */
export function readOnlyApplicationDatabase(database:PrismaClient):PrismaClient{
 const allowed=new Set(['findUnique','findUniqueOrThrow','findFirst','findFirstOrThrow','findMany','count','aggregate','groupBy']);
 return new Proxy(database,{get(target,key){
  if(key==='$queryRawUnsafe')return async(sql:string,...args:unknown[])=>{if(sql!==RETAINED_VISIBILITY_SQL||args.length)throw Error('READ_ONLY_APPLICATION_DATABASE_REQUIRED');return target.$queryRawUnsafe(sql);};
  if(typeof key!=='string'||key.startsWith('$'))return async()=>{throw Error('READ_ONLY_APPLICATION_DATABASE_REQUIRED');};
  const model=Reflect.get(target,key);if(!model||typeof model!=='object')return undefined;
  return new Proxy(model,{get(value,method){const query=Reflect.get(value,method);if(typeof method==='string'&&allowed.has(method)&&typeof query==='function')return query.bind(value);return async()=>{throw Error('READ_ONLY_APPLICATION_DATABASE_REQUIRED');};}});
 }});
}
