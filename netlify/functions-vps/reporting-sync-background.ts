import type { BackgroundHandler } from "@netlify/functions";
import { syncCalendarSocialReporting } from "../../lib/reporting/sync";

export const handler: BackgroundHandler = async (event) => {
  if (!process.env.CRON_SECRET || event.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn("Rejected unauthorized calendar reporting sync job.");
    return;
  }

  let calendarId = "";
  try {
    const body = JSON.parse(event.body || "{}") as { calendarId?: unknown };
    calendarId = typeof body.calendarId === "string" ? body.calendarId : "";
  } catch {
    console.warn("Rejected invalid calendar reporting sync payload.");
    return;
  }
  if (!calendarId) return;

  try {
    const result = await syncCalendarSocialReporting(calendarId);
    console.info("Calendar reporting sync completed:", { calendarId, ...result });
  } catch (error) {
    console.error(`Calendar reporting sync failed for calendar ${calendarId}:`, error);
  }
};
