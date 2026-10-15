import { db } from "@/lib/db";
import {
  sendCalendarTrial2DaysLeftEmail,
  sendCalendarTrialFollowUpEmail,
  sendCalendarTrialEndsTodayEmail,
  sendCalendarTrialEndedEmail,
} from "@/lib/resend";

type ContentWorkspacePlan = "CREATOR" | "STUDIO" | "UNLIMITED";

// Runs once a day (see app/api/cron/calendar-trial-emails and the
// matching Netlify scheduled function). Each of the four stages is
// tracked by its own "sent at" timestamp on Creator, so running this
// more than once in a day — or on a day where a stage was already
// sent — never results in a duplicate email.
//
// contentWorkspaceBillingStatus stays "TRIAL" even after the trial's
// actual end date has passed. Access expiry is computed live from
// contentWorkspaceTrialEndsAt rather than requiring a stored status
// change. This allows one query to catch every stage, including the
// final "trial has ended" email.
export async function runCalendarTrialEmailCheck() {
  const trialing = await db.creator.findMany({
    where: {
      contentWorkspaceBillingStatus: "TRIAL",
      contentWorkspaceTrialEndsAt: { not: null },
    },
    select: {
      id: true,
      email: true,
      name: true,
      contentWorkspacePlan: true,
      contentWorkspaceTrialEndsAt: true,
      calendarTrial2DaysLeftEmailSentAt: true,
      calendarTrialFollowUpEmailSentAt: true,
      calendarTrialEndsTodayEmailSentAt: true,
      calendarTrialEndedEmailSentAt: true,
    },
  });

  let twoDaysLeftSent = 0;
  let followUpSent = 0;
  let endsTodaySent = 0;
  let endedSent = 0;
  let errors = 0;

  for (const creator of trialing) {
    if (
      !creator.contentWorkspaceTrialEndsAt ||
      !creator.contentWorkspacePlan
    ) {
      continue;
    }

    const plan = creator.contentWorkspacePlan as ContentWorkspacePlan;

    // Same calculation the dashboard trial banner uses, so the
    // email stages line up with the day-count a manager actually
    // sees on screen.
    const msLeft =
      creator.contentWorkspaceTrialEndsAt.getTime() - Date.now();

    const daysLeft = Math.ceil(
      msLeft / (1000 * 60 * 60 * 24)
    );

    try {
      if (
        daysLeft === 2 &&
        !creator.calendarTrial2DaysLeftEmailSentAt
      ) {
        await sendCalendarTrial2DaysLeftEmail({
          to: creator.email,
          name: creator.name,
          plan,
        });

        await db.creator.update({
          where: { id: creator.id },
          data: {
            calendarTrial2DaysLeftEmailSentAt: new Date(),
          },
        });

        twoDaysLeftSent++;
      } else if (
        daysLeft === 1 &&
        !creator.calendarTrialFollowUpEmailSentAt
      ) {
        await sendCalendarTrialFollowUpEmail({
          to: creator.email,
          name: creator.name,
          plan,
        });

        await db.creator.update({
          where: { id: creator.id },
          data: {
            calendarTrialFollowUpEmailSentAt: new Date(),
          },
        });

        followUpSent++;
      } else if (
        daysLeft === 0 &&
        !creator.calendarTrialEndsTodayEmailSentAt
      ) {
        await sendCalendarTrialEndsTodayEmail({
          to: creator.email,
          name: creator.name,
          plan,
        });

        await db.creator.update({
          where: { id: creator.id },
          data: {
            calendarTrialEndsTodayEmailSentAt: new Date(),
          },
        });

        endsTodaySent++;
      } else if (
        daysLeft < 0 &&
        !creator.calendarTrialEndedEmailSentAt
      ) {
        await sendCalendarTrialEndedEmail({
          to: creator.email,
          name: creator.name,
          plan,
        });

        await db.creator.update({
          where: { id: creator.id },
          data: {
            calendarTrialEndedEmailSentAt: new Date(),
          },
        });

        endedSent++;
      }
    } catch (err) {
      console.error(
        `Content Workspace trial email check failed for creator ${creator.id}:`,
        err
      );

      errors++;
    }
  }

  return {
    checked: trialing.length,
    twoDaysLeftSent,
    followUpSent,
    endsTodaySent,
    endedSent,
    errors,
  };
}