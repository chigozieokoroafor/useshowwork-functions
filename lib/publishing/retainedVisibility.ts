/** Application read projection only; reconciliation continues through raw SQL.
 * Installed canonical hosts must have the retention schema before serving reads. */
export const RETAINED_VISIBILITY_SQL='SELECT "resourceType","resourceId" FROM "PublishingResourceTombstone" WHERE "resourceType" IN (\'POST\',\'WORKSPACE\',\'CREATOR\')';
const reads=new Set(['findUnique','findUniqueOrThrow','findFirst','findFirstOrThrow','findMany','count','aggregate','groupBy']);
export function retainedPublishingModel(database:any,key:string,model:any){
 return new Proxy(model,{get(target,method){const value=Reflect.get(target,method);if(typeof method!=='string'||!reads.has(method)||typeof value!=='function')return typeof value==='function'?value.bind(target):value;
  return async(args:any={})=>{
   const rows=await database.$queryRawUnsafe(RETAINED_VISIBILITY_SQL);
   const ids=(type:string)=>rows.filter((r:any)=>r.resourceType===type).map((r:any)=>r.resourceId);
   const posts=ids('POST'),calendars=ids('WORKSPACE'),creators=ids('CREATOR');
   const exclusions=key==='calendarPost'?posts:key==='socialCalendar'?calendars:key==='creator'?creators:[];
   const predicate=(where:any,hidden:string[])=>hidden.length?{...where,NOT:[...(Array.isArray(where?.NOT)?where.NOT:where?.NOT?[where.NOT]:[]),{id:{in:hidden}}]}:where;
   const next={...args,...(exclusions.length?{where:predicate(args.where,exclusions)}:{})};
   const ownerField=key==='socialCalendar'?'managerId':['portfolio','project','managedProject'].includes(key)?'creatorId':undefined;
   if(ownerField&&creators.length)next.where={...next.where,NOT:[...(Array.isArray(next.where?.NOT)?next.where.NOT:next.where?.NOT?[next.where.NOT]:[]),{[ownerField]:{in:creators}}]};
   for(const select of ['include','select'])if(next[select]){
    next[select]={...next[select]};for(const relation of ['posts','calendarPosts'])if(next[select][relation]){const r=next[select][relation]===true?{}:next[select][relation];next[select][relation]={...r,where:predicate(r.where,posts)};}
    const count=next[select]._count;if(count?.select?.posts){next[select]._count={...count,select:{...count.select,posts:{...(count.select.posts===true?{}:count.select.posts),where:predicate(count.select.posts.where,posts)}}};}
   }
   const hidden=new Set([...posts,...calendars,...creators]);
   function filter(v:any):any{if(Array.isArray(v))return v.map(filter).filter((x,i)=>x!==null||v[i]===null);if(v&&Object.getPrototypeOf(v)===Object.prototype){if(hidden.has(v.id)||['calendar','socialCalendar'].some(key=>v[key]&&hidden.has(v[key].id)))return null;return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,filter(x)]));}return v;}
   return filter(await value.call(target,next));
  };
 }});
}
