export const CHUNK_VERSION = "structure-v1";
export function numberSetting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export function hybridEnabled(calendarId: string) {
  if (process.env.KNOWLEDGE_HYBRID_ENABLED !== "true") return false;
  const selected = process.env.KNOWLEDGE_HYBRID_WORKSPACES?.split(",").map(s => s.trim()).filter(Boolean);
  return !selected?.length || selected.includes(calendarId);
}
export function embeddingConfig() {
  const model = process.env.KNOWLEDGE_EMBEDDING_MODEL?.trim();
  if (!model) throw new Error("KNOWLEDGE_EMBEDDING_MODEL is required");
  const version = process.env.KNOWLEDGE_EMBEDDING_VERSION?.trim() || "1";
  const dimensions = numberSetting("KNOWLEDGE_EMBEDDING_DIMENSIONS", 512, 64, 3072);
  if (!Number.isInteger(dimensions)) throw new Error("Invalid embedding dimensions");
  return { model, version, dimensions, key: `${CHUNK_VERSION}:${model}:${version}:${dimensions}` };
}
export function rankingConfig() {
  return {
    candidates: numberSetting("KNOWLEDGE_CANDIDATES", 24, 4, 40),
    rrfK: numberSetting("KNOWLEDGE_RRF_K", 60, 1, 100),
    contextWeight: numberSetting("KNOWLEDGE_CONTEXT_QUERY_WEIGHT", 0.15, 0, 0.5),
    semanticWeight: numberSetting("KNOWLEDGE_SEMANTIC_WEIGHT", 1, 0, 3),
    minCosine: numberSetting("KNOWLEDGE_MIN_COSINE", 0.25, 0, 1),
    maxVectors: numberSetting("KNOWLEDGE_MAX_VECTORS", 5000, 1, 20000),
  };
}
