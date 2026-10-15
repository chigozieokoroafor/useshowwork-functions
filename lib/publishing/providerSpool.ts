/** Explicit synthetic-only host WAL. Never selects a directory on import. */
import { open, mkdir, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { policyHash } from './eligibilityPolicy';
export interface DurableProviderSpool { append(event:ProviderJournalEvent):Promise<void>; records(authorizationId:string):Promise<ProviderJournalEvent[]> }
export interface ProviderJournalEvent {
 id:string;authorizationId:string;jobId:string;platform:string;kind:'SUBMISSION'|'RESPONSE'|'STATUS';
 outcome:'ACCEPTED'|'CONFIRMED'|'REJECTED'|'UNKNOWN';reference?:string;responseHash:string;operation:string;
 publicationReferences?:string[];permalink?:string;
}
export async function createSyntheticProviderSpool(directory:string):Promise<DurableProviderSpool>{
 const root=resolve(directory),temporary=resolve(tmpdir());
 if(!root.startsWith(temporary+sep))throw Error('TEMPORARY_SYNTHETIC_SPOOL_REQUIRED');
 await mkdir(root,{recursive:true,mode:0o700});const file=join(root,'provider-observations.jsonl');let queue=Promise.resolve();
 return {
  append(event){const run=queue.then(async()=>{const line=JSON.stringify(event)+'\n';if(Buffer.byteLength(line)>4096)throw Error('SPOOL_EVENT_TOO_LARGE');const h=await open(file,'a',0o600);try{await h.writeFile(line);await h.sync();}finally{await h.close();}const d=await open(root,'r');try{await d.sync();}finally{await d.close();}});queue=run.catch(()=>{});return run;},
  async records(authorizationId){await queue;let source:string;try{source=await readFile(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
   const rows=new Map<string,ProviderJournalEvent>();const lines=source.split('\n');if(lines.at(-1)!=='')lines.pop();
   for(const line of lines){if(!line)continue;const event=JSON.parse(line) as ProviderJournalEvent;const old=rows.get(event.id);if(old&&policyHash(old)!==policyHash(event))throw Error('SPOOL_EVENT_CONFLICT');rows.set(event.id,event);}
   return [...rows.values()].filter(e=>e.authorizationId===authorizationId);
  },
 };
}
