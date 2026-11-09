import type { KnowledgeSource } from "./retrieval";
import { contentModelConfig, knownModelContextWindow } from "@/lib/content/model";
import { tokenCount } from "./hybrid/tokens";
export class KnowledgeCoverageError extends Error {
    constructor(message: string) { super(message); this.name = "KnowledgeCoverageError"; }
}
/** All stored extracted text, without ranking, sampling or character truncation. */
export function fullDocumentEvidence(sources: KnowledgeSource[]) {
    if (!sources.length) return "";
    if (sources.some(source => !source.extractedText?.trim())) throw new KnowledgeCoverageError("Some business documents have no readable extracted text. Process them successfully or remove them before generating from all documents. Scanned PDFs may require OCR.");
    const evidence = sources.map(source => `[SOURCE ${JSON.stringify(source.originalName)}; id=${source.id}${source.websiteUrl ? `; website=${source.websiteUrl}` : ""}]\n${source.extractedText}\n[END SOURCE]`).join("\n\n");
    const config = contentModelConfig();
    const configured = Number(process.env.KNOWLEDGE_GENERATION_CONTEXT_WINDOW || knownModelContextWindow(config.model));
    const window = Math.min(knownModelContextWindow(config.model), configured);
    if (!Number.isFinite(window) || tokenCount(evidence) + 64000 > window) throw new KnowledgeCoverageError("The complete documents exceed this model's available context. No document text was silently omitted. Use a smaller set of documents for this campaign.");
    return evidence;
}

