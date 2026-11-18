import type { Passage } from "./chunks";
import type { QueryPlan } from "./query";
import { rankingConfig } from "./config";
const STOP = new Set("a an and are as at be by can content create for from how i in is it of on or our that the their this to use we with you your".split(" "));
export function terms(text: string) {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || []).filter(t => !STOP.has(t));
}
export interface Ranked { passage: Passage; score: number; semantic: number; lexical: number }
function lexicalSearcher(passages: Passage[]) {
  const docs = passages.map(p => {
    const tokens = terms(`${p.title} ${p.heading} ${p.text}`);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return { counts, length: tokens.length };
  });
  const average = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1);
  const frequencies = new Map<string, number>();
  for (const doc of docs) for (const token of doc.counts.keys()) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  return (query: string): Ranked[] => {
    const q = [...new Set(terms(query))].slice(0, 128);
    return passages.map((passage, i) => {
      const doc = docs[i]; let score = 0;
      for (const term of q) {
        const tf = doc.counts.get(term) || 0;
        const df = frequencies.get(term) || 0;
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / (average || 1)));
      }
      for (const phrase of query.matchAll(/"([^"\n]{2,100})"/g)) if (`${passage.title} ${passage.text}`.toLowerCase().includes(phrase[1].toLowerCase())) score += 5;
      return { passage, score, lexical: score, semantic: 0 };
    }).filter(p => p.score > 0).sort((a,b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id));
  };
}
export function lexicalRank(passages: Passage[], query: string): Ranked[] {
  return lexicalSearcher(passages)(query);
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i=0; i<a.length; i++) { dot += a[i]*b[i]; aa += a[i]*a[i]; bb += b[i]*b[i]; }
  return aa && bb ? dot / Math.sqrt(aa*bb) : -1;
}
/** RRF uses ranks, never adds BM25 scores to cosine scores. Secondary queries carry less weight. */
export function hybridRank(passages: Passage[], plan: QueryPlan, vectors: Map<string, number[]>, queryVectors: number[][], config = rankingConfig()): Ranked[] {
  const lexical = lexicalSearcher(passages);
  const merged = new Map<string, Ranked>();
  const add = (list: Ranked[], weight: number) => list.slice(0, config.candidates).forEach((item, rank) => {
    const old = merged.get(item.passage.id) || { ...item, score: 0 };
    old.score += weight / (config.rrfK + rank + 1);
    old.lexical = Math.max(old.lexical, item.lexical); old.semantic = Math.max(old.semantic, item.semantic);
    merged.set(item.passage.id, old);
  });
  plan.queries.forEach((q, i) => {
    add(lexical(q), i === 0 ? 1 : config.contextWeight);
    if (queryVectors[i]) add(passages.filter(p => vectors.has(p.id)).map(p => {
      const semantic = cosine(queryVectors[i], vectors.get(p.id)!);
      return { passage:p, semantic, lexical:0, score:semantic };
    }).filter(p => p.score >= config.minCosine).sort((a,b)=>b.score-a.score), config.semanticWeight * (i === 0 ? 1 : config.contextWeight));
  });
  return [...merged.values()].sort((a,b)=>b.score-a.score || a.passage.id.localeCompare(b.passage.id)).slice(0, config.candidates);
}
/** Diversity is a penalty, not equal-source quotas. Only identical evidence is removed: small differences may be conflicting facts. */
export function diversify(candidates: Ranked[]): Ranked[] {
  const remaining = [...candidates], output: Ranked[] = [], sourceCounts = new Map<string,number>();
  while (remaining.length) {
    remaining.sort((a,b) => b.score / (1 + 0.3*(sourceCounts.get(b.passage.sourceId)||0)) - a.score / (1 + 0.3*(sourceCounts.get(a.passage.sourceId)||0)));
    const next = remaining.shift()!;
    const normalize = (text: string) => text.replace(/\s+/g," ").trim();
    const duplicate = output.some(p => normalize(p.passage.text) === normalize(next.passage.text));
    if (!duplicate) { output.push(next); sourceCounts.set(next.passage.sourceId, (sourceCounts.get(next.passage.sourceId)||0)+1); }
  }
  return output;
}
