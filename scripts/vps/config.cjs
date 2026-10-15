'use strict';
const fs=require('node:fs');
const expected={environment:'preparation',publishingEnabled:false,applicationDirectory:'/home/showwork/app',serviceUser:'showwork',databaseBackendLimit:5,heavyTransactionLimit:3,consumerLimit:2,attemptsPerConsumer:8,consumerDurationMs:600000,tickIntervalMs:60000,shutdownDeadlineMs:30000};
function validateConfig(config){
 if(!config||Object.keys(config).sort().join()!==Object.keys(expected).sort().join())throw Error('INVALID_WORKER_CONFIGURATION');
 for(const [key,value] of Object.entries(expected))if(config[key]!==value)throw Error('UNAPPROVED_WORKER_CONFIGURATION');
 return Object.freeze({...config});
}
function loadConfig(file){let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('INVALID_WORKER_CONFIGURATION');}return validateConfig(value);}
module.exports={loadConfig,validateConfig};
