import {buildWorker,approvedSources} from './build-worker.mjs';
import {readFile,writeFile,mkdir,copyFile,chmod,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const hash=b=>createHash('sha256').update(b).digest('hex');
if(process.versions.node.split('.')[0]!=='22')throw Error('NODE_22_REQUIRED');
await buildWorker(root);
const sourceFiles=[...approvedSources,'tsconfig.worker.json','scripts/vps/build-worker.mjs','scripts/vps/package-disabled.mjs',...['offline-deny.cjs','check.sh','install.sh','rollback.sh'].map(f=>'scripts/vps/disabled/'+f)].sort();
const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,hash(await readFile(path.join(root,f)))])));
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const digest=hash(JSON.stringify(sourceHashes));
const releaseId=`sw-disabled-${commit.slice(0,12)}-${digest.slice(0,16)}`;
const output=path.join(root,'dist-vps-disabled',releaseId);
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
for(const f of ['main.cjs','metafile.json'])await copyFile(path.join(root,'dist-worker',f),path.join(output,f));
for(const f of ['offline-deny.cjs','check.sh','install.sh','rollback.sh'])await copyFile(path.join(root,'scripts/vps/disabled',f),path.join(output,f));
const config={version:1,publishingEnabled:false,owner:'VPS',protocol:'CANONICAL',schema:'public',databasePoolSize:3,workerConcurrency:2,journal:'shared-object-storage',media:'versioned-object-storage',metaVersion:'v26.0',linkedinVersion:'202609',reconciliationIntervalMs:5000};
await writeFile(path.join(output,'disabled.json'),JSON.stringify(config,null,2)+'\n');
await writeFile(path.join(output,'release.json'),JSON.stringify({releaseId,commit,sourceTree:'working-tree overlay; hashes authoritative, not a clean commit release',sourceDigest:digest,sourceHashes,nodeMajor:22,buildNode:process.version,esbuild:JSON.parse(await readFile(path.join(root,'node_modules/esbuild/package.json'))).version,runtimeDependencies:[],builtins:['node:crypto','node:perf_hooks'],publishingEnabled:false},null,2)+'\n');
const files=['main.cjs','metafile.json','offline-deny.cjs','check.sh','install.sh','rollback.sh','disabled.json','release.json'];
await writeFile(path.join(output,'SHA256SUMS'),(await Promise.all(files.sort().map(async f=>`${hash(await readFile(path.join(output,f)))}  ${f}`))).join('\n')+'\n');
for(const f of files)await chmod(path.join(output,f),f.endsWith('.sh')?0o700:0o600);
const archive=output+'.tar.gz';
// Python stdlib creates deterministic headers, gzip timestamp and ordered entries.
execFileSync('python3',['-c',`import tarfile,gzip,io,pathlib,sys
p=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2])
with out.open('wb') as raw:
 with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as gz:
  with tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT) as t:
   for f in sorted(p.iterdir()):
    b=f.read_bytes(); i=tarfile.TarInfo(p.name+'/'+f.name); i.size=len(b); i.mode=0o700 if f.suffix=='.sh' else 0o600; i.mtime=0; i.uid=i.gid=0; i.uname=i.gname=''; t.addfile(i,io.BytesIO(b))`,output,archive],{cwd:root});
await writeFile(archive+'.sha256',`${hash(await readFile(archive))}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({releaseId,output,archive,sha256:hash(await readFile(archive))}));
