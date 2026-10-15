import type { Handler } from "@netlify/functions";
import { syncSocialInboxes } from "../../lib/socialMessaging/x";
export const handler: Handler = async event => {
  if (!process.env.CRON_SECRET || event.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return { statusCode: 401, body: "Unauthorized" };
  return { statusCode: 200, body: JSON.stringify(await syncSocialInboxes()) };
};
