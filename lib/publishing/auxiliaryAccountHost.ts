/** Narrow account service for Next and retained Netlify inbox/reporting hosts.
 * No publishing dispatcher, admission, worker, or authorization service exists
 * in this composition. Construction is lazy and all connections are closed. */
import type {SocialConnection} from '@prisma/client';
import {Pool} from 'pg';
import {createPublishingTransactionDatabase,type PublishingPool} from './transactionDatabase';
import {createPublishingValidationAdapters} from './validationAdapters';
import {createPublishingCoordination} from './executionCoordination';
import {createShowworkPublishingAccounts} from './showworkPublishingAccounts';
export async function freshCanonicalAuxiliaryConnection(connection:SocialConnection):Promise<SocialConnection>{
 const url=process.env.PUBLISHING_DATABASE_URL,schema=process.env.PUBLISHING_DATABASE_SCHEMA??'public';
 if(!url||!['postgres:','postgresql:'].includes(new URL(url).protocol)||!/^[_a-z][_a-z0-9]{0,62}$/.test(schema))throw Error('CANONICAL_ACCOUNT_DATABASE_REQUIRED');
 const pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,application_name:'showwork-auxiliary-account'});
 try{
  const database=createPublishingTransactionDatabase(pool as unknown as PublishingPool,{schema});
  const deny=async()=>{throw Error('AUXILIARY_ACCOUNT_CANNOT_AUTHORIZE_PUBLICATION');};
  const validation=createPublishingValidationAdapters({database,verifyViewer:deny,verifyRetryEvidence:deny});
  const coordination=createPublishingCoordination({database,validation});
  return await createShowworkPublishingAccounts({database,accountFetch:globalThis.fetch},validation,coordination).freshConnection(connection);
 }finally{await pool.end();}
}
