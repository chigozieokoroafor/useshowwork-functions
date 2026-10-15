/** Inactive Stage 4C.1 contract. No provider, route or global database dependencies. */
export type PublishingPlatform='INSTAGRAM'|'TIKTOK'|'FACEBOOK'|'LINKEDIN'|'X';
export type CanonicalPhase='READY'|'PREPARED'|'EXTERNAL_PENDING'|'PROVIDER_PENDING'|'CONFIRMED'|'REJECTED'|'OUTCOME_UNKNOWN'|'CANCELLED';
export interface PublicationIdentity { intentId:string; revision:number; generation:number }
export interface RevisionDestination { accountBindingId:string; accountVersion:number; calendarId:string; contentHash:string }
export interface CanonicalJob extends PublicationIdentity,RevisionDestination {
  id:string;postId:string;platform:PublishingPlatform;phase:CanonicalPhase;dueAt:Date;
  providerAccountId:string;connectionId:string;workerToken:string|null;remoteId:string|null;
}
export function publicationKey(i:PublicationIdentity):string {
  if(!/^[a-zA-Z0-9_-]{1,120}$/.test(i.intentId)||![i.revision,i.generation].every(n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647))throw Error('INVALID_PUBLICATION_IDENTITY');
  return `${i.intentId}:${i.revision}:${i.generation}`;
}
export function legacyProjection(phase:CanonicalPhase):'SCHEDULED'|'PUBLISHING'|'PUBLISHED'|'FAILED'|'NOT_SCHEDULED' {
  switch(phase){
    case 'READY':case 'PREPARED':return 'SCHEDULED';
    case 'EXTERNAL_PENDING':case 'PROVIDER_PENDING':case 'OUTCOME_UNKNOWN':return 'PUBLISHING';
    case 'CONFIRMED':return 'PUBLISHED';case 'REJECTED':return 'FAILED';case 'CANCELLED':return 'NOT_SCHEDULED';
  }
}
export function lifecycleAllows(from:CanonicalPhase,to:CanonicalPhase):boolean {
  const transitions:Record<CanonicalPhase,CanonicalPhase[]>={
    READY:['PREPARED','CANCELLED'],PREPARED:['PREPARED','EXTERNAL_PENDING','CANCELLED'],
    EXTERNAL_PENDING:['PROVIDER_PENDING','CONFIRMED','REJECTED','OUTCOME_UNKNOWN'],
    PROVIDER_PENDING:['CONFIRMED','REJECTED','OUTCOME_UNKNOWN'],OUTCOME_UNKNOWN:['PROVIDER_PENDING','CONFIRMED','REJECTED'],
    CONFIRMED:[],REJECTED:[],CANCELLED:[],
  };return transitions[from]?.includes(to)??false;
}
