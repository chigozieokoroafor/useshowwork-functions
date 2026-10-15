import { schedule } from "@netlify/functions";
export const handler = schedule("*/5 * * * *", async () => {
  const site = process.env.URL || process.env.DEPLOY_URL;
  if (!site || !process.env.CRON_SECRET) return { statusCode: 503 };
  const response = await fetch(`${site}/api/cron/social-inbox-sync`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(15_000) });
  return { statusCode: response.status };
});
