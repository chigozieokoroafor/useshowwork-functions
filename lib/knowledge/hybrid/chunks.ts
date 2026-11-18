import { createHash } from "node:crypto";
import type { KnowledgeSource } from "../retrieval";
import { CHUNK_VERSION } from "./config";
import { tokenizer } from "./tokens";
export interface Passage {
  id: string; sourceId: string; title: string; url: string | null;
  heading: string; start: number; end: number; ordinal: number; text: string;
}
export function chunkSource(source: KnowledgeSource): Passage[] {
  const text = source.extractedText || "";
  const result: Passage[] = [];
  let heading = "", url = source.websiteUrl || null, start = 0, end = 0;
  const emit = () => {
    if (end <= start || !text.slice(start, end).trim()) return;
    const body = text.slice(start, end);
    const id = createHash("sha256").update(JSON.stringify([source.id, CHUNK_VERSION, source.originalName, url, heading, start, body])).digest("hex");
    result.push({ id, sourceId: source.id, title: source.originalName, url, heading, start, end, ordinal: result.length, text: body });
  };
  // Keep paragraphs, FAQ pairs and table rows together. Long lines split at sentence/word boundaries.
  const units: { start: number; end: number; line: string }[] = [];
  for (const match of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    let offset = match.index!;
    const finish = offset + match[0].length;
    while (offset < finish) {
      let stop = Math.min(offset + 1800, finish);
      if (stop < finish) {
        const boundary = text.lastIndexOf(" ", stop);
        if (boundary > offset + 600) stop = boundary + 1;
      }
      units.push({ start: offset, end: stop, line: text.slice(offset, stop) }); offset = stop;
    }
  }
  for (const unit of units) {
    const line = unit.line.trim();
    const isHeading = /^(#{1,6}\s|Page:|Sheet:|Q(?:uestion)?:)/.test(line) || (line.length > 0 && line.length < 100 && /:$/.test(line) && !/\d|\|/.test(line));
    if (isHeading) { emit(); heading = line; start = unit.start; end = unit.start; }
    if (line.includes("|") && /product|service|price|currency|amount|conditions/i.test(line) && !/\d/.test(line)) {
      heading = heading.split("\nTable columns:")[0] + "\nTable columns: " + line;
    }
    if (/^URL:\s*https?:\/\//.test(line)) url = line.slice(4).trim();
    const candidate = text.slice(start, unit.end);
    // Byte bound also protects pathological multilingual input; no truncated source text.
    if (end > start && (candidate.length > 2400 || tokenizer("cl100k_base").encode(candidate, [], []).length > 700)) {
      emit(); start = unit.start;
    }
    end = unit.end;
  }
  emit();
  return result;
}
export function passageText(p: Passage) {
  // JSON encoding keeps titles/URLs from forging source-header boundaries.
  return JSON.stringify({ sourceId: p.sourceId, chunkId: p.id, title: p.title, url: p.url, section: p.heading, characters: [p.start, p.end], evidence: p.text });
}
export function embeddingText(p: Passage) {
  return `${p.title}\n${p.heading}\n${p.text}`;
}
