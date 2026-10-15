'use strict';
// Explicit offline Linux dependency check after a separately approved npm ci.
// Does not read production configuration, import the worker or connect anywhere.
const {execFileSync}=require('node:child_process');
const path=require('node:path');
async function main(){
 if(process.platform!=='linux'||process.versions.node.split('.')[0]!=='22')throw Error('LINUX_NODE_22_REQUIRED');
 for(const name of Object.keys(require('./package.json').dependencies))require.resolve(name);
 const sharp=require('sharp');await sharp({create:{width:2,height:2,channels:3,background:'#fff'}}).jpeg().toBuffer();
 const ffmpeg=require('ffmpeg-static'),ffprobe=require('ffprobe-static').path;
 for(const executable of [ffmpeg,ffprobe]){
  if(!executable||!path.isAbsolute(executable))throw Error('MEDIA_BINARY_REQUIRED');
  execFileSync(executable,['-version'],{timeout:10000,stdio:'pipe',env:{PATH:process.env.PATH}});
 }
 console.log(JSON.stringify({state:'dependencies-verified',platform:process.platform,arch:process.arch,maySend:false}));
}
main().catch(()=>{console.error('OFFLINE_DEPENDENCY_CHECK_FAILED');process.exitCode=78;});
