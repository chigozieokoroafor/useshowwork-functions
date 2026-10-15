import type { BackgroundHandler } from "@netlify/functions";
import { processSocialInboxAutoReply } from "../../lib/socialMessaging/autoReply";

export const handler: BackgroundHandler = async (event) => {
  if (!process.env.CRON_SECRET || event.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn("Rejected unauthorized social inbox auto-reply job.");
    return;
  }

  let messageId = "";
  try {
    const body = JSON.parse(event.body || "{}") as { messageId?: unknown };
    messageId = typeof body.messageId === "string" ? body.messageId : "";
  } catch {
    console.warn("Rejected invalid social inbox auto-reply job payload.");
    return;
  }
  if (!messageId) return;

  try {
    const result = await processSocialInboxAutoReply(messageId);
    console.info("Immediate social inbox auto-reply completed:", result);
  } catch (error) {
    console.error("Immediate social inbox auto-reply worker failed:", error);
  }
};
