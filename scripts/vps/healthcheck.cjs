#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
// No HTTP listener or database connection. Missing/stale heartbeat is unhealthy.
function checkHealth(value,now=Date.now()){
 return !!value&&value.mode==='synthetic-staging'&&value.state==='running'&&Number.isFinite(value.timestamp)&&now-value.timestamp>=0&&now-value.timestamp<=90000&&value.publishingEnabled===false;
}
if(require.main===module){
 try{const file='/run/showwork-publishing/health.json';const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let state;try{if(!fs.fstatSync(fd).isFile())throw Error();state=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}if(!checkHealth(state))throw Error();console.log('SYNTHETIC_WORKER_HEALTHY');}
 catch{console.error('WORKER_NOT_HEALTHY');process.exitCode=1;}
}
module.exports={checkHealth};
