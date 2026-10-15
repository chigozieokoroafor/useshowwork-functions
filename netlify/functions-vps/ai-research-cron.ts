import { schedule } from "@netlify/functions";

// Runs once a day — the actual weekly cadence is enforced inside the
// job itself via aiLastResearchedAt, not by this schedule. Checking
// daily (rather than trying to schedule exactly once a week) means a
// missed or delayed run never pushes a calendar's research more than
// a day off course.
export const handler = schedule("0 3 * * *", async () => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;

  try {
    const res = await fetch(`${siteUrl}/api/cron/ai-research`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const summary = await res.json();
    console.log("AI business research cron run completed:", summary);
  } catch (err) {
    console.error("AI business research cron run failed:", err);
  }

  return { statusCode: 200 };
});