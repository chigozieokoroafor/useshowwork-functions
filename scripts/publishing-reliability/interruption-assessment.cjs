'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const artifact='/tmp/showwork-consumer-final-10.json';const before=fs.readFileSync(artifact,'utf8');
const directories=()=>fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('sw-gateway-stage-'));
const original=new Set(directories());
const child=spawn(process.execPath,[path.join(__dirname,'lifecycle-assessment.cjs'),'--smoke','--native'],{stdio:['ignore','pipe','pipe']});
let ready=false,output='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
child.stdout.on('data',data=>{output+=data;if(!ready&&output.includes('isolated-staging-ready')){ready=true;child.kill('SIGTERM');}});
child.stderr.resume();child.on('exit',(code,signal)=>{clearTimeout(timer);try{assert.equal(ready,true);assert.equal(code,1);assert.equal(fs.readFileSync(artifact,'utf8'),before);assert.deepEqual(directories().filter(d=>!original.has(d)),[]);const result={success:true,productionAccess:false,completedArtifactPreserved:true,syntheticClusterRemoved:true};fs.writeFileSync('/tmp/showwork-consumer-interruption.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}catch{console.error({check:'INTERRUPTION_CHECK_FAILED',ready,code,signal,artifactPreserved:fs.readFileSync(artifact,'utf8')===before,clustersRemoved:directories().filter(d=>!original.has(d)).length===0});process.exitCode=1;}});
