#!/usr/bin/env node
'use strict';
// Preparation entrypoint. Intentionally imports no ORM, provider or dotenv loader.
const path=require('node:path');
const {loadConfig}=require('./config.cjs');
try{
 const config=loadConfig(path.resolve(__dirname,'../../deploy/vps/worker.config.json'));
 if(process.argv.length!==3||process.argv[2]!=='--check')throw Error('PRODUCTION_RUNNER_NOT_ACTIVATED');
 console.log(JSON.stringify({state:'preparation-only',configurationValid:true,publishingEnabled:config.publishingEnabled,databaseConnected:false,serviceUser:config.serviceUser}));
}catch{console.error('WORKER_START_BLOCKED: preparation package cannot publish or connect to a database.');process.exitCode=78;}
