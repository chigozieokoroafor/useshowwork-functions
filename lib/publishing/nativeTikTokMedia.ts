/** Reuse Showwork's TikTok conversion policy on checksum-verified immutable bytes. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareTikTokImage,validateTikTokSourceVideo,validateTikTokMediaProbe,tikTokConversionArgs,type MediaProbe} from '../tiktokMediaPolicy';
import {resolveTikTokProbe,resolveTikTokConverter} from '../tiktokProbe';
import type {TikTokCreator} from '../tiktokSettings';
const run=promisify(execFile);
export async function prepareCanonicalTikTokMedia(input:{bytes:Buffer;type:string;fileKey:string;mediaType:string;creator:TikTokCreator}):Promise<{bytes:Buffer;type:'image/jpeg'|'video/mp4'}|null>{
 if(input.mediaType==='PHOTO'){
  if(input.bytes.length>100*1024*1024)throw Error('TIKTOK_IMAGE_SOURCE_TOO_LARGE');
  const bytes=await prepareTikTokImage(input.bytes,input.fileKey);if(bytes.length>20*1024*1024)throw Error('TIKTOK_PREPARED_IMAGE_TOO_LARGE');return {bytes,type:'image/jpeg'};
 }
 if(input.mediaType!=='VIDEO')throw Error('TIKTOK_MEDIA_TYPE_REQUIRED');
 const directory=await mkdtemp(join(tmpdir(),'showwork-canonical-media-'));
 try{
  const source=join(directory,'source'),output=join(directory,'video.mp4');await writeFile(source,input.bytes);
  const probeBinary=await resolveTikTokProbe();const inspect=async(file:string):Promise<MediaProbe>=>JSON.parse((await run(probeBinary,['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file],{timeout:10000,maxBuffer:1024*1024})).stdout);
  const probe=await inspect(source);validateTikTokSourceVideo(probe,input.bytes.length,input.creator.max_video_post_duration_sec);
  let compatible=['video/mp4','video/quicktime','video/webm'].includes(input.type)&&(!(probe.format?.format_name||'').includes('matroska')||input.type==='video/webm');try{validateTikTokMediaProbe(probe,input.bytes.length,'VIDEO',input.creator.max_video_post_duration_sec);}catch{compatible=false;}
  if(compatible)return null;
  const args=tikTokConversionArgs(source,output,probe);args[args.indexOf('-protocol_whitelist')+1]='file,pipe';
  await run(await resolveTikTokConverter(),args,{timeout:45000,maxBuffer:1024*1024});
  const size=(await stat(output)).size,result=await inspect(output);validateTikTokMediaProbe(result,size,'VIDEO',input.creator.max_video_post_duration_sec);
  const duration=Number(probe.format?.duration||probe.streams?.find(s=>s.codec_type==='video')?.duration);if(Math.abs(duration-Number(result.format?.duration))>Math.max(0.5,duration*0.002))throw Error('TIKTOK_CONVERSION_INCOMPLETE');
  return {bytes:await readFile(output),type:'video/mp4'};
 }finally{await rm(directory,{recursive:true,force:true});}
}
