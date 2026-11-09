import { db } from "@/lib/db";

export const creativeGenerationEnabled = () => process.env.CONTENT_CREATIVE_PIPELINE_ENABLED === "true";
export interface RecentContent { platform: string; hook: string; idea: string; caption: string }
export async function recentContentMemory(calendarId: string): Promise<RecentContent[]> {
  if (!creativeGenerationEnabled() && process.env.CONTENT_BRIEF_GENERATION_ENABLED === "false") return [];
  const posts = await db.calendarPost.findMany({
    where: { calendarId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 60,
    select: { platform: true, hook: true, contentIdea: true, caption: true },
  });
  const seen = new Set<string>();
  return posts.flatMap(post => {
    const key = `${post.hook || ""}\n${post.contentIdea || ""}\n${post.caption || ""}`.trim();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [{ platform: post.platform, hook: (post.hook || "").slice(0, 220), idea: (post.contentIdea || "").slice(0, 400), caption: (post.caption || "").slice(0, 300) }];
  }).slice(0, 30);
}
export type CreativeModel = (request: { instructions: string; input: string; maxOutputTokens: number; timeoutMs: number; attempts: number; jsonSchema: { name: string; schema: Record<string, unknown> } }) => Promise<string>;

