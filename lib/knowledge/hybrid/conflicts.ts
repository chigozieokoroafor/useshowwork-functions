import type { Passage } from "./chunks";
export interface EvidenceConflict { passageIds:string[]; sourceIds:string[]; reason:"POSSIBLE_PRICE_CONFLICT"|"POSSIBLE_POLICY_CONFLICT" }
/** Conservative hints for review, never automatic source priority or truth resolution. */
export function possibleConflicts(passages:Passage[]):EvidenceConflict[] {
  const conflicts:EvidenceConflict[]=[];
  const prices=new Map<string,{value:string;passage:Passage}[]>();
  for(const passage of passages)for(const line of passage.text.split("\n")) {
    const cells=line.split("|").map(s=>s.trim().replace(/^"|"$/g,""));
    if(cells.length>=3 && /\d/.test(cells[1]) && /GBP|USD|NGN|EUR|CAD|AUD|₦|£|\$|€/i.test(cells.slice(1).join(" "))) {
      const key=cells[0].toLowerCase();prices.set(key,[...(prices.get(key)||[]),{value:cells.slice(1).join("|"),passage}]);
    }
  }
  for(const values of prices.values())if(new Set(values.map(v=>v.value)).size>1 && new Set(values.map(v=>v.passage.sourceId)).size>1)conflicts.push({reason:"POSSIBLE_PRICE_CONFLICT",passageIds:values.map(v=>v.passage.id),sourceIds:[...new Set(values.map(v=>v.passage.sourceId))]});
  for(let i=0;i<passages.length;i++)for(let j=i+1;j<passages.length;j++) {
    const a=passages[i],b=passages[j];
    if(a.sourceId!==b.sourceId && a.heading.trim().toLowerCase()===b.heading.trim().toLowerCase() && /refund|cancellation|return policy/i.test(a.heading) && a.text!==b.text)
      conflicts.push({reason:"POSSIBLE_POLICY_CONFLICT",passageIds:[a.id,b.id],sourceIds:[a.sourceId,b.sourceId]});
  }
  return conflicts.slice(0,8);
}
