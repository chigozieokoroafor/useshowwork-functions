/** Concise strategy contract; version 1 remains readable for saved reports. */
export type LegacyMonthlyStrategy = {
  version: 1;
  status: "READY" | "NEEDS_CONTEXT";
  title: string;
  objective: string;
  diagnosis: string;
  direction: string;
  rationale: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  challenges: string[];
  questions: string[];
  evidence: Array<{ sourceId: string; observation: string }>;
  contentMix: Array<{ decision: "CONTINUE" | "IMPROVE" | "TEST" | "PAUSE"; topic: string; format: string; sharePercent: number; reason: string }>;
  weeks: Array<{ week: number; theme: string; audience: string; hooks: string[]; proof: string; callToAction: string }>;
  channels: Array<{ platform: string; postsPerWeek: number; execution: string }>;
  measurement: { primaryMetric: string; successRule: string; review: string; experiment: string };
};
export type ContentStrategy = {
  version: 2;
  title: string;
  objective: string;
  working: string;
  diagnosis: string;
  direction: string;
  rationale: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  limitation: string;
  evidence: Array<{ sourceId: string; observation: string }>;
};
export type MonthlyStrategy = ContentStrategy | LegacyMonthlyStrategy;
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
export const monthlyStrategySchema = object({
  version: { type: "integer", enum: [2] },
  title: text(90), objective: text(180), working: text(240), diagnosis: text(240),
  direction: text(480), rationale: text(240), limitation: text(240),
  confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
  evidence: { type: "array", minItems: 1, maxItems: 3, items: object({ sourceId: text(200), observation: text(250) }) },
});

export function parseMonthlyStrategy(value: unknown, sourceIds?: Set<string>): ContentStrategy {
  function validate(v: unknown, schema: any): void {
    if (schema.enum && !schema.enum.includes(v)) throw Error("Invalid strategy value.");
    if (schema.type === "string" && (typeof v !== "string" || !v.trim() || v.length > schema.maxLength)) throw Error("Incomplete or overly long strategy text.");
    if (schema.type === "array") {
      if (!Array.isArray(v) || v.length < schema.minItems || v.length > schema.maxItems) throw Error("Incomplete strategy evidence.");
      v.forEach(item => validate(item, schema.items));
    }
    if (schema.type === "object") {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Invalid strategy.");
      const record = v as Record<string, unknown>;
      if (Object.keys(record).some(key => !(key in schema.properties))) throw Error("Unexpected strategy field.");
      for (const [key, child] of Object.entries(schema.properties)) validate(record[key], child);
    }
  }
  validate(value, monthlyStrategySchema);
  const strategy = value as ContentStrategy;
  if (sourceIds && strategy.evidence.some(item => !sourceIds.has(item.sourceId))) throw Error("Strategy references unavailable evidence.");
  return strategy;
}

export function strategySummary(strategy: MonthlyStrategy) {
  return {
    working: strategy.version === 2 ? strategy.working : strategy.contentMix.find(item => item.decision === "CONTINUE")?.reason || "No consistent winning pattern has been established yet.",
    limitation: strategy.version === 2 ? strategy.limitation : strategy.challenges[0] || "Available results do not establish causation.",
  };
}

export function strategyBrief(strategy: MonthlyStrategy): string {
  const summary = strategySummary(strategy);
  return [
    "CONTENT STRATEGY V2",
    strategy.title,
    `GOAL: ${strategy.objective}`,
    `WHAT IS WORKING: ${summary.working}`,
    `WHAT NEEDS ATTENTION: ${strategy.diagnosis}`,
    `RECOMMENDED DIRECTION: ${strategy.direction}`,
    `WHY: ${strategy.rationale}`,
    `EVIDENCE: ${strategy.evidence.slice(0, 3).map(item => item.observation).join("; ")}`,
    `UNCERTAINTY: ${summary.limitation}`,
    "Use this direction to develop a coherent calendar of specific, varied ideas grounded in business knowledge. The user chooses dates, duration, platforms, frequency and volume in the generator. Respect those settings; do not infer a schedule from the reporting period. Do not repeat a winning format across every post or treat unknown promotion as organic. Create drafts for review.",
  ].join("\n\n");
}
export const strategyScope = (platforms: string[]) => [...new Set(platforms)].sort().join(",") || "ALL";

/** Full available cohort summaries precede the model's limited caption sample. */
export function summarizeStrategyPosts(posts: Array<{ accountId?: string; platform: string; postType: string | null; publishedAt: Date | string | null; snapshots: Array<{ date: Date | string | null; reach: number | null; engagement: number | null }> }>) {
  const groups = new Map<string, { sourceId: string; platform: string; accountId?: string; format: string; observationAge: string; promotion: string; posts: number; reach: number[]; engagement: number[] }>();
  for (const post of posts) {
    const latest = post.snapshots.at(-1);
    const age = latest?.date && post.publishedAt ? (new Date(latest.date).getTime() - new Date(post.publishedAt).getTime()) / 86400000 : NaN;
    const bucket = !Number.isFinite(age) || age < 0 ? "unknown" : age < 7 ? "under 7 days" : age < 28 ? "7–27 days" : "28+ days";
    const key = `${post.accountId || "unknown"}:${post.platform}:${post.postType || "unknown"}:${bucket}`;
    const group = groups.get(key) || { sourceId: `cohort:${groups.size + 1}`, platform: post.platform, accountId: post.accountId, format: post.postType || "unknown", observationAge: bucket, promotion: "UNKNOWN", posts: 0, reach: [], engagement: [] };
    group.posts++;
    if (latest?.reach != null && Number.isFinite(latest.reach)) group.reach.push(latest.reach);
    if (latest?.engagement != null && Number.isFinite(latest.engagement)) group.engagement.push(latest.engagement);
    groups.set(key, group);
  }
  const median = (values: number[]) => { if (!values.length) return null; const sorted = [...values].sort((a,b)=>a-b), mid = Math.floor(sorted.length/2); return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2; };
  return [...groups.values()].map(({ reach, engagement, ...group }) => ({ ...group, medianReach: median(reach), reachCoverage: reach.length, medianEngagement: median(engagement), engagementCoverage: engagement.length, limitation: "Descriptive lifetime counters; broad age buckets are not controlled equal-age comparisons. Promotion and post objectives are unverified." }));
}
