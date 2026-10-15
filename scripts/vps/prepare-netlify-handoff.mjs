/** Builds the intended Netlify function tree. No CLI, network or deployment. */
import {mkdir,readdir,readFile,writeFile,rm,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const retiredPublishingFunctions=['publish-post-background.ts','social-publish-cron.ts'];
export async function prepareNetlifyHandoff(repository=root){
 const source=path.join(repository,'netlify/functions'),output=path.join(repository,'netlify/functions-vps');
 await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
 const retained=[];
 for(const file of (await readdir(source)).sort()){
  if(!file.endsWith('.ts'))throw Error('UNREVIEWED_NETLIFY_FUNCTION_FILE');
  if(retiredPublishingFunctions.includes(file))continue;
  const bytes=await readFile(path.join(source,file));await copyFile(path.join(source,file),path.join(output,file));
  retained.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 const manifest={version:1,functionsDirectory:'netlify/functions-vps',retired:retiredPublishingFunctions,retained,productionMeasured:false,publishingScheduleInvocationsPerDayRemoved:1440,backgroundInvocationsRemoved:'one per previous publishing dispatch, plus any retries; telemetry required'};
 await writeFile(path.join(output,'../publishing-handoff-manifest.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await prepareNetlifyHandoff()));
