'use strict';
// Explicit LOCAL source edit utility; inventory is captured BEFORE this script.
const fs=require('node:fs'),ts=require('typescript');
const inventory=JSON.parse(fs.readFileSync('docs/publishing-stage-4b-reconstructed-inventory.json','utf8')).files;
const writer=/(?:calendarPostAsset|calendarPost|socialConnection|socialCalendar|calendarCollaborator|media|mediaSection|folder|project)\.(?:create\w*|update\w*|upsert|delete\w*)|creator\.delete|deleteObject/;
const sender=/publishPostToInstagram|publishPostToTikTok|publishFacebook|publishLinkedIn|publishX|publishContainer|runPublishJob|runScheduled(?:Instagram|TikTok)?Publishing|runPublishingBatchScheduler|beginExternal|recoverExpired/;
const exempt=/^lib\/publishing\/(?:canonical|ownership|intentActions|externalAuthorization|validationAdapters|eligibilityPolicy|capabilityProviders|providerJournal|providerSpool|retryPolicy|transactionDatabase)/;
const previous=fs.existsSync('docs/publishing-stage-4c6-entrypoint-enforcement.json')?JSON.parse(fs.readFileSync('docs/publishing-stage-4c6-entrypoint-enforcement.json','utf8')).boundaries:[];
for(const file of new Set(previous.map(x=>x.file))){let source=fs.readFileSync(file,'utf8');source=source.replace(/\n  \/\* canonical-integration-boundary \*\/[^\n]*\/\* end-canonical-integration-boundary \*\/\n/g,'').replace(/^import \{ publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed \} from [^\n]+\n/gm,'');fs.writeFileSync(file,source);}
const manifest=[];
for(const r of inventory){if(exempt.test(r.file)||!r.file.endsWith('.ts')&&!r.file.endsWith('.tsx'))continue;
 let source=fs.readFileSync(r.file,'utf8');
 const ast=ts.createSourceFile(r.file,source,ts.ScriptTarget.Latest,true,r.file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS),edits=[];
 function visit(node){
  const fn=ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node);
  if(fn&&node.body&&ts.isBlock(node.body)&&node.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)){
   const name=node.name?.getText(ast)||(ts.isVariableDeclaration(node.parent)?node.parent.name.getText(ast):ts.isCallExpression(node.parent)?node.parent.expression.getText(ast)+':callback':'anonymous');
   let body=node.body.getText(ast);const nested=[];function collect(child){if(child!==node&&(ts.isFunctionDeclaration(child)||ts.isFunctionExpression(child)||ts.isArrowFunction(child)&&child.body?.getText(ast).includes('use server'))){nested.push(child);return;}ts.forEachChild(child,collect);}ts.forEachChild(node.body,collect);for(const child of nested)body=body.replace(child.getText(ast),'');if(body.slice(0,100).includes('canonical-integration-boundary'))return;const exported=node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
   const route=r.file.startsWith('app/api/')&&exported&&/^(GET|POST|PATCH|PUT|DELETE)$/.test(name)&&(writer.test(body)||sender.test(body)||/creator\.(?:update\w*|upsert|create\w*)/.test(body)&&/contentWorkspace|comped|isComped|isDeactivated|billingComplimentary/.test(body));
   const netlify=r.file.startsWith('netlify/functions/')&&sender.test(body)&&(name==='handler'||name==='schedule:callback');
   const legacy=!route&&!netlify&&(writer.test(body)||sender.test(body)||/creator\.(?:update\w*|upsert|create\w*)/.test(body)&&/contentWorkspace|comped|isComped|isDeactivated|billingComplimentary/.test(body)||/^(publishFacebook|publishLinkedIn|publishX|publishContainer|apiPost|deleteObject)$/.test(name)||/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+"(?:Publishing|CalendarPost|SocialConnection|SocialCalendar)/.test(body))&&!r.file.startsWith('app/api/')&&!r.file.startsWith('netlify/functions/');
   if(route||netlify||legacy){
    const id=r.file+'#'+name+'@'+(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1);
    let args='Array.from(arguments)';if(ts.isArrowFunction(node))args='['+node.parameters.filter(p=>ts.isIdentifier(p.name)).map(p=>p.name.getText(ast)).join(',')+']';
    const instruction=route||netlify?`return await invokePublishingEntrypoint<never>(${JSON.stringify(id)},${args});`:`await assertLegacyPublishingAllowed(${JSON.stringify(id)});`;
    edits.push({at:node.body.getStart(ast)+1,text:'\n  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { '+instruction+' } /* end-canonical-integration-boundary */\n'});manifest.push({file:r.file,id,kind:route?'route':netlify?'netlify':'legacy-function',bodyHash:r.functions.find(f=>f.name===name)?.bodyHash??null});
    // No need to fence nested callbacks inside an already fenced legacy function.
    if(legacy)return;
   }
  }ts.forEachChild(node,visit);
 }visit(ast);
 if(edits.length){for(const e of edits.sort((a,b)=>b.at-a.at))source=source.slice(0,e.at)+e.text+source.slice(e.at);
  const relative=r.file.startsWith('netlify/')?'../../lib/publishing/applicationBoundary':'@/lib/publishing/applicationBoundary';
  // Preserve use-server/use-client directives at the start of server-action files.
  const directive=source.match(/^(?:["']use (?:server|client)["'];?\s*)/);
  const imported=`import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from ${JSON.stringify(relative)};\n`;
  if(!source.includes('import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed }'))source=directive?source.slice(0,directive[0].length)+imported+source.slice(directive[0].length):imported+source;
  fs.writeFileSync(r.file,source);
 }
}
fs.writeFileSync('docs/publishing-stage-4c6-entrypoint-enforcement.json',JSON.stringify({boundaries:manifest},null,2)+'\n');console.log(JSON.stringify({files:new Set(manifest.map(x=>x.file)).size,boundaries:manifest.length}));
