/** Server-only configuration. Reading configuration never creates clients or grants sends. */
export function publishingHostConfiguration(env:NodeJS.ProcessEnv){
 const flag=(name:string)=>{const value=env[name];if(value!==undefined&&!['true','false'].includes(value))throw Error('INVALID_'+name);return value==='true';};
 const enabled=flag('SHOWWORK_PUBLISHING_ENABLED'),application=flag('SHOWWORK_CANONICAL_APPLICATION_ENABLED'),reconciliation=flag('PUBLISHING_RECONCILIATION_ENABLED');
 if(!enabled&&!application&&!reconciliation)return {enabled:false as const,application:false as const};
 if(env.SHOWWORK_PUBLISHING_PROTOCOL!=='canonical')throw Error('CANONICAL_HOST_PROTOCOL_REQUIRED');
 const required=(name:string)=>{const value=env[name];if(!value)throw Error('MISSING_'+name);return value;};
 const integer=(name:string,min:number,max:number,fallback:string)=>{const value=env[name]??fallback;if(!/^\d+$/.test(value)||Number(value)<min||Number(value)>max)throw Error('INVALID_'+name);return Number(value);};
 const schema=env.PUBLISHING_DATABASE_SCHEMA??'public';if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw Error('INVALID_DATABASE_SCHEMA');
 const databaseUrl=required('PUBLISHING_DATABASE_URL'),url=new URL(databaseUrl);if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('INVALID_DATABASE_URL');
 const endpoint=required('PUBLISHING_STORAGE_ENDPOINT'),origin=required('PUBLISHING_MEDIA_PUBLIC_ORIGIN');for(const value of [endpoint,origin]){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('INVALID_STORAGE_URL');}
 const prefix=required('PUBLISHING_STORAGE_JOURNAL_PREFIX');if(!/^publishing\/[A-Za-z0-9_-]+\/$/.test(prefix))throw Error('INVALID_JOURNAL_PREFIX');
 const meta=required('META_API_VERSION'),linkedin=required('LINKEDIN_API_VERSION');if(!/^v\d+\.\d+$/.test(meta)||!/^\d{6}$/.test(linkedin))throw Error('INVALID_PROVIDER_VERSION');
 const epoch=enabled||reconciliation?required('PUBLISHING_EXPECTED_EPOCH'):'1';if(!/^[1-9]\d*$/.test(epoch))throw Error('INVALID_OWNERSHIP_EPOCH');
 return {enabled,application,reconciliation,databaseUrl,schema,endpoint,origin,prefix,epoch:BigInt(epoch),bucket:required('PUBLISHING_STORAGE_BUCKET'),accessKeyId:required('PUBLISHING_STORAGE_ACCESS_KEY_ID'),secretAccessKey:required('PUBLISHING_STORAGE_SECRET_ACCESS_KEY'),versions:{meta,linkedin},concurrency:integer('PUBLISHING_WORKER_CONCURRENCY',1,3,'2'),poolMax:integer('PUBLISHING_DATABASE_POOL_MAX',1,5,'3'),pollMs:integer('PUBLISHING_WORKER_POLL_MS',1000,60000,'5000')};
}
export type PublishingHostConfiguration=ReturnType<typeof publishingHostConfiguration>;
