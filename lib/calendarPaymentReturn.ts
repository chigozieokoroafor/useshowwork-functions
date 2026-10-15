import { db } from "@/lib/db";
import { appUrl } from "@/lib/url";

/** Return payments to an owned workspace when initiated there. */
export async function calendarPaymentReturn(req: Request, creatorId: string) {
  const fallback = `${appUrl()}/dashboard/calendars?subscriptionPayment=callback`;
  try {
    const source = new URL(req.headers.get("referer") || "");
    if (source.origin !== new URL(appUrl()).origin) return fallback;
    const match = source.pathname.match(/^\/dashboard\/calendars\/([^/]+)$/);
    if (!match) return fallback;
    const calendar = await db.socialCalendar.findUnique({ where: { id: match[1] }, select: { managerId: true } });
    if (calendar?.managerId !== creatorId) return fallback;
    const result = new URL(source.pathname, appUrl());
    result.searchParams.set("view", source.searchParams.get("view") || "team");
    result.searchParams.set("subscriptionPayment", "callback");
    return result.toString();
  } catch { return fallback; }
}
