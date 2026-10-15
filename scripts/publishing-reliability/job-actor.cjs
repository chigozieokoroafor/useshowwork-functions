'use strict';
const fs=require('node:fs'),{randomUUID}=require('node:crypto'),{PrismaClient}=require('@prisma/client');
const {load}=require('../../tests/helpers/load-typescript.cjs');
const c=JSON.parse(fs.readFileSync(process.argv[2])),url=new URL(c.url);
if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/showwork_gateway_stage_')||url.searchParams.get('sslaccept')!=='strict')throw new Error('STAGING_ONLY');
const db=new PrismaClient({datasources:{db:{url:c.url}},log:[]}),{createReliablePublishingStore}=load('lib/publishing/reliableStore.ts'),{createReliableWorker}=load('lib/publishing/reliableWorker.ts');const store=createReliablePublishingStore(db);
async function main(){
 if(c.mode==='admit-and-hang'){const l=await store.leader(randomUUID());await store.admit(l,'INSTAGRAM',randomUUID(),new Date());process.send({checkpoint:'admitted',owner:l.owner,epoch:String(l.epoch)});setInterval(()=>{},1000);return;}
 const job=await store.findJob(c.jobId);
 if(c.mode==='prepare-and-hang'){await store.prepare(job,randomUUID());process.send({checkpoint:'prepared'});setInterval(()=>{},1000);return;}
 const worker=createReliableWorker(store,async j=>{const id='synthetic-confirmed-'+j.id;fs.appendFileSync(c.effectFile,JSON.stringify({jobId:j.id,remoteId:id})+'\n',{mode:0o600});if(c.mode==='publish-and-hang'){process.send({checkpoint:'external-accepted'});return new Promise(()=>{});}return id;});
 const value=await worker.run(job);await worker.close();await db.$disconnect();process.send({checkpoint:'done',state:value.state});
}
main().catch(e=>{process.send({failed:e.code||e.name});process.exitCode=1;db.$disconnect();});
