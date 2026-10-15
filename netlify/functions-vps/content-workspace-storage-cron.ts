import { schedule } from "@netlify/functions";

// Runs once a day to release expired Content Workspace storage
// reservations. The actual cleanup logic lives in the protected
// API route rather than being duplicated here.
export const handler = schedule("@daily", async () => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;

  try {
    const res = await fetch(
      `${siteUrl}/api/cron/content-workspace-storage`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
      }
    );

    const summary = await res.json();

    console.log(
      "Content Workspace storage cleanup cron run completed:",
      summary
    );
  } catch (err) {
    console.error(
      "Content Workspace storage cleanup cron run failed:",
      err
    );
  }

  return { statusCode: 200 };
});