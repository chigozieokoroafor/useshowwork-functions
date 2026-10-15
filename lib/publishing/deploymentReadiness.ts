/** Configuration validation is deliberately incapable of starting a worker. */
export interface DisabledPublishingDeployment {
 version:1;publishingEnabled:false;owner:'VPS';protocol:'CANONICAL';
 schema:string;databasePoolSize:number;workerConcurrency:number;
 journal:'shared-object-storage';media:'versioned-object-storage';
 metaVersion:string;linkedinVersion:string;reconciliationIntervalMs:number;
}
export function validateDisabledPublishingDeployment(value:unknown):Readonly<DisabledPublishingDeployment> {
 const v=value as DisabledPublishingDeployment;
 const keys=['version','publishingEnabled','owner','protocol','schema','databasePoolSize','workerConcurrency','journal','media','metaVersion','linkedinVersion','reconciliationIntervalMs'];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==keys.sort().join()||v.version!==1||v.publishingEnabled!==false||v.owner!=='VPS'||v.protocol!=='CANONICAL'||!/^[a-z][a-z0-9_]{0,62}$/.test(v.schema)||!Number.isInteger(v.databasePoolSize)||v.databasePoolSize<1||v.databasePoolSize>5||!Number.isInteger(v.workerConcurrency)||v.workerConcurrency<1||v.workerConcurrency>3||v.workerConcurrency>v.databasePoolSize||v.journal!=='shared-object-storage'||v.media!=='versioned-object-storage'||!/^v\d+\.\d+$/.test(v.metaVersion)||!/^\d{6}$/.test(v.linkedinVersion)||!Number.isInteger(v.reconciliationIntervalMs)||v.reconciliationIntervalMs<1000||v.reconciliationIntervalMs>60000)throw Error('DISABLED_DEPLOYMENT_CONFIGURATION_INVALID');
 return Object.freeze({...v});
}
export function inspectPublishingDeployment(value:unknown,coverage:readonly {entrypoint:string;implemented:boolean}[]) {
 const config=validateDisabledPublishingDeployment(value);
 return {publishingEnabled:false as const,productionGo:false as const,configuration:config,blockers:coverage.filter(r=>!r.implemented).map(r=>r.entrypoint),mayConnect:false as const,maySend:false as const};
}
