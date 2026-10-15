import { preparationStatus } from "@/workers/publishing/status";
import { validateDisabledPublishingDeployment } from "@/lib/publishing/deploymentReadiness";
import {checkDisabledVpsComposition} from '@/workers/publishing/composition';

// No configuration, credentials, clients, timers or providers are loaded here.
if (process.argv.length === 3 && process.argv[2] === "--check") {
  if (Number(process.versions.node.split(".")[0]) !== 22) {
    console.error("WORKER_CHECK_FAILED: Node.js 22 is required.");
    process.exitCode = 78;
  } else {
    console.log(JSON.stringify(preparationStatus));
  }
} else if (process.argv.length === 4 && process.argv[2] === '--check-config') {
  try {
    const configuration=validateDisabledPublishingDeployment(JSON.parse(process.argv[3]));
    console.log(JSON.stringify({state:'disabled-deployment-check',configuration,publishingEnabled:false,databaseConnected:false,productionGo:false,runtimeImplemented:false}));
  } catch {
    console.error('WORKER_CONFIGURATION_REJECTED');process.exitCode=78;
  }
} else if(process.argv.length===4&&process.argv[2]==='--check-composition') {
  try {void checkDisabledVpsComposition(JSON.parse(process.argv[3])).then(status=>console.log(JSON.stringify(status))).catch(()=>{console.error('WORKER_COMPOSITION_REJECTED');process.exitCode=78;});}catch{console.error('WORKER_COMPOSITION_REJECTED');process.exitCode=78;}
} else {
  console.error("WORKER_START_BLOCKED: production runtime is not implemented.");
  process.exitCode = 78;
}
