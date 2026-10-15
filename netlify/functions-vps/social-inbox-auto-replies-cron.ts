import { schedule } from "@netlify/functions";

export const handler = schedule("* * * * *", async () => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl || !process.env.CRON_SECRET) {
    console.error("Social inbox auto-reply job is missing its site URL or CRON_SECRET.");
    return { statusCode: 500 };
  }
  try {
    const response = await fetch(`${siteUrl}/api/cron/social-inbox-auto-replies`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    if (!response.ok) throw new Error(`Social inbox auto-replies returned ${response.status}.`);
    console.log("Social inbox auto-replies completed:", await response.json());
  } catch (error) {
    console.error("Social inbox auto-reply cron failed:", error);
    return { statusCode: 500 };
  }
  return { statusCode: 200 };
});
