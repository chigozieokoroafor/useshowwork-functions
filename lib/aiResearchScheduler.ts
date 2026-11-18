import { db } from "@/lib/db";
import { queueBusinessResearch, executeBusinessResearch } from "@/lib/knowledge/research";
import { canAccessContentWorkspace } from "@/lib/contentWorkspaceUsage";

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Weekly research creates a separate cited run; it never rewrites business facts.
 * The protected cron endpoint must be invoked by the deployment scheduler.
 * One workspace per invocation bounds external-call duration.
 */
export async function runScheduledAiBusinessResearch() {
  const cutoff = new Date(
    Date.now() - ONE_WEEK_MS
  );

  const dueCalendars = await db.socialCalendar.findMany({
    where: {
      businessDocuments: { some: { extractedText: { not: null } } },
      researchRuns: { none: { createdAt: { gte: new Date(Date.now() - 86400000) } } },

      OR: [
        {
          aiLastResearchedAt: null,
        },
        {
          aiLastResearchedAt: {
            lt: cutoff,
          },
        },
      ],

      /*
       * Only calendars whose owner has Marketing Workspace access
       * should receive scheduled AI research.
       *
       * We intentionally fetch the owner billing fields below rather
       * than relying on the old standalone AI subscription fields.
       */
      manager: {
        OR: [
          {
            contentWorkspaceBillingStatus: "ACTIVE",
          },
          {
            contentWorkspaceBillingStatus: "TRIAL",
            contentWorkspaceTrialEndsAt: {
              gt: new Date(),
            },
          },
          {
            isComped: true,
          },
          {
            workspaceCompedUntil: { gt: new Date() },
          },
        ],
      },
    },

    take: 1,
    orderBy: [{ aiLastResearchedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    select: {
      id: true,
      clientName: true,
      aiBusinessSummary: true,
      manager: {
  select: {
    id: true,
    contentWorkspacePlan: true,
    contentWorkspaceBillingStatus: true,
    contentWorkspaceBillingCycle: true,
    contentWorkspaceTrialEndsAt: true,
    isComped: true,
    compedUntil: true,
    billingComplimentaryGrants: true, workspaceCompedPlan: true, workspaceCompedUntil: true,
  },
},
    },
  });

  let researched = 0;
  let failed = 0;

  for (const calendar of dueCalendars) {
    /*
     * The database filter handles the normal case, but check access
     * again before making the external AI call. This keeps the actual
     * execution protected if billing state changed after the query.
     */
    if (!canAccessContentWorkspace(calendar.manager)) {
      continue;
    }

    try {
      const run = await queueBusinessResearch(calendar.id, "Research current audience needs, industry developments and evidence-backed content experiments. Flag uncertain business identity and do not infer private business facts.");
      await executeBusinessResearch(run.id);
      const completed = await db.businessResearchRun.findUnique({ where: { id: run.id }, select: { status: true } });
      if (completed?.status !== "SUCCEEDED") { failed++; continue; }

      researched++;
    } catch (error) {
      console.error(
        `Weekly AI research failed for calendar ${calendar.id}:`,
        error
      );

      failed++;
    }
  }

  return {
    checked: dueCalendars.length,
    researched,
    failed,
  };
}