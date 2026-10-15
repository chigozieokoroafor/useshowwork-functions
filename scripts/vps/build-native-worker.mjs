// Local packaging only. No credentials or environment files are read.
import {build} from 'esbuild';
import {mkdir,writeFile,rm} from 'node:fs/promises';
// A failed rebuild must not leave a previous runnable artifact available.
await rm('dist-worker-native',{recursive:true,force:true});
const result=await build({entryPoints:['workers/publishing/run.ts'],bundle:true,platform:'node',target:'node22',format:'cjs',packages:'external',outfile:'dist-worker-native/run.cjs',metafile:true,write:false,tsconfig:'tsconfig.json',logLevel:'silent'});
// The native composition must never pull in the Next application or Prisma client.
if(Object.keys(result.metafile.inputs).some(p=>p.startsWith('app/')||p==='lib/db.ts'||p==='lib/auth.ts')||Object.values(result.metafile.outputs).some(o=>o.imports.some(i=>!i.path.startsWith('node:')&&!['pg','@aws-sdk/client-s3','sharp','heic-convert','dotenv'].includes(i.path))))throw Error('NATIVE_WORKER_APPLICATION_DEPENDENCY_REJECTED');
await mkdir('dist-worker-native',{recursive:true});for(const output of result.outputFiles)await writeFile(output.path,output.contents);await writeFile('dist-worker-native/metafile.json',JSON.stringify(result.metafile,null,2)+'\n');
console.log('NATIVE_WORKER_BUILD_OK; runtime dependencies pg, @aws-sdk/client-s3, sharp and heic-convert must be supplied by the reviewed release');
