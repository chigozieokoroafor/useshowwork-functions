import { db } from "@/lib/db";
import { runWeeklyBusinessResearch } from "@/lib/openai";
import { canAccessContentWorkspace } from "@/lib/contentWorkspaceUsage";

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Runs daily (see the matching cron route and Netlify scheduled
 * function) but only actually researches a calendar once its last
 * research is at least a week old.
 *
 * The daily check itself is cheap and just a database query; the
 * real cadence is enforced by aiLastResearchedAt, not by how often
 * this job happens to run. This is more robust against a missed or
 * delayed run than relying on a strict weekly cron schedule.
 *
 * Only calendars that already have a business summary are researched.
 * This means at least one business document has been uploaded and the
 * AI has existing business context to improve.
 *
 * AI Research is included in the Content Workspace subscription.
 * It does not consume the customer's monthly interactive AI generation
 * or regeneration allowance because this is an internal scheduled
 * background process.
 */
export async function runScheduledAiBusinessResearch() {
  const cutoff = new Date(
    Date.now() - ONE_WEEK_MS
  );

  const dueCalendars = await db.socialCalendar.findMany({
    where: {
      aiBusinessSummary: {
        not: null,
      },

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
       * Only calendars whose owner has Content Workspace access
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
      const updatedSummary =
        await runWeeklyBusinessResearch({
          existingSummary:
            calendar.aiBusinessSummary,
          clientName:
            calendar.clientName,
        });

      await db.socialCalendar.update({
        where: {
          id: calendar.id,
        },

        data: {
          aiBusinessSummary:
            updatedSummary,

          aiBusinessSummaryUpdatedAt:
            new Date(),

          aiLastResearchedAt:
            new Date(),
        },
      });

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