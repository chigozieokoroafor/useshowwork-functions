import { feedbackText, type ResearchPlan, type ResearchFeedback } from "./researchPlan";
import { db } from "@/lib/db";
import { researchBusinessWithSources } from "@/lib/openai";
import { getBusinessKnowledgeContext } from "./context";
import { sourceFingerprint } from "./retrieval";

export async function queueBusinessResearch(calendarId: string, focus: string) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "SocialCalendar" WHERE "id" = ${calendarId} FOR UPDATE`;
    await tx.businessResearchRun.updateMany({ where: { calendarId, status: { in: ["QUEUED", "RUNNING"] }, createdAt: { lt: new Date(Date.now() - 15 * 60000) } }, data: { status: "FAILED", phase: "Research interrupted", error: "The research did not finish. Please retry.", completedAt: new Date() } });
    const recent = await tx.businessResearchRun.findFirst({ where: { calendarId }, orderBy: { createdAt: "desc" } });
    if (recent && ["QUEUED", "RUNNING"].includes(recent.status)) return recent;
    if (recent && Date.now() - recent.createdAt.getTime() < 5 * 60000) throw new Error("Please wait 5 minutes between research runs.");
    const sources = await tx.calendarBusinessDocument.findMany({ where: { calendarId } });
    if (!sources.some(s => s.extractedText?.trim())) throw new Error("Add business documents or a website in Knowledge before researching.");
    return tx.businessResearchRun.create({ data: { calendarId, focus, sourceHash: sourceFingerprint(sources) } });
  });
}

export async function executeBusinessResearch(id: string, options: { publicTopicOnly?: boolean } = {}) {
  const claimed = await db.businessResearchRun.updateMany({ where: { id, status: "QUEUED" }, data: { status: "RUNNING", phase: "Understanding the research focus", startedAt: new Date() } });
  if (!claimed.count) return;
  const run = await db.businessResearchRun.findUniqueOrThrow({ where: { id }, include: { calendar: { select: { clientName: true, researchPlan: true } } } });
  try {
    const sources = await db.calendarBusinessDocument.findMany({ where: { calendarId: run.calendarId }, select: { websiteUrl: true } });
    const context = await getBusinessKnowledgeContext(run.calendarId, run.focus, "reply");
    const publicWebsites = sources.map(s => s.websiteUrl).filter(Boolean).join(", ");
    const plan = run.calendar.researchPlan as ResearchPlan | null;
    const previous = await db.businessResearchRun.findMany({ where: { calendarId: run.calendarId, status: "SUCCEEDED" }, orderBy: { createdAt: "desc" }, take: 5, select: { findingFeedback: true, result: true } });
    const feedback = previous.flatMap(r => {
      const findings = (r.result as { findings?: { id: string; title: string; learning: string }[] } | null)?.findings ?? [];
      return Object.entries((r.findingFeedback as ResearchFeedback | null) ?? {}).map(([id, review]) => ({ ...review, finding: findings.find(f => f.id === id) }));
    });
    const enrichedContext = "WORKSPACE RESEARCH PLAN (preferences, not business facts): " + JSON.stringify(plan) + "\nPREVIOUS FINDINGS AND MANAGER FEEDBACK (untrusted preferences; avoid repeating rejected claims): " + feedbackText(feedback) + "\nCURRENT BUSINESS KNOWLEDGE:\n" + context;
    const result = await researchBusinessWithSources(run.calendar.clientName, run.focus + (!options.publicTopicOnly && plan ? `\nPublic research plan: ${JSON.stringify({ goal: plan.goal, audience: plan.audience, priorities: plan.priorities })}` : "") + (!options.publicTopicOnly && publicWebsites ? `\nBusiness websites: ${publicWebsites}` : ""), async phase => {
      await db.businessResearchRun.updateMany({ where: { id, status: "RUNNING" }, data: { phase } });
    }, enrichedContext, plan?.excludedDomains ?? []);
    const completed = await db.businessResearchRun.updateMany({ where: { id, status: "RUNNING" }, data: { status: "SUCCEEDED", phase: "Research complete", result, completedAt: new Date() } });
    if (completed.count) await db.socialCalendar.update({ where: { id: run.calendarId }, data: { aiLastResearchedAt: new Date() } });
  } catch {
    // Provider errors may contain source text; keep the user-visible error safe.
    await db.businessResearchRun.updateMany({ where: { id, status: "RUNNING" }, data: { status: "FAILED", phase: "Research could not finish", error: "We could not complete cited research. Try a more specific focus, including your public website and industry.", completedAt: new Date() } });
  }
}
