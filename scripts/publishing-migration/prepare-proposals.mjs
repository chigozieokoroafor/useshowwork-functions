/** Review bundle only. Intentionally provides no migration executor. */
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='docs/publishing-migration-proposals';await mkdir(directory,{recursive:true});
const files=['schema.sql','ownership-schema.sql','intent-actions-schema.sql','canonical-schema.sql','eligibility-schema.sql','authorization-schema.sql','provider-schema.sql','integration-schema.sql','production-grants.proposal.sql'];
const proposals=[];
for(const [i,file] of files.entries()){
 const source='scripts/publishing-reliability/'+file,bytes=await readFile(source);const target=String(i+1).padStart(2,'0')+'-'+file;await copyFile(source,directory+'/'+target);proposals.push({source,file:target,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await copyFile('scripts/publishing-migration/production-preflight.sql',directory+'/production-preflight.sql');
await writeFile(directory+'/manifest.json',JSON.stringify({version:1,executableProductionMigration:false,requires:'Approved read-only baseline, reviewed ALTER/data conversion for existing PublishingJob and constraints, application Prisma compatibility, role/tenant grants review, sanitized-clone rehearsal, signed migration approval',proposals},null,2)+'\n');
console.log('REVIEW_PROPOSALS_PREPARED; NOT AN EXECUTABLE PRODUCTION MIGRATION');
