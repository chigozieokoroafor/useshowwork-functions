'use strict';
const fs=require('node:fs'),{PrismaClient}=require('@prisma/client');
const {load}=require('../../tests/helpers/load-typescript.cjs');
const config=JSON.parse(fs.readFileSync(process.argv[2]));const url=new URL(config.url);
if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/showwork_gateway_stage_')||url.searchParams.get('connection_limit')!=='1'||url.searchParams.get('sslaccept')!=='strict')throw new Error('STAGING_ONLY');
const db=new PrismaClient({datasources:{db:{url:config.url}},log:[]});
const {createReliablePublishingStore}=load('lib/publishing/reliableStore.ts');
createReliablePublishingStore(db).budget('worker',async tx=>{await tx.$queryRaw`SELECT 1`;process.send({held:true});await new Promise(r=>setTimeout(r,1800));}).then(()=>process.send({completed:true})).catch(e=>{process.send({failed:e.code||e.name});process.exitCode=1;}).finally(()=>db.$disconnect());
