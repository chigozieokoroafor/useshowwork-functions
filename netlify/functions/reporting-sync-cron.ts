import { schedule } from "@netlify/functions";

// Save a daily historical metric snapshot while staying within provider rate limits.
export const handler = schedule("17 2 * * *", async () => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl || !process.env.CRON_SECRET) {
    console.error("Reporting sync cron is missing its site URL or CRON_SECRET.");
    return { statusCode: 500 };
  }

  try {
    const response = await fetch(`${siteUrl}/api/cron/reporting-sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    if (!response.ok) throw new Error(`Reporting sync returned ${response.status}.`);
    console.log("Social reporting sync completed:", await response.json());
  } catch (error) {
    console.error("Social reporting cron failed:", error);
  }
  return { statusCode: 200 };
});
