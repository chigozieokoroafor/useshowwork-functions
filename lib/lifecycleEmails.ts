import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  sendWelcomeEmail,
  sendPortfolioInviteEmail,
  sendProjectManagementIntroEmail,
  sendCreativoPromoEmail,
  sendDeliverReminderEmail,
} from "@/lib/resend";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// How many creators get processed at once, rather than one at a time.
// The earlier version awaited every email send and every database
// write sequentially per creator before moving to the next one —
// with enough accounts, that easily exceeds a platform's function
// timeout. Batches of 10 in parallel cuts wall-clock time roughly
// 10x, and is conservative enough not to overwhelm Resend's own
// rate limits.
const CONCURRENCY = 10;

function daysSince(date: Date): number {
  return (Date.now() - date.getTime()) / DAY_MS;
}

interface RunSummary {
  processed: number;
  welcomeSent: number;
  portfolioInviteSent: number;
  projectManagementSent: number;
  creativoPromoSent: number;
  deliverReminderSent: number;
  errors: { creatorId: string; message: string }[];
}

type CreatorForCheck = {
  id: string;
  name: string | null;
  email: string;
  lifecycleSequenceStartedAt: Date | null;
  welcomeEmailSentAt: Date | null;
  portfolioInviteEmailSentAt: Date | null;
  projectManagementEmailSentAt: Date | null;
  creativoPromoEmailSentAt: Date | null;
  lastDeliveryReminderSentAt: Date | null;
  projects: { createdAt: Date }[];
};

// Handles exactly one creator: figures out which steps are due, sends
// every applicable email for them in parallel (there's rarely more
// than one due on a given day, but during the initial backfill —
// or if a run gets skipped for a few days — several can become due
// at once), then writes every resulting field change in a single
// combined database update instead of one write per step.
async function processCreator(creator: CreatorForCheck, summary: RunSummary): Promise<void> {
  const updates: Prisma.CreatorUpdateInput = {};

  let sequenceStart = creator.lifecycleSequenceStartedAt;
  if (!sequenceStart) {
    sequenceStart = new Date();
    updates.lifecycleSequenceStartedAt = sequenceStart;
  }
  const elapsedDays = daysSince(sequenceStart);

  const tasks: Promise<void>[] = [];

  if (!creator.welcomeEmailSentAt) {
    tasks.push(
      sendWelcomeEmail({ to: creator.email, name: creator.name }).then(() => {
        updates.welcomeEmailSentAt = new Date();
        summary.welcomeSent++;
      })
    );
  }

  if (elapsedDays >= 1 && !creator.portfolioInviteEmailSentAt) {
    tasks.push(
      sendPortfolioInviteEmail({ to: creator.email, name: creator.name }).then(() => {
        updates.portfolioInviteEmailSentAt = new Date();
        summary.portfolioInviteSent++;
      })
    );
  }

  if (elapsedDays >= 2 && !creator.projectManagementEmailSentAt) {
    tasks.push(
      sendProjectManagementIntroEmail({ to: creator.email, name: creator.name }).then(() => {
        updates.projectManagementEmailSentAt = new Date();
        summary.projectManagementSent++;
      })
    );
  }

  if (elapsedDays >= 2 && !creator.creativoPromoEmailSentAt) {
    tasks.push(
      sendCreativoPromoEmail({ to: creator.email, name: creator.name }).then(() => {
        updates.creativoPromoEmailSentAt = new Date();
        summary.creativoPromoSent++;
      })
    );
  }

  if (elapsedDays >= 2) {
    const neverSent = !creator.lastDeliveryReminderSentAt;
    const dueAgain = creator.lastDeliveryReminderSentAt
      ? Date.now() - creator.lastDeliveryReminderSentAt.getTime() >= WEEK_MS
      : false;

    if (neverSent || dueAgain) {
      const mostRecentProject = creator.projects[0];
      const deliveredRecently = mostRecentProject && daysSince(mostRecentProject.createdAt) < 7;

      if (!deliveredRecently) {
        tasks.push(
          sendDeliverReminderEmail({ to: creator.email, name: creator.name }).then(() => {
            updates.lastDeliveryReminderSentAt = new Date();
            summary.deliverReminderSent++;
          })
        );
      }
    }
  }

  // Every applicable email for this one creator, sent in parallel
  // rather than one after another.
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") {
      const message = result.reason instanceof Error ? result.reason.message : "Unknown error";
      console.error(`Lifecycle email error for creator ${creator.id}:`, result.reason);
      summary.errors.push({ creatorId: creator.id, message });
    }
  }

  // One write for everything that succeeded on this creator, instead
  // of up to six separate round trips.
  if (Object.keys(updates).length > 0) {
    await db.creator.update({ where: { id: creator.id }, data: updates });
  }
}

/**
 * The actual decision logic for the lifecycle email sequence — called
 * by the protected API route (for manual testing) and the Netlify
 * Scheduled Function (for the real daily run). Processes creators in
 * concurrent batches rather than one at a time, and writes each
 * creator's field updates in a single combined call — both changes
 * exist specifically to keep this comfortably inside a serverless
 * function's execution time limit as the number of creators grows.
 */
export async function runLifecycleEmailCheck(): Promise<RunSummary> {
  const summary: RunSummary = {
    processed: 0,
    welcomeSent: 0,
    portfolioInviteSent: 0,
    projectManagementSent: 0,
    creativoPromoSent: 0,
    deliverReminderSent: 0,
    errors: [],
  };

  const creators = await db.creator.findMany({
    where: { isDeactivated: false },
    select: {
      id: true,
      name: true,
      email: true,
      lifecycleSequenceStartedAt: true,
      welcomeEmailSentAt: true,
      portfolioInviteEmailSentAt: true,
      projectManagementEmailSentAt: true,
      creativoPromoEmailSentAt: true,
      lastDeliveryReminderSentAt: true,
      projects: {
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  summary.processed = creators.length;

  for (let i = 0; i < creators.length; i += CONCURRENCY) {
    const batch = creators.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((creator) =>
        processCreator(creator, summary).catch((err) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          console.error(`Lifecycle email error for creator ${creator.id}:`, err);
          summary.errors.push({ creatorId: creator.id, message });
        })
      )
    );
  }

  return summary;
}