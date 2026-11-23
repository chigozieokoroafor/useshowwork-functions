import { recordWorkspaceNotice } from "./workspaceNotifications";
import type { NativeApplicationContext } from "@/lib/publishing/nativeApplicationContext";

export type WorkflowEmailEvent =
  | { kind: "generated" | "imported"; calendarId: string; key: string; postIds: string[]; actorId?: string; range?: [string, string]; timeZone?: string }
  | { kind: "uploaded"; calendarId: string; key: string; postId?: string; uploadPostIds?: string[]; actorId: string; timeZone?: unknown }
  | { kind: "client-approved" | "client-feedback"; calendarId: string; key: string; postId?: string; note?: string | null; actor?: string; batchId?: string };

type Query = (sql: string, args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const platforms: Record<string, string> = { FACEBOOK: "Facebook", INSTAGRAM: "Instagram", TIKTOK: "TikTok", LINKEDIN: "LinkedIn", X: "X", YOUTUBE: "YouTube", WHATSAPP: "WhatsApp" };
const postDateOptions = { weekday: "long", month: "long", day: "numeric", year: "numeric" } as const;

function uploadDateFormat(timeZone: unknown) {
  try {
    return new Intl.DateTimeFormat("en-US", { ...postDateOptions, timeZone: typeof timeZone === "string" ? timeZone : "UTC" });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...postDateOptions, timeZone: "UTC" });
  }
}

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function calendarDateRange(start: string, end: string) {
  const first = new Date(start);
  const last = new Date(end);
  if (first.getTime() === last.getTime()) return dateFormat.format(first);
  return dateFormat.formatRange(first, last);
}

export async function notifyCalendarWorkflow(
  event: WorkflowEmailEvent,
  query?: Query,
  transport?: NativeApplicationContext["notify"],
  sendEmail = true,
) {
  try {
    if ("postIds" in event && !event.postIds.length) return;
    const read = query ?? (async (sql, args) => {
      const { db } = await import("@/lib/db");
      return { rows: await db.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...args) };
    });
    const { rows } = await read(`
      SELECT w."clientName", c.email
      FROM "SocialCalendar" w JOIN "Creator" c ON (
        c.id = w."managerId" OR EXISTS (
          SELECT 1 FROM "CalendarCollaborator" m WHERE m."calendarId" = w.id AND m."creatorId" = c.id
        )
      )
      WHERE w.id = $1 AND NOT c."isDeactivated"
    `, [event.calendarId]);
    if (!rows.length) return;
    const recipients = [...new Set(rows.map(row => String(row.email).trim().toLowerCase()).filter(Boolean))];
    const details: Array<[string, string]> = [["Workspace", String(rows[0].clientName)]];
    let linkedPostId = "postId" in event ? event.postId : undefined;
    let focusDate: string | undefined;
    let title: string;
    let message: string;
    if ("postIds" in event) {
      const { rows: dates } = await read(`
        SELECT to_char(min("postDate" AT TIME ZONE 'UTC' AT TIME ZONE $3), 'YYYY-MM-DD') AS start,
               to_char(max("postDate" AT TIME ZONE 'UTC' AT TIME ZONE $3), 'YYYY-MM-DD') AS "end",
               count(*) FILTER (WHERE "creativeBrief" IS NOT NULL OR "creativeDevelopment" IS NOT NULL OR
                 nullif(trim("contentIdea"), '') IS NOT NULL OR nullif(trim(script), '') IS NOT NULL OR EXISTS (
                   SELECT 1 FROM "CalendarPostCustomField" f WHERE f."postId" = "CalendarPost".id
                     AND lower(trim(f.label)) IN ('creative direction', 'creative brief', 'visual direction', 'designer brief')
                     AND nullif(trim(f.value), '') IS NOT NULL
                 ))::int AS briefed
        FROM "CalendarPost" WHERE "calendarId" = $1 AND id = ANY($2::text[])
      `, [event.calendarId, event.postIds, event.timeZone ?? "UTC"]);
      const date = dates[0];
      const range = event.range ?? (date?.start && date.end ? [String(date.start), String(date.end)] : undefined);
      if (range) {
        focusDate = range[0].slice(0, 10);
        details.push(["Calendar timeline", calendarDateRange(range[0], range[1])]);
      }
      details.push(["Content planned", `${event.postIds.length} ${event.postIds.length === 1 ? "post" : "posts"}`]);
      title = event.kind === "generated" ? "A content calendar was generated" : "A content calendar was imported";
      const briefed = Number(date?.briefed ?? 0);
      message = briefed === event.postIds.length
        ? "The creative direction is ready in the calendar. Creatives and content creators can open the briefs and begin work."
        : briefed
          ? `${briefed} posts have creative direction ready to use. Open the calendar to start on those posts and add direction where it’s missing.`
          : "The schedule is ready. Open the calendar to add creative direction before production begins.";
    } else if (event.kind === "uploaded") {
      const { rows: posts } = await read(`
        SELECT id, platform, "postDate" FROM "CalendarPost"
        WHERE "calendarId" = $1 AND "deletedAt" IS NULL AND id = ANY($2::text[])
        ORDER BY "postDate", platform, id
      `, [event.calendarId, event.uploadPostIds ?? (event.postId ? [event.postId] : [])]);
      if (!posts.length) return;
      const firstDate = new Date(String(posts[0].postDate));
      if (Number.isFinite(firstDate.getTime())) focusDate = firstDate.toISOString().slice(0, 10);
      linkedPostId = posts.length === 1 ? String(posts[0].id) : undefined;
      const scheduled = uploadDateFormat(event.timeZone);
      for (const post of posts) {
        const date = post.postDate instanceof Date ? post.postDate : new Date(String(post.postDate));
        const platform = String(post.platform);
        details.push([platforms[platform] ?? platform, scheduled.format(date)]);
      }
      const { rows: actors } = await read('SELECT name, email FROM "Creator" WHERE id = $1', [event.actorId]);
      const actor = actors[0];
      if (actor) details.push(["Uploaded by", actor.name ? `${actor.name} (${actor.email})` : String(actor.email)]);
      title = posts.length === 1 ? "New post upload ready for internal review" : "New uploads ready for internal review";
      message = posts.length === 1
        ? "New creative was uploaded for the scheduled post below. Open the post to review it, leave feedback or approve it for client review."
        : "New creative was uploaded for the scheduled posts below. Open the calendar to review the posts, leave feedback or approve them for client review.";
    } else {
      title = event.kind === "client-approved" ? "Client approval received" : "Client changes requested";
      message = event.kind === "client-approved"
        ? `The client has approved this ${event.postId ? "post" : "content plan"}.`
        : "The client has requested changes. Open the workspace to review their feedback and prepare the next revision.";
      if (event.note) details.push(["Client feedback", event.note]);
    }

    await recordWorkspaceNotice({
      calendarId: event.calendarId, key: event.key, kind: event.kind,
      actorId: "actorId" in event ? event.actorId : undefined,
      actor: "actor" in event ? event.actor : undefined,
      batchId: "batchId" in event ? event.batchId : undefined,
      postId: linkedPostId, title, focusDate,
      description: ["uploaded", "imported", "generated"].includes(event.kind)
        ? details.slice(1).filter(([label]) => label !== "Uploaded by").map(([label, value]) => `${label} · ${value}`).join(" • ")
        : undefined,
    }, read);

    if (!sendEmail) return;
    const { sendWorkspaceWorkflowEmail } = await import("@/lib/resend");
    const results = await Promise.allSettled(recipients.map(async to => {
      for (let attempt = 0; ; attempt++) {
        try {
          await sendWorkspaceWorkflowEmail({
            to, calendarId: event.calendarId, postId: linkedPostId,
            eventKey: `${event.kind}-${event.key}`, title, message, details,
          }, transport);
          return;
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    }));
    const failed = results.filter(result => result.status === "rejected").length;
    if (failed) console.warn("[Calendar workflow email] Delivery incomplete", { kind: event.kind, failed });
  } catch (error) {
    console.warn("[Calendar workflow email] Notification unavailable", { kind: event.kind, error: error instanceof Error ? error.name : "UnknownError" });
  }
}
