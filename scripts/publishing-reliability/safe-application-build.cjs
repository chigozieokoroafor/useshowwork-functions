'use strict';
// Build a source-only copy with no dotenv files or inherited application secrets.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
(async()=>{
 const root=path.resolve(__dirname,'../..'),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'showwork-safe-build-'));
 try {
  for(const name of ['app','components','lib','prisma','public','types','styles','middleware.ts','instrumentation.ts','next.config.mjs','next-env.d.ts','tsconfig.json','tailwind.config.ts','postcss.config.mjs','postcss.config.js','package.json']) {
   try {await fs.cp(path.join(root,name),path.join(temporary,name),{recursive:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  // Synthetic read-only prerender data; writes and transactions are denied.
  await fs.writeFile(path.join(temporary,'lib/db.ts'),`import type { PrismaClient } from '@prisma/client';
const model = new Proxy({}, {get: (_target, method) => async () => {if(method==='findMany') return []; if(method==='findFirst'||method==='findUnique') return null; if(method==='count') return 0; if(method==='aggregate') return {_sum:{},_count:0}; throw Error('SAFE_BUILD_DATABASE_OPERATION_DENIED');}});
export const db = new Proxy({} as PrismaClient, {get: (_target,key) => key==='$disconnect'?async()=>{}:key==='$transaction'?async()=>{throw Error('SAFE_BUILD_TRANSACTION_DENIED');}:model});
export const nativeApplicationDatabase = db;
`);
  await fs.symlink(path.join(root,'node_modules'),path.join(temporary,'node_modules'),'dir');
  // Temporary build configuration only; repository and Netlify config are untouched.
  const config=path.join(temporary,'next.config.mjs');await fs.appendFile(config,'\n');
  const text=await fs.readFile(config,'utf8');await fs.writeFile(config,text.replace('outputFileTracingIncludes: {','experimental: { cpus: 2 },\n  outputFileTracingIncludes: {'));
  const guard=path.join(temporary,'deny-network.cjs');
  await fs.writeFile(guard,`'use strict';const net=require('node:net');const denied=()=>{throw Error('SAFE_BUILD_NETWORK_DENIED');};net.Socket.prototype.connect=denied;globalThis.fetch=async()=>{throw Error('SAFE_BUILD_FETCH_DENIED');};for(const name of ['node:http','node:https']){const module=require(name);module.request=denied;module.get=denied;}const dns=require('node:dns');dns.lookup=denied;dns.resolve=denied;`);
  const fonts=path.join(temporary,'mock-fonts.cjs');await fs.writeFile(fonts,"module.exports=new Proxy({},{get:()=>'@font-face { font-family: Synthetic; src: local(Arial); font-style: normal; font-weight: 100 900; }'});");
  const env={NEXT_FONT_GOOGLE_MOCKED_RESPONSES:fonts,PATH:process.env.PATH,HOME:temporary,TMPDIR:temporary,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',NODE_OPTIONS:`--require ${guard}`,DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/showwork_safe_build?connect_timeout=1',DIRECT_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/showwork_safe_build',JWT_SECRET:'synthetic-build-only-not-a-deployed-secret',NEXT_PUBLIC_APP_URL:'http://localhost:3000',R2_ACCOUNT_ID:'synthetic',R2_ACCESS_KEY_ID:'synthetic',R2_SECRET_ACCESS_KEY:'synthetic',R2_BUCKET_NAME:'synthetic',RESEND_API_KEY:'re_synthetic_build_only',PAYSTACK_SECRET_KEY:'synthetic'};
  const child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'build','--no-lint'],{cwd:temporary,env,stdio:'inherit'});
  const timer=setTimeout(()=>child.kill('SIGTERM'),600000);
  const code=await new Promise(resolve=>child.once('exit',(code)=>resolve(code??1)));clearTimeout(timer);process.exitCode=code;
 } finally {await fs.rm(temporary,{recursive:true,force:true});console.log('SAFE_BUILD_TEMPORARY_COPY_REMOVED');}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
