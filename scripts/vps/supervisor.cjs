'use strict';
// Dependency-injected lifetime adapter. No provider, database, network or secret loading.
// The approved future composition must supply the same durable portable runtime.
const {setTimeout:delay}=require('node:timers/promises');
function createSupervisor({runtime,signal,intervalMs=60000,emit=()=>{},wait=ms=>delay(ms,undefined,{signal})}){
 if(!runtime||typeof runtime.tick!=='function'||typeof runtime.close!=='function'||!signal||!Number.isInteger(intervalMs)||intervalMs<1||intervalMs>60000)throw Error('INVALID_SUPERVISOR');
 let active=false,started=false,closing;
 function close(){return closing??=(async()=>{await runtime.close();})();}
 async function run(){
  if(started)throw Error('SUPERVISOR_ALREADY_STARTED');started=true;
  const stop=()=>{void close().catch(()=>emit({event:'shutdown-failed'}));};signal.addEventListener('abort',stop,{once:true});
  try{
   while(!signal.aborted){
    const start=performance.now();active=true;
    try{await runtime.tick();emit({event:'tick-complete'});}catch{emit({event:'tick-failed'});}finally{active=false;}
    if(signal.aborted)break;
    // Missed ticks do not create overlapping admission loops or a catch-up storm.
    try{await wait(Math.max(1,intervalMs-(performance.now()-start)));}catch{if(!signal.aborted)throw Error('SUPERVISOR_WAIT_FAILED');}
   }
  }finally{signal.removeEventListener('abort',stop);await close();}
 }
 return {run,close,get active(){return active;}};
}
module.exports={createSupervisor};
