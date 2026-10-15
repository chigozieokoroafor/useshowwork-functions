/** Browser request compatibility. Metadata is a snapshot, never send authority. */
const pending=new Map<string,{operationId:string;body?:RequestInit['body'];headers:Headers}>();
export async function calendarMutationFetch(input:Parameters<typeof fetch>[0],init:RequestInit={}):Promise<Response> {
 const url=String(input),method=(init.method??'GET').toUpperCase();
 if(!/^\/(?:api\/(calendars\/|social-calendar\/|account\/deactivate$|admin\/|media\/|portfolio\/(?:media|sections)\/|sections\/|managed-projects\/[^/]+\/brief-attachments\/)|admin\/social-calendars\/)/.test(url)||['GET','HEAD'].includes(method))return fetch(input,init);
 const key=JSON.stringify([method,url,typeof init.body==='string'||init.body==null?init.body??null:crypto.randomUUID()]);let operation=pending.get(key);
 if(!operation){
  const headers=new Headers(init.headers),operationId=headers.get('idempotency-key')??crypto.randomUUID();headers.set('idempotency-key',operationId);
  let body=init.body;
  if(url.endsWith('/publish')&&method==='POST'){
   const original=JSON.parse(String(body??'{}'));
   const metadata=original.intentId&&original.destination?original:await (async()=>{const response=await fetch(url,{method:'GET',cache:'no-store'}),value=await response.json();if(!response.ok)throw Error(value.error??'Could not load the current publishing revision.');return value;})();
   if(metadata.protocol==='canonical'||original.intentId&&original.destination){
    if(original.action==='retry'&&!metadata.evidenceId&&!original.evidenceId)throw Error('This attempt needs verified provider evidence before retrying. A checkbox cannot authorize another send.');
    if(!metadata.destination)throw Error('Connect and select the intended publishing account first.');
    body=JSON.stringify({...original,action:original.action==='schedule'?metadata.nextSchedulingAction??'schedule':original.action,intentId:metadata.intentId,expectedRevision:metadata.expectedRevision,platform:metadata.platform,destination:metadata.destination,...(original.action==='publish'?{}:{dueAt:metadata.dueAt}),evidenceId:original.evidenceId??metadata.evidenceId});
   }
  }
  operation={operationId,body,headers};pending.set(key,operation);
  if(pending.size>100)pending.delete(pending.keys().next().value!);
 }
 // On transport/acknowledgement loss keep the exact operation and original
 // revision/destination payload. A subsequent user request replays that operation.
 const response=await fetch(input,{...init,headers:operation.headers,body:operation.body});
 if(response.ok||response.status<500)pending.delete(key);
 return response;
}
