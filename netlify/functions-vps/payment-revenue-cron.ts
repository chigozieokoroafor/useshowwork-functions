import { schedule } from "@netlify/functions";
export const handler = schedule("*/15 * * * *", async () => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl || !process.env.CRON_SECRET)
    throw new Error("Revenue scheduler configuration is missing");
  const response = await fetch(`${siteUrl}/api/cron/payment-revenue`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok)
    throw new Error(`Revenue sync requires retry (${response.status})`);
  console.log("Payment revenue sync", await response.json());
  return { statusCode: 200 };
});
