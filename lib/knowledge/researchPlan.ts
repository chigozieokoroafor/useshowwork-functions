export type ResearchPlan = { goal: string; audience: string; priorities: string; excludedDomains: string[] };
export type ResearchFeedback = Record<string, { verdict: "useful" | "irrelevant" | "incorrect"; note: string }>;
export function parseResearchPlan(value: unknown): ResearchPlan {
  const p = value as Partial<ResearchPlan> | null;
  if (!p || [p.goal, p.audience, p.priorities].some(v => typeof v !== "string" || v.length > 1200) || !Array.isArray(p.excludedDomains) || p.excludedDomains.length > 30) throw Error("Invalid research plan.");
  const excludedDomains = p.excludedDomains.filter(v => typeof v !== "string" || v.trim()).map(v => {
    if (typeof v !== "string") throw Error("Invalid excluded domain.");
    const host = new URL(v.includes("://") ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host)) throw Error("Enter valid source domains.");
    return host;
  });
  return { goal: p.goal!.trim(), audience: p.audience!.trim(), priorities: p.priorities!.trim(), excludedDomains: [...new Set(excludedDomains)] };
}
export function sourceAllowed(url: string, excluded: string[]) {
  try { const u = new URL(url); return ["https:", "http:"].includes(u.protocol) && !excluded.some(d => u.hostname === d || u.hostname.endsWith(`.${d}`)); } catch { return false; }
}
export function feedbackText(feedback: unknown): string {
  if (!feedback || typeof feedback !== "object") return "";
  return JSON.stringify(feedback).slice(0, 6000);
}

