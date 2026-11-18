import { contentModelConfig, knownModelContextWindow } from "@/lib/content/model";
import { possibleConflicts, type EvidenceConflict } from "./conflicts";
import type { KnowledgeSource } from "../retrieval";
import { sourceFingerprint } from "../retrieval";
import { chunkSource, passageText } from "./chunks";
import { buildQueries, type RetrievalRequest } from "./query";
import { diversify, hybridRank } from "./ranking";
import { embed, rerank, type Embedder, type Reranker, type Usage } from "./provider";
import { embeddingConfig, rankingConfig, numberSetting } from "./config";
import { tokenCount } from "./tokens";
import { loadVectors, indexStatus, knowledgeSql, type Sql } from "./store";
export interface RetrievalReport {
  mode:"hybrid"|"lexical"; reranking:"model"|"fallback"|"disabled";
  readiness:"ready"|"partial"|"unavailable"; reasons:string[];
  conflicts:EvidenceConflict[]; selectedIds:string[]; sourceCount:number; evidenceTokens:number; elapsedMs:number;
  embeddingUsage:Usage; rerankUsage:Usage;
}
const emptyUsage=():Usage=>({inputTokens:0,outputTokens:0,requests:0});
export async function retrieveHybrid(calendarId:string, sources:KnowledgeSource[], request:RetrievalRequest, budget=3500,
  deps:{sql?:Sql;embedder?:Embedder;reranker?:Reranker}={}) {
  const start=Date.now(), plan=buildQueries(request), config=rankingConfig();
  const indexedChunks = new Map<string, ReturnType<typeof chunkSource>>();
  const report:RetrievalReport={mode:"lexical",reranking:"disabled",readiness:"unavailable",reasons:[],conflicts:[],selectedIds:[],sourceCount:0,evidenceTokens:0,elapsedMs:0,embeddingUsage:emptyUsage(),rerankUsage:emptyUsage()};
  const vectors=new Map<string,number[]>(); let queryVectors:number[][]=[];
  try {
    const e=embeddingConfig(), sql=deps.sql||knowledgeSql;
    const [status, stored]=await Promise.all([indexStatus(sql,calendarId),loadVectors(sql,calendarId,e.key,config.maxVectors)]);
    const hashes=new Map(sources.map(s=>[s.id,sourceFingerprint([s])]));
    const ready=status.filter(s=>s.status==='READY'&&s.indexKey===e.key&&s.sourceHash===hashes.get(s.sourceId));
    report.readiness=ready.length===sources.length?'ready':'partial';
    if(report.readiness==='partial')report.reasons.push("INDEX_INCOMPLETE");
    if(stored.length>config.maxVectors)report.reasons.push("VECTOR_LIMIT_EXCEEDED");
    else {
      for(const p of stored)if(p.sourceHash===hashes.get(p.sourceId)&&p.embedding.length===e.dimensions) {
        vectors.set(p.id,p.embedding);
        if (typeof p.text === "string") indexedChunks.set(p.sourceId,[...(indexedChunks.get(p.sourceId)||[]),p]);
      }
      if(vectors.size){const result=await (deps.embedder||embed)(plan.queries); queryVectors=result.vectors;report.embeddingUsage=result.usage;report.mode="hybrid";}
    }
  } catch {report.reasons.push("SEMANTIC_UNAVAILABLE");}
  const chunks=sources.flatMap(s=>indexedChunks.get(s.id)?.sort((a,b)=>a.ordinal-b.ordinal) || chunkSource(s));
  let ranked=hybridRank(chunks,plan,vectors,queryVectors,config);
  if(process.env.KNOWLEDGE_RERANK_ENABLED==='true' && ranked.length) {
    try {
      const result=await (deps.reranker||rerank)(JSON.stringify({instructions:plan.primary,platforms:request.platforms,objective:request.objective,audience:request.audience}),ranked.map(r=>r.passage));
      const scores=new Map(result.scores.map(s=>[s.id,s.relevance]));
      ranked=ranked.filter(p=>(scores.get(p.passage.id)||0)>0).map(p=>({...p,score:(scores.get(p.passage.id)||0)+p.score})).sort((a,b)=>b.score-a.score);
      report.reranking="model";report.rerankUsage=result.usage;
    } catch {report.reranking="fallback";report.reasons.push("RERANK_UNAVAILABLE");}
  }
  const selected:typeof chunks=[], parts:string[]=[];
  // Ranked neighbour inclusion only: an irrelevant adjacent chunk cannot displace stronger evidence.
  const rankedIds=new Set(ranked.map(r=>r.passage.id));
  const add=(p:typeof chunks[number])=>{
    if(selected.some(s=>s.id===p.id))return;
    const part=passageText(p), joined=[...parts,part].join("\n");
    if(tokenCount(joined)>budget)return;
    selected.push(p);parts.push(part);
  };
  const ordered=diversify(ranked);
  // Fill the evidence budget by relevance; add eligible neighbours only if space remains.
  for(const item of ordered) {
    add(item.passage);
    if(selected.length>=12)break;
  }
  for(const item of [...selected]) {
    const next=chunks.find(c=>c.sourceId===item.sourceId&&c.ordinal===item.ordinal+1&&c.heading===item.heading&&rankedIds.has(c.id));
    if(next && selected.length<12)add(next);
  }
  report.conflicts=possibleConflicts(selected);
  report.selectedIds=selected.map(p=>p.id);report.sourceCount=new Set(selected.map(p=>p.sourceId)).size;
  const evidence=parts.join("\n");report.evidenceTokens=tokenCount(evidence);report.elapsedMs=Date.now()-start;
  return {evidence,report,passages:selected};
}
export function contextBudget(request:RetrievalRequest) {
  // The same generation code caps output at 30k. Include instructions/schema/scheduling overhead and safety margin.
  const config=contentModelConfig();
  const model=config.model;
  const knownWindow=knownModelContextWindow(model);
  const window=numberSetting("KNOWLEDGE_GENERATION_CONTEXT_WINDOW",knownWindow,1,2_000_000);
  return Math.max(0,Math.min(numberSetting("KNOWLEDGE_CONTEXT_TOKENS",7000,1000,12000),window-30000-config.reasoningTokens-10000-tokenCount(JSON.stringify(request))));
}
export function assertGenerationFits(instructions:string,input:string,outputTokens:number,model=process.env.OPENAI_MODEL||"gpt-4.1") {
  const window=numberSetting("KNOWLEDGE_GENERATION_CONTEXT_WINDOW",knownModelContextWindow(model),1,2_000_000);
  if(tokenCount(instructions)+tokenCount(input)+outputTokens+2048>window)throw Error("The content request exceeds the configured model context window. Reduce the date range or instructions.");
}
