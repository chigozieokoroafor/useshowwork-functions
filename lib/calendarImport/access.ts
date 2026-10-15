import { getCurrentCreator } from "@/lib/auth";
import {
  hasCalendarPermission,
  canAccessCalendarById,
} from "@/lib/calendarPermissions";
import { isAdminEmail } from "@/lib/admin";
import { NextResponse } from "next/server";

export async function importAccess(calendarId: string) {
  const creator = await getCurrentCreator();
  if (!creator)
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  if (!(await hasCalendarPermission(creator.id, calendarId, "EDIT_CALENDAR")))
    return {
      error: NextResponse.json(
        { error: "You don't have permission to import into this calendar." },
        { status: 403 },
      ),
    };
  if (
    !isAdminEmail(creator.email) &&
    !(await canAccessCalendarById(calendarId))
  )
    return {
      error: NextResponse.json(
        { error: "This calendar isn't active." },
        { status: 403 },
      ),
    };
  return { creator };
}
