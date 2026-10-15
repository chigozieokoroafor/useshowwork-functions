/** Next server bootstrap. Called only by instrumentation after explicit local/deployment configuration. */
import {Pool} from 'pg';
import {S3Client} from '@aws-sdk/client-s3';
import {Resend} from 'resend';
import {nativeApplicationDatabase} from '../db';
import {createPublishingTransactionDatabase,type PublishingPool} from './transactionDatabase';
import {createPublishingObjectStorage} from './objectStorageAdapters';
import {createShowworkLaunchApplication} from './showworkLaunchApplication';
import type {PublishingHostConfiguration} from './hostConfiguration';
import {createInactiveCanonicalWorker} from './canonicalWorker';
import {createPublishingValidationAdapters} from './validationAdapters';
export function installShowworkApplicationHost(config:PublishingHostConfiguration,input:{fetch:typeof globalThis.fetch;cronSecret:string;notify:NonNullable<Parameters<typeof createShowworkLaunchApplication>[0]['nativePolicy']['notify']>}){
 if(!config.application||!('databaseUrl'in config)||!input.cronSecret)throw Error('APPLICATION_HOST_CONFIGURATION_REQUIRED');
 const pool=new Pool({connectionString:config.databaseUrl,max:config.poolMax,connectionTimeoutMillis:5000,application_name:'showwork-canonical-application'}),client=new S3Client({endpoint:config.endpoint,region:'auto',credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED'});
 const database=createPublishingTransactionDatabase(pool as unknown as PublishingPool,{schema:config.schema}),storage=createPublishingObjectStorage({client,bucket:config.bucket,prefix:config.prefix});
 const deny=async()=>{throw Error('APPLICATION_HOST_CANNOT_PUBLISH');};
 const verifyRetryEvidence=async()=>{throw Error('TRUSTED_RETRY_RECONCILIATION_REQUIRED');};
 const validation=createPublishingValidationAdapters({database,verifyViewer:deny,verifyRetryEvidence});
 // Application hosts manage durable intents only. They never execute provider sends.
 const worker=createInactiveCanonicalWorker({database,validation,actor:'application-host',epoch:BigInt(1),owner:'VPS',environment:'production-disabled',spool:{append:deny,records:deny},io:{kind:'native-disabled',refresh:deny,reserveRate:deny,creatorInfo:deny,media:deny,prepare:deny,submit:deny,lookup:deny}});
 try{
  const application=createShowworkLaunchApplication({database,worker,host:'NEXT',publishingEnabled:false,cronSecret:input.cronSecret,accountFetch:input.fetch,storage,verifyRetryEvidence,
   nativePolicy:{prisma:nativeApplicationDatabase,isolation:'read-committed-with-policy-locks',billingFetch:input.fetch,notify:input.notify},
   actions:{verifyAccount:async()=>{throw Error('SIGNED_OAUTH_ACCOUNT_PROOF_REQUIRED');},authorizeBilling:async()=>{throw Error('NATIVE_BILLING_POLICY_REQUIRED');},retention:async()=>{throw Error('RETENTION_POLICY_NOT_APPROVED');}}});
  const uninstall=application.installExplicitly();let closing:Promise<void>|undefined;return {application,close:()=>closing??=(async()=>{uninstall();await worker.close();await pool.end();client.destroy();})()};
 }catch(error){void pool.end();client.destroy();throw error;}
}
/** Keep notification semantics in the existing Resend service; no request on construction. */
export function nativePublishingNotification(apiKey:string){
 if(!apiKey)throw Error('NOTIFICATION_CREDENTIAL_REQUIRED');const client=new Resend(apiKey);
 return async(payload:Record<string,unknown>,idempotencyKey?:string)=>client.emails.send(payload as unknown as Parameters<typeof client.emails.send>[0],idempotencyKey?{idempotencyKey}:undefined);
}
