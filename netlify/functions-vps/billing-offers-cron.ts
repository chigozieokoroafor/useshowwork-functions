import { schedule } from "@netlify/functions";
export const handler = schedule("*/15 * * * *", async () => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl || !process.env.CRON_SECRET) throw new Error("Billing scheduler configuration is missing");
  const response = await fetch(`${siteUrl}/api/cron/billing-offers`, {
    method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) throw new Error(`Billing reconciliation failed (${response.status})`);
  console.log("Billing offer reconciliation", await response.json());
  return { statusCode: 200 };
});
