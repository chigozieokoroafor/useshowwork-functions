/** Injected local PostgreSQL transaction adapter. Does not create/connect a pool. */
import { AsyncLocalStorage } from 'node:async_hooks';
import {types as postgresTypes} from 'pg';
import type { OwnershipDatabase, OwnershipTransaction } from './ownership';
type QueryConfig={text:string;values?:unknown[];types:{getTypeParser:typeof postgresTypes.getTypeParser}};
export interface PublishingClient extends OwnershipTransaction { query(sql:string|QueryConfig,values?:unknown[]):ReturnType<OwnershipTransaction['query']>;release(destroy?: boolean): void }
export interface PublishingPool { connect(): Promise<PublishingClient> }
export class PublishingTransactionError extends Error {
  constructor(readonly code: string) { super(code); this.name='PublishingTransactionError'; }
}
const active = new AsyncLocalStorage<boolean>();
// Prisma's timestamp-without-timezone fields contain UTC, independently of the
// host TZ. Do not mutate pg's process-global parsers or legacy Prisma behavior.
const utcTypes={getTypeParser:((oid:number,format?:'text'|'binary')=>oid===1114&&format!=='binary'?(value:string)=>{
 if(value==='infinity'||value==='-infinity')return postgresTypes.getTypeParser(oid,'text')(value);
 const date=new Date(value.replace(' ','T')+'Z');if(!Number.isFinite(date.getTime()))throw new PublishingTransactionError('INVALID_APPLICATION_TIMESTAMP');return date;
}:postgresTypes.getTypeParser(oid,format)) as typeof postgresTypes.getTypeParser};
const utcParameter=(value:unknown):unknown=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(utcParameter):value;
export function createPublishingTransactionDatabase(pool: PublishingPool, options: { schema: string }): OwnershipDatabase {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema)) throw new PublishingTransactionError('INVALID_SCHEMA');
  return { async transaction<T>(run: (tx: OwnershipTransaction)=>Promise<T>) {
    if(active.getStore()) throw new PublishingTransactionError('NESTED_PUBLISHING_TRANSACTION');
    return active.run(true,async()=>{
      const c=await pool.connect(); let commitStarted=false,broken=false,open=false;
      const tx:OwnershipTransaction={async query(sql,values) {
        if(!open) throw new PublishingTransactionError('TRANSACTION_SCOPE_CLOSED');
        // Trusted parameterized statements only. No caller-managed TX/savepoints or batching.
        if(!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|SHOW)\b/i.test(sql)||/;|\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|SET\s+(?:LOCAL\s+)?TRANSACTION)\b/i.test(sql))
          throw new PublishingTransactionError('TRANSACTION_CONTROL_FORBIDDEN');
        return c.query({text:sql,values:values?.map(utcParameter),types:utcTypes});
      }};
      try {
        await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await c.query(`SET LOCAL search_path TO "${options.schema}"`);
        await c.query("SET LOCAL timezone='UTC'");
        await c.query("SET LOCAL statement_timeout='3000ms'");
        await c.query("SET LOCAL lock_timeout='2000ms'");
        open=true; const value=await run(tx);open=false;
        commitStarted=true;await c.query('COMMIT');return value;
      }catch(e) {
        open=false;
        if(commitStarted){broken=true;throw new PublishingTransactionError('PUBLISHING_COMMIT_UNCONFIRMED');}
        try{await c.query('ROLLBACK');}catch{broken=true;}
        throw e;
      }finally{open=false;c.release(broken);}
    });
  }};
}
