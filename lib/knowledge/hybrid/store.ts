import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { KnowledgeSource } from "../retrieval";
import { sourceFingerprint } from "../retrieval";
import { chunkSource, embeddingText, type Passage } from "./chunks";
import { embeddingConfig } from "./config";
import { embed, type Embedder } from "./provider";
export interface Sql { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }
export const knowledgeSql: Sql = { query: async <T>(sql: string, params: unknown[] = []) => ({ rows: await db.$queryRawUnsafe<T[]>(sql, ...params) }) };
interface IndexRow { sourceId:string; status:string; indexKey:string|null; sourceHash:string|null; errorCode:string|null }
export async function indexStatus(sql:Sql, calendarId:string) {
  return (await sql.query<IndexRow>('SELECT "sourceId",status,"indexKey","sourceHash","errorCode" FROM "KnowledgeSourceIndex" WHERE "calendarId"=$1',[calendarId])).rows;
}
export async function loadVectors(sql:Sql, calendarId:string, key:string, limit:number) {
  // Scope in SQL, including the current source/index relationship. Never global-vector search followed by filtering.
  return (await sql.query<Passage & {sourceHash:string;embedding:number[]}>(`
    SELECT p.id,p."sourceId",p.ordinal,p.title,p.url,p.heading,p.start,p."end",p.text,i."sourceHash",p.embedding FROM "KnowledgePassage" p
    JOIN "KnowledgeSourceIndex" i ON i."sourceId"=p."sourceId" AND i."calendarId"=p."calendarId" AND i.revision=p.revision
    JOIN "CalendarBusinessDocument" d ON d.id=i."sourceId" AND d."calendarId"=i."calendarId"
    WHERE p."calendarId"=$1 AND i."indexKey"=$2 AND i.status='READY'
    ORDER BY p.id LIMIT $3`,[calendarId,key,limit+1])).rows;
}
/** One resumable batch. Invoked by the developer's job runner/cron, never by generation. */
export async function processIndexBatch(sql:Sql = knowledgeSql, embedder:Embedder = embed, calendarId?:string) {
  const config=embeddingConfig();
  const token=randomUUID();
  const allowed = process.env.KNOWLEDGE_HYBRID_WORKSPACES?.split(",").map(s=>s.trim()).filter(Boolean);
  const scope = calendarId ? [calendarId] : allowed?.length ? allowed : null;
  // New model/chunker version requeues, including previously failed sources. No unchanged ready re-embedding.
  await sql.query(`UPDATE "KnowledgeSourceIndex" SET status='PENDING',attempts=0,"leaseToken"=NULL,"leaseUntil"=NULL,"sourceHash"=NULL,"indexKey"=$1,revision=revision+1,"nextAttemptAt"=CURRENT_TIMESTAMP
    WHERE ("indexKey" IS DISTINCT FROM $1) AND ($2::text[] IS NULL OR "calendarId"=ANY($2))
      AND (status<>'RUNNING' OR "leaseUntil"<CURRENT_TIMESTAMP) RETURNING "sourceId"`,[config.key,scope]);
  const claims=await sql.query<{sourceId:string;calendarId:string;revision:number}>(`
    UPDATE "KnowledgeSourceIndex" SET status='RUNNING',"leaseToken"=$1,"leaseUntil"=CURRENT_TIMESTAMP+interval '120 seconds',"updatedAt"=CURRENT_TIMESTAMP
    WHERE "sourceId"=(SELECT "sourceId" FROM "KnowledgeSourceIndex"
      WHERE ($2::text[] IS NULL OR "calendarId"=ANY($2)) AND attempts<5 AND "nextAttemptAt"<=CURRENT_TIMESTAMP
        AND (status='PENDING' OR (status='RUNNING' AND "leaseUntil"<CURRENT_TIMESTAMP))
      ORDER BY "nextAttemptAt","sourceId" FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING "sourceId","calendarId",revision`,[token,scope]);
  const claim=claims.rows[0]; if(!claim)return {worked:false};
  try {
    const source=(await sql.query<KnowledgeSource>('SELECT id,"originalName","extractedText","websiteUrl" FROM "CalendarBusinessDocument" WHERE id=$1 AND "calendarId"=$2',[claim.sourceId,claim.calendarId])).rows[0];
    if(!source)throw Error("SOURCE_CHANGED");
    const hash=sourceFingerprint([source]);
    const passages=chunkSource(source);
    if(passages.length>10000)throw Error("SOURCE_TOO_LARGE");
    const existing=(await sql.query<{id:string;embedding:number[]}>('SELECT id,embedding FROM "KnowledgePassage" WHERE "sourceId"=$1 AND "calendarId"=$2 AND revision=$3',[claim.sourceId,claim.calendarId,claim.revision])).rows;
    const ready=new Set(existing.filter(p=>p.embedding.length===config.dimensions).map(p=>p.id));
    const batch=passages.filter(p=>!ready.has(p.id)).slice(0,32);
    const result=batch.length?await embedder(batch.map(embeddingText)):{vectors:[],usage:{inputTokens:0,outputTokens:0,requests:0}};
    if(result.vectors.length!==batch.length || result.vectors.some(v=>v.length!==config.dimensions || v.some(n=>!Number.isFinite(n))))throw Error("INVALID_EMBEDDING_RESULT");
    // Atomically lock/check the lease before publishing the whole batch. A source change invalidates it.
    const payload=batch.map((p,i)=>({...p,embedding:result.vectors[i]}));
    await sql.query(`WITH current_index AS (
      SELECT "sourceId" FROM "KnowledgeSourceIndex" WHERE "sourceId"=$1 AND "calendarId"=$2 AND revision=$3 AND "leaseToken"=$4 FOR UPDATE
    ), cleaned AS (
      DELETE FROM "KnowledgePassage" WHERE "sourceId"=$1 AND "calendarId"=$2 AND revision<>$3 AND EXISTS(SELECT 1 FROM current_index)
    ) INSERT INTO "KnowledgePassage" (id,"sourceId","calendarId",revision,ordinal,title,url,heading,start,"end",text,embedding)
      SELECT x.id,$1,$2,$3,x.ordinal,x.title,x.url,x.heading,x.start,x."end",x.text,x.embedding
      FROM jsonb_to_recordset($5::jsonb) AS x(id text,ordinal integer,title text,url text,heading text,start integer,"end" integer,text text,embedding double precision[])
      WHERE EXISTS(SELECT 1 FROM current_index)
      ON CONFLICT(id) DO UPDATE SET embedding=EXCLUDED.embedding,revision=EXCLUDED.revision
      RETURNING id`,[claim.sourceId,claim.calendarId,claim.revision,token,JSON.stringify(payload)]);
    const finished=ready.size+batch.length>=passages.length;
    const updated=await sql.query(`UPDATE "KnowledgeSourceIndex" SET status=$5,"sourceHash"=$6,"indexKey"=$7,model=$8,"modelVersion"=$9,dimensions=$10,
      "leaseToken"=NULL,"leaseUntil"=NULL,"errorCode"=NULL,"inputTokens"="inputTokens"+$11,"updatedAt"=CURRENT_TIMESTAMP,"nextAttemptAt"=CURRENT_TIMESTAMP
      WHERE "sourceId"=$1 AND "calendarId"=$2 AND revision=$3 AND "leaseToken"=$4 RETURNING "sourceId"`,[claim.sourceId,claim.calendarId,claim.revision,token,finished?'READY':'PENDING',hash,config.key,config.model,config.version,config.dimensions,result.usage.inputTokens]);
    return {worked:true,committed:!!updated.rows.length,ready:finished,embedded:batch.length,inputTokens:result.usage.inputTokens};
  } catch(error) {
    const code=error instanceof Error && error.message==='SOURCE_TOO_LARGE'?'SOURCE_TOO_LARGE':'INDEXING_UNAVAILABLE';
    await sql.query(`UPDATE "KnowledgeSourceIndex" SET attempts=attempts+1,status=CASE WHEN attempts>=4 OR $5='SOURCE_TOO_LARGE' THEN 'FAILED' ELSE 'PENDING' END,
      "errorCode"=$5,"leaseToken"=NULL,"leaseUntil"=NULL,"nextAttemptAt"=CURRENT_TIMESTAMP+interval '60 seconds' * power(2,attempts),"updatedAt"=CURRENT_TIMESTAMP
      WHERE "sourceId"=$1 AND "calendarId"=$2 AND revision=$3 AND "leaseToken"=$4 RETURNING "sourceId"`,[claim.sourceId,claim.calendarId,claim.revision,token,code]);
    return {worked:true,error:code};
  }
}
