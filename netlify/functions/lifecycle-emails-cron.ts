import { schedule } from "@netlify/functions";

// Runs once a day, calling the protected API route above rather than
// duplicating its logic here — this file is intentionally thin, just
// the scheduling glue. process.env.URL is provided automatically by
// Netlify at runtime (your production site's real URL), no need to
// set it yourself.
export const handler = schedule("@daily", async () => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;

  try {
    const res = await fetch(`${siteUrl}/api/cron/lifecycle-emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const summary = await res.json();
    console.log("Lifecycle email cron run completed:", summary);
  } catch (err) {
    console.error("Lifecycle email cron run failed:", err);
  }

  return { statusCode: 200 };
});