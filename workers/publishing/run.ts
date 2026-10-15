import dotenv from 'dotenv';
dotenv.config();
import {publishingHostConfiguration} from '@/lib/publishing/hostConfiguration';
/** Entry command is inert unless both --run and an explicit enable flag are supplied. */
async function main(){
 const nodeMajor = Number(process.versions.node.split('.')[0]); if (nodeMajor !== 22 && nodeMajor !== 25) throw Error('NODE_VERSION_UNSUPPORTED');
 const command=process.argv.slice(2);if(command.length!==1||!['--run','--check','--reconcile'].includes(command[0]))throw Error('NATIVE_WORKER_EXPLICIT_COMMAND_REQUIRED');
 const config=publishingHostConfiguration(process.env);
 if(command[0]==='--check'){console.log(JSON.stringify({state:config.enabled?'configured':'disabled',publishingEnabled:config.enabled,databaseConnected:false,maySend:false}));return;}
 const reconcile=command[0]==='--reconcile';
 if(!(reconcile?'reconciliation'in config&&config.reconciliation:config.enabled)){console.log(JSON.stringify({state:'disabled',publishingEnabled:false,databaseConnected:false,maySend:false}));return;}
 const {createNativePublishingHost}=await import('./nativeHost');
 const host=await createNativePublishingHost(config,globalThis.fetch,undefined,reconcile?'reconcile':'publish'),controller=new AbortController();
 const stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{while(!controller.signal.aborted){try{const cycle=await host.worker.pollOnce();const repaired=await host.repairProjections();console.log(JSON.stringify({event:'publishing-cycle',state:cycle.state,count:cycle.results.length,repaired,states:cycle.results.map(r=>r.state)}));}catch{console.error('PUBLISHING_CYCLE_FAILED');}
  if(controller.signal.aborted)break;
  await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,'pollMs'in config?config.pollMs:5000);controller.signal.addEventListener('abort',finish,{once:true});});
 }}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await host.close();}
}
void main().catch(()=>{console.error('NATIVE_WORKER_START_OR_SHUTDOWN_REJECTED');process.exitCode=78;});
