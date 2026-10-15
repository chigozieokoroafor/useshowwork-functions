import { schedule } from "@netlify/functions";
export const handler = schedule("* * * * *", async () => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl || !process.env.CRON_SECRET) throw new Error("Email scheduler configuration is missing");
  const response = await fetch(`${siteUrl}/api/cron/billing-benefit-emails`, {
    method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) throw new Error(`Benefit email processing failed (${response.status})`);
  return { statusCode: 200 };
});
