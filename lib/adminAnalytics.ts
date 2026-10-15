import { getLivePaymentsSql } from "@/lib/livePaymentRevenue";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

import { ADMIN_TOOLS, type AdminTool } from "./adminAnalyticsOptions";
export { ADMIN_TOOLS } from "./adminAnalyticsOptions";
export type AnalyticsParams = {
  tool?: string;
  range?: string;
  from?: string;
  to?: string;
};
const DAY = 86400000;
export function analyticsWindow(params: AnalyticsParams, now = new Date()) {
  const tool: AdminTool =
    params.tool &&
    Object.prototype.hasOwnProperty.call(ADMIN_TOOLS, params.tool)
      ? (params.tool as AdminTool)
      : "all";
  const range = ["7", "30", "90", "custom"].includes(params.range ?? "")
    ? params.range!
    : "30";
  const today = new Date(now.getTime() + 3600000).toISOString().slice(0, 10);
  const parse = (s?: string) =>
    s &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !isNaN(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s
      ? new Date(`${s}T00:00:00+01:00`)
      : null;
  let end = new Date(new Date(`${today}T00:00:00+01:00`).getTime() + DAY);
  let start = new Date(
    end.getTime() - Number(range === "custom" ? 30 : range) * DAY,
  );
  let error = "";
  if (range === "custom") {
    const from = parse(params.from),
      to = parse(params.to);
    if (
      from &&
      to &&
      from <= to &&
      to.getTime() - from.getTime() <= 365 * DAY &&
      to < end
    ) {
      start = from;
      end = new Date(to.getTime() + DAY);
    } else
      error =
        "Choose a valid date range of up to one year, ending today or earlier. Showing the last 30 days.";
  }
  return {
    tool,
    range,
    start,
    end,
    previous: new Date(start.getTime() - (end.getTime() - start.getTime())),
    error,
    from: new Date(start.getTime() + 3600000).toISOString().slice(0, 10),
    to: new Date(end.getTime() - DAY + 3600000).toISOString().slice(0, 10),
  };
}

// Aggregate in PostgreSQL: no unbounded event or customer payloads, one connection at a time.
const events = Prisma.sql`
 SELECT "creatorId", "createdAt" AS at, 'delivery' AS tool FROM "Project"
 UNION ALL SELECT "creatorId", "createdAt", 'projects' FROM "ManagedProject"
 UNION ALL SELECT "createdByCreatorId", "createdAt", 'projects' FROM "Task"
 UNION ALL SELECT "creatorId", "createdAt", 'portfolio' FROM "Portfolio"
 UNION ALL SELECT p."creatorId", m."createdAt", 'portfolio' FROM "PortfolioMedia" m JOIN "Portfolio" p ON p.id=m."portfolioId"
 UNION ALL SELECT "managerId", "createdAt", 'workspace' FROM "SocialCalendar"
 UNION ALL SELECT c."managerId", p."createdAt", 'workspace' FROM "CalendarPost" p JOIN "SocialCalendar" c ON c.id = p."calendarId" WHERE NOT p."isAiDraft"
 UNION ALL SELECT c."managerId", g."createdAt", 'ai' FROM "CalendarPostAiGeneration" g JOIN "CalendarPost" p ON p.id=g."postId" JOIN "SocialCalendar" c ON c.id=p."calendarId"
 UNION ALL SELECT p."creatorId", m."createdAt", 'delivery' FROM "Media" m JOIN "Project" p ON p.id=m."projectId"
 UNION ALL SELECT "creatorId", "submittedAt", 'community' FROM "SpotlightSubmission"
 UNION ALL SELECT NULL::text, "createdAt", 'community' FROM "WebinarRsvp"
`;
export async function getAdminAnalytics(params: AnalyticsParams) {
  const payments = await getLivePaymentsSql();
  const w = analyticsWindow(params);
  const filter = Prisma.sql`(${w.tool} = 'all' OR tool = ${w.tool})`;
  const daily = await db.$queryRaw<
    { day: string; signups: number; revenue: number; activity: number }[]
  >(Prisma.sql`
 WITH events AS (${events}), payments AS (${payments}), days AS (
 SELECT generate_series(${w.start}::timestamptz, ${w.end}::timestamptz - interval '1 day', interval '1 day') AS day),
 s AS (SELECT ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Lagos')::date AS day, count(*)::int AS n FROM "Creator" c WHERE "createdAt">=${w.start} AND "createdAt"<${w.end} AND (${w.tool}='all' OR EXISTS (SELECT 1 FROM events e WHERE e."creatorId"=c.id AND e.tool=${w.tool} AND e.at<${w.end})) GROUP BY 1),
 r AS (SELECT ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Lagos')::date AS day, sum("amountNgn")::float AS n FROM payments WHERE "createdAt">=${w.start} AND "createdAt"<${w.end} AND ${filter} GROUP BY 1),
 a AS (SELECT (at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Lagos')::date AS day, count(*)::int AS n FROM events WHERE at>=${w.start} AND at<${w.end} AND ${filter} GROUP BY 1)
 SELECT to_char(days.day AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD') AS day, coalesce(s.n,0)::int AS signups, coalesce(r.n,0)::float AS revenue, coalesce(a.n,0)::int AS activity FROM days LEFT JOIN s ON s.day=(days.day AT TIME ZONE 'Africa/Lagos')::date LEFT JOIN r ON r.day=(days.day AT TIME ZONE 'Africa/Lagos')::date LEFT JOIN a ON a.day=(days.day AT TIME ZONE 'Africa/Lagos')::date ORDER BY days.day`);
  const comparison = await db.$queryRaw<
    {
      revenue: number;
      signups: number;
      activity: number;
      active: number;
      payers: number;
      payments: number;
    }[]
  >(Prisma.sql`
 WITH events AS (${events}), payments AS (${payments})
 SELECT (SELECT coalesce(sum("amountNgn"),0)::float FROM payments WHERE "createdAt">=${w.previous} AND "createdAt"<${w.start} AND ${filter}) AS revenue,
 (SELECT count(*)::int FROM "Creator" c WHERE "createdAt">=${w.previous} AND "createdAt"<${w.start} AND (${w.tool}='all' OR EXISTS(SELECT 1 FROM events e WHERE e."creatorId"=c.id AND e.tool=${w.tool} AND e.at<${w.start}))) AS signups,
 (SELECT count(*)::int FROM events WHERE at>=${w.previous} AND at<${w.start} AND ${filter}) AS activity,
 (SELECT count(DISTINCT "creatorId")::int FROM events WHERE at>=${w.start} AND at<${w.end} AND ${filter}) AS active,
 (SELECT count(DISTINCT "creatorId")::int FROM payments WHERE "createdAt">=${w.start} AND "createdAt"<${w.end} AND ${filter}) AS payers,
 (SELECT count(*)::int FROM payments WHERE "createdAt">=${w.start} AND "createdAt"<${w.end} AND ${filter}) AS payments`);
  const breakdown = await db.$queryRaw<
    {
      tool: string;
      revenue: number;
      payments: number;
      users: number;
      activity: number;
    }[]
  >(Prisma.sql`
 WITH events AS (${events}), payments AS (${payments}), r AS (SELECT tool, sum("amountNgn")::float AS revenue,count(*)::int AS payments FROM payments WHERE "createdAt">=${w.start} AND "createdAt"<${w.end} AND ${filter} GROUP BY tool), a AS (SELECT tool,count(*)::int AS activity,count(DISTINCT "creatorId")::int AS users FROM events WHERE at>=${w.start} AND at<${w.end} AND ${filter} GROUP BY tool)
 SELECT coalesce(r.tool,a.tool) AS tool,coalesce(revenue,0)::float AS revenue,coalesce(payments,0)::int AS payments,coalesce(users,0)::int AS users,coalesce(activity,0)::int AS activity FROM r FULL JOIN a ON r.tool=a.tool ORDER BY revenue DESC,activity DESC`);
  const heatmap = await db.$queryRaw<
    { day: number; hour: number; count: number }[]
  >(
    Prisma.sql`WITH events AS (${events}) SELECT extract(isodow FROM at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Lagos')::int AS day,extract(hour FROM at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Lagos')::int AS hour,count(*)::int AS count FROM events WHERE at>=${w.start} AND at<${w.end} AND ${filter} GROUP BY 1,2`,
  );
  const signups = await db.$queryRaw<
    {
      id: string;
      name: string | null;
      email: string;
      accountType: string;
      createdAt: Date;
    }[]
  >(
    Prisma.sql`WITH events AS (${events}) SELECT id,name,email,"accountType","createdAt" FROM "Creator" c WHERE "createdAt">=${w.start} AND "createdAt"<${w.end} AND (${w.tool}='all' OR EXISTS(SELECT 1 FROM events e WHERE e."creatorId"=c.id AND e.tool=${w.tool} AND e.at<${w.end})) ORDER BY "createdAt" DESC LIMIT 8`,
  );
  return {
    window: w,
    daily,
    comparison: comparison[0],
    breakdown,
    heatmap,
    signups,
  };
}
export async function getAdminTotals() {
  const payments = await getLivePaymentsSql();
  return (
    await db.$queryRaw<
      {
        accounts: number;
        projects: number;
        managed: number;
        workspaces: number;
        portfolios: number;
        posts: number;
        media: number;
        tasks: number;
        revenue: number;
        paying: number;
      }[]
    >(Prisma.sql`WITH payments AS (${payments}) SELECT
 (SELECT count(*)::int FROM "Creator") AS accounts,
 (SELECT count(*)::int FROM "Project") AS projects,
 (SELECT count(*)::int FROM "ManagedProject") AS managed,
 (SELECT count(*)::int FROM "SocialCalendar") AS workspaces,
 (SELECT count(*)::int FROM "Portfolio") AS portfolios,
 (SELECT count(*)::int FROM "CalendarPost" WHERE NOT "isAiDraft") AS posts,
 (SELECT count(*)::int FROM "Media") AS media,
 (SELECT count(*)::int FROM "Task") AS tasks,
 (SELECT coalesce(sum("amountNgn"),0)::float FROM payments) AS revenue,
 (SELECT count(DISTINCT "creatorId")::int FROM payments) AS paying`)
  )[0];
}
