// Offline packaging of the actual worker. Never installs dependencies or services.
import {readFile,writeFile,mkdir,copyFile,chmod,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if(process.versions.node.split('.')[0]!=='22')throw Error('NODE_22_REQUIRED');
const hash=b=>createHash('sha256').update(b).digest('hex');
execFileSync(process.execPath,['scripts/vps/build-native-worker.mjs'],{cwd:root,stdio:'pipe'});
const graph=JSON.parse(await readFile(path.join(root,'dist-worker-native/metafile.json')));
const original=JSON.parse(await readFile(path.join(root,'package-lock.json')));
const names=['pg','@aws-sdk/client-s3','sharp','heic-convert','ffmpeg-static','ffprobe-static'];
const dependencies=Object.fromEntries(names.map(n=>[n,original.packages['node_modules/'+n].version]));
const manifest={name:'showwork-publishing-worker',version:'1.0.0',private:true,engines:{node:'22.x'},dependencies};
const packages={'':manifest};
function resolve(from,name){
 let directory=from;
 while(directory){const candidate=directory+'/node_modules/'+name;if(original.packages[candidate])return candidate;const at=directory.lastIndexOf('/node_modules/');directory=at<0?'':directory.slice(0,at);}
 const candidate='node_modules/'+name;return original.packages[candidate]?candidate:undefined;
}
function include(key){
 if(packages[key])return;
 const value=original.packages[key];if(!value||!value.integrity||!value.resolved?.startsWith('https://registry.npmjs.org/'))throw Error('UNREVIEWED_RUNTIME_DEPENDENCY:'+key);
 packages[key]={...value};delete packages[key].dev;delete packages[key].devOptional;
 for(const name of new Set([...Object.keys(value.dependencies??{}),...Object.keys(value.optionalDependencies??{}),...Object.keys(value.peerDependencies??{})])){
  const target=resolve(key,name);if(target)include(target);else if(!value.optionalDependencies?.[name]&&!value.peerDependenciesMeta?.[name]?.optional)throw Error('MISSING_LOCKED_DEPENDENCY:'+name);
 }
}
for(const name of names)include('node_modules/'+name);
const lock={name:manifest.name,version:manifest.version,lockfileVersion:3,requires:true,packages};
const sourceFiles=[...Object.keys(graph.inputs),'package-lock.json','scripts/vps/package-native-disabled.mjs','scripts/vps/build-native-worker.mjs','scripts/vps/disabled/offline-deny.cjs','scripts/vps/disabled/install.sh','scripts/vps/disabled/rollback.sh','scripts/vps/native-disabled/check.sh','scripts/vps/native-disabled/dependencies-check.cjs'].sort();
const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,hash(await readFile(path.join(root,f)))])));
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const releaseId=`sw-disabled-native-${commit.slice(0,12)}-${hash(JSON.stringify(sourceHashes)).slice(0,16)}`;
const output=path.join(root,'dist-vps-native-disabled',releaseId);
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
const files={
 'run.cjs':await readFile(path.join(root,'dist-worker-native/run.cjs')),
 'metafile.json':JSON.stringify(graph,null,2)+'\n',
 'package.json':JSON.stringify(manifest,null,2)+'\n',
 'package-lock.json':JSON.stringify(lock,null,2)+'\n',
 'disabled.env':'SHOWWORK_PUBLISHING_ENABLED=false\nSHOWWORK_CANONICAL_APPLICATION_ENABLED=false\nPUBLISHING_RECONCILIATION_ENABLED=false\n',
 'release.json':JSON.stringify({releaseId,commit,sourceTree:'working-tree overlay; source hashes authoritative',sourceHashes,nodeMajor:22,publishingEnabled:false,runtimeDependencies:dependencies,dependenciesInstalled:false,linuxRuntimeVerified:false},null,2)+'\n',
};
for(const name of ['offline-deny.cjs','install.sh','rollback.sh'])files[name]=await readFile(path.join(root,'scripts/vps/disabled',name));
for(const name of ['check.sh','dependencies-check.cjs'])files[name]=await readFile(path.join(root,'scripts/vps/native-disabled',name));
for(const [name,bytes]of Object.entries(files)){await writeFile(path.join(output,name),bytes);await chmod(path.join(output,name),name.endsWith('.sh')?0o700:0o600);}
await writeFile(path.join(output,'SHA256SUMS'),Object.keys(files).sort().map(f=>`${hash(files[f])}  ${f}`).join('\n')+'\n');
// Fixed headers: identical inputs generate identical archives. Never include .env or node_modules.
const archive=output+'.tar.gz';
execFileSync('python3',['-c',`import tarfile,gzip,io,pathlib,sys
p=pathlib.Path(sys.argv[1])
with open(sys.argv[2],'wb') as raw:
 with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as gz:
  with tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT) as t:
   for f in sorted(p.iterdir()):
    b=f.read_bytes(); i=tarfile.TarInfo(p.name+'/'+f.name); i.size=len(b); i.mode=0o700 if f.suffix=='.sh' else 0o600; i.mtime=0; i.uid=i.gid=0; i.uname=i.gname=''; t.addfile(i,io.BytesIO(b))`,output,archive]);
const sha256=hash(await readFile(archive));await writeFile(archive+'.sha256',`${sha256}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({releaseId,output,archive,sha256,dependenciesInstalled:false}));
