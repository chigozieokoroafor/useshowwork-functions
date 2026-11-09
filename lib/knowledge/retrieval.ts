import { createHash } from "node:crypto";

export type KnowledgeSource = { id: string; originalName: string; extractedText: string | null; websiteUrl?: string | null };
export function sourceFingerprint(sources: KnowledgeSource[]) {
  return createHash("sha256").update(JSON.stringify([...sources].sort((a, b) => a.id.localeCompare(b.id)).map(s => [s.id, s.originalName, s.websiteUrl, s.extractedText]))).digest("hex");
}
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
const synonyms = [ ["price", "pricing", "cost", "charge", "fee", "rate"], ["refund", "return", "cancel", "cancellation"], ["delivery", "shipping", "deliver"], ["service", "product", "offer", "package"] ];
/** Rank passages from the entire source, never just the beginning of a file. */
export function retrievePassages(sources: KnowledgeSource[], query: string, budget = 18000) {
  const terms = new Set(words(query));
  for (const group of synonyms) if (group.some(t => terms.has(t))) group.forEach(t => terms.add(t));
  const chunks = sources.flatMap(source => {
    const text = source.extractedText?.trim() ?? "";
    const result: { source: KnowledgeSource; offset: number; text: string; score: number }[] = [];
    for (let offset = 0; offset < text.length; offset += 1000) {
      const passage = text.slice(offset, offset + 1400);
      const tokens = new Set(words(passage));
      const score = [...terms].reduce((sum, term) => sum + (tokens.has(term) ? 1 : 0), 0);
      result.push({ source, offset, text: passage, score });
    }
    return result;
  });
  chunks.sort((a, b) => b.score - a.score || a.offset - b.offset || a.source.id.localeCompare(b.source.id));
  const selected: typeof chunks = [];
  let used = 0;
  // Give each source an opportunity to contribute; then fill with highest relevance.
  const seen = new Set<string>();
  const candidates = [...chunks.filter(c => { if (seen.has(c.source.id)) return false; seen.add(c.source.id); return true; }), ...chunks];
  for (const chunk of candidates) {
    if (selected.includes(chunk) || selected.some(c => c.source.id === chunk.source.id && Math.abs(c.offset - chunk.offset) < 1000)) continue;
    const label = `[Source: ${chunk.source.originalName}; passage ${chunk.offset + 1}${chunk.source.websiteUrl ? `; ${chunk.source.websiteUrl}` : ""}]\n`;
    if (used + label.length + chunk.text.length > budget) continue;
    selected.push(chunk); used += label.length + chunk.text.length;
  }
  return selected.map(c => `[Source: ${c.source.originalName}; passage ${c.offset + 1}${c.source.websiteUrl ? `; ${c.source.websiteUrl}` : ""}]\n${c.text}`).join("\n\n");
}

