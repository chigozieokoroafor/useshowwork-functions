'use strict';
const fs=require('node:fs'),{PrismaClient}=require('@prisma/client');
const {load}=require('../../tests/helpers/load-typescript.cjs'),{compose}=require('../../tests/helpers/native-publishing-composition.cjs'),{createMockSocialApis}=require('./mock-social-apis.cjs');
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),url=new URL(input.url);
if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/showwork_gateway_stage_')||url.searchParams.get('sslaccept')!=='strict')throw Error('Disposable staging only');
const db=new PrismaClient({datasources:{db:{url:input.url}},log:[]});
let engine,apis;
async function main(){
 apis=await createMockSocialApis({pendingReads:0,onAccepted:async post=>{fs.appendFileSync(input.ledger,JSON.stringify({postId:post,reference:'published-'+post})+'\n',{mode:0o600});if(input.mode==='accepted-and-hang'){process.send({checkpoint:'accepted'});await new Promise(()=>{});}},onStatus:async()=>{if(input.mode==='operation-and-hang'){process.send({checkpoint:'operation-persisted'});await new Promise(()=>{});}}});
 const {createReliablePublishingStore}=load('lib/publishing/reliableStore.ts'),store=createReliablePublishingStore(db);
 engine=compose(store,apis,{performance:!!input.optimized,onJournal:async(job)=>{if(input.optimized&&(input.mode==='operation-and-hang'||input.mode==='journal-and-hang')){process.send({checkpoint:input.mode==='operation-and-hang'?'operation-persisted':'journaled'});await new Promise(()=>{});}},worker:input.mode==='prepared-and-hang'?{preflight:async(job)=>{await apis.run(job.postId,()=>engine.native.preflight(job));process.send({checkpoint:'prepared'});await new Promise(()=>{});}}:{}});
 const result=await engine.worker.run(await store.findJob(input.jobId));await engine.worker.close();await db.$disconnect();process.send({checkpoint:'completed',state:result.state});apis.close();
}
main().catch(async e=>{process.send({failure:e.code||e.name});process.exitCode=1;await db.$disconnect();});
