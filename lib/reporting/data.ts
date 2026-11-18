import { strategyScope } from "@/lib/reporting/monthlyStrategy";
import { canUseCalendarFeature } from "@/lib/calendarPermissions";
import type { SocialPlatform } from "@prisma/client";
import { db } from "@/lib/db";
import { publicUrlFor } from "@/lib/r2";
import { change, compareAccounts } from "@/lib/reporting/comparison";
import type { FacebookPageActivity } from "@/lib/reporting/types";

export const REPORTING_PLATFORMS: SocialPlatform[] = ["INSTAGRAM", "TIKTOK", "FACEBOOK", "LINKEDIN", "X", "YOUTUBE"];

export function reportingPeriod(searchParams: URLSearchParams) {
  const endValue = searchParams.get("to");
  const startValue = searchParams.get("from");
  for (const value of [startValue, endValue]) {
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(new Date(`${value}T00:00:00.000Z`).getTime()) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value)) {
      throw new Error("Choose a valid reporting date range.");
    }
  }
  const end = new Date(`${endValue || new Date().toISOString().slice(0, 10)}T23:59:59.999Z`);
  const start = startValue
    ? new Date(`${startValue}T00:00:00.000Z`)
    : new Date(new Date(end.toISOString().slice(0, 10)).getTime() - 29 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new Error("Choose a valid reporting date range.");
  }
  if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new Error("Reporting date ranges can’t exceed 366 days.");
  }
  return { start, end };
}

export async function getCalendarReportingData(
  calendarId: string,
  searchParams: URLSearchParams,
  includeSyncErrors: boolean,
  includeLeads = includeSyncErrors,
  includeLeadSummary = false,
) {
  const advancedAccess = await canUseCalendarFeature(calendarId, "advancedAnalytics");
  const { start, end } = reportingPeriod(searchParams);
  const previousEnd = new Date(start.getTime() - 1);
  const previousStart = new Date(start.getTime() - (end.getTime() - start.getTime() + 1));
  const platforms = [...new Set(searchParams.getAll("platform").flatMap(value => value.split(",")).filter(Boolean).map(value => value.toUpperCase()))] as SocialPlatform[];
  if (platforms.some(value => !REPORTING_PLATFORMS.includes(value))) {
    throw new Error("Choose a supported social platform.");
  }
  const platform = platforms.length ? { in: platforms } : null;

  const [storedConnections, posts, insights, facebookConnection, latestDisconnection] = await Promise.all([
    db.socialConnection.findMany({
      where: { calendarId, platform: platform || { in: REPORTING_PLATFORMS } },
      select: {
        id: true,
        platform: true,
        platformAccountId: true,
        accountName: true,
        username: true,
        status: true,
        connectedAt: true,
        disconnectedAt: true,
        lastSyncAttemptAt: true,
        lastSyncAt: true,
        ...(includeSyncErrors ? { lastSyncError: true } : {}),
        accountMetricSnapshots: {
          where: { snapshotDate: { gte: previousStart, lte: end } },
          orderBy: { snapshotDate: "desc" },
          take: 734,
        },
        accountPosts: {
          where: { publishedAt: { gte: previousStart, lte: end } },
          orderBy: { publishedAt: "desc" },
          take: 500,
          select: {
            id: true,
            platformPostId: true,
            caption: true,
            postType: true,
            publishedAt: true,
            permalink: true,
            views: true,
            reach: true,
            impressions: true,
            engagement: true,
            likes: true,
            comments: true,
            shares: true,
            saves: true,
            metricsUpdatedAt: true,
          },
        },
      },
      orderBy: { platform: "asc" },
    }),
    db.publishedSocialPost.findMany({
      where: {
        calendarId,
        connection: { status: { in: ["CONNECTED", "NEEDS_REAUTH"] } },
        ...(!includeSyncErrors ? { calendarPost: { internalReviewStatus: "APPROVED" as const, isAiDraft: false } } : {}),
        ...(platform ? { platform } : {}),
        publishedAt: { gte: start, lte: end },
      },
      select: {
        id: true,
        platform: true,
        platformPostId: true,
        permalink: true,
        status: true,
        publishedAt: true,
        platformPostType: true,
        metricSnapshots: {
          where: { snapshotDate: { gte: start, lte: end } },
          orderBy: { snapshotDate: "desc" },
          take: 90,
        },
        calendarPost: {
          select: {
            id: true,
            caption: true,
            postType: true,
            category: true,
            assets: { select: { fileKey: true, mediaType: true, displayOrder: true }, orderBy: { displayOrder: "asc" } },
          },
        },
        connection: { select: { id: true, status: true, accountName: true, username: true } },
      },
      orderBy: { publishedAt: "desc" },
    }),
    db.reportingInsight.findMany({
      where: {
        calendarId,
        periodStart: start,
        periodEnd: end,
        ...(platform ? { OR: [{ platform }, { platform: null }] } : {}),
      },
      orderBy: { generatedAt: "desc" },
    }),
    !platform || platforms.includes("FACEBOOK")
      ? db.socialConnection.findFirst({
          where: { calendarId, platform: "FACEBOOK", status: { in: ["CONNECTED", "NEEDS_REAUTH"] } },
          orderBy: { connectedAt: "desc" },
          select: { id: true, platformAccountId: true, accountName: true, lastSyncError: true },
        })
      : Promise.resolve(null),
    db.socialConnection.findFirst({
      where: { calendarId, disconnectedAt: { not: null } },
      orderBy: { disconnectedAt: "desc" }, select: { disconnectedAt: true },
    }),
  ]);

  // Retain stored history for account recovery, but never include an explicitly
  // disconnected account in live reporting (posts, charts or recommendations).
  const connections = storedConnections.filter(connection => connection.status !== "DISCONNECTED");
  const currentIds = new Set(connections.map(connection => connection.id));
  const currentPlatforms = new Set(connections.map(connection => connection.platform));
  const latestDisconnect = Math.max(latestDisconnection?.disconnectedAt?.getTime() ?? 0, ...storedConnections.map(connection => connection.disconnectedAt?.getTime() ?? 0));
  const visibleInsights = insights.filter(insight => {
    if (!connections.length || (insight.platform && !currentPlatforms.has(insight.platform))) return false;
    // Legacy cross-channel analysis has no account provenance: invalidate it
    // when a source is disconnected rather than showing an outdated mix.
    if (insight.generatedAt.getTime() <= latestDisconnect) return false;
    const provenance = insight.supportingData as { connectionIds?: unknown; scope?: string } | null;
    if (provenance?.scope !== undefined && provenance.scope !== strategyScope(platforms)) return false;
    return !Array.isArray(provenance?.connectionIds) || provenance.connectionIds.every(id => typeof id === "string" && currentIds.has(id));
  });

  const latestStrategy = visibleInsights.find(insight => (insight.supportingData as { version?: number } | null)?.version === 1 || (insight.supportingData as { version?: number } | null)?.version === 2);
  const selectedInsights = latestStrategy ? [latestStrategy] : visibleInsights;

  let facebookPageActivity: FacebookPageActivity | null = null;
  let facebookPageActivityError: string | null = null;
  if (facebookConnection && currentIds.has(facebookConnection.id)) {
    // Keep the selected Page identity alongside its saved observations.
    facebookPageActivity = {
      pageId: facebookConnection.platformAccountId,
      pageName: facebookConnection.accountName || "Facebook Page",
      followers: null,
      posts: [],
      notices: [],
    };
    // Report reads use persisted observations only. Provider IO belongs to sync jobs.
    const saved = connections.find(connection => connection.id === facebookConnection.id);
    const latest = saved?.accountMetricSnapshots[0];
    facebookPageActivity.followers = latest?.followers ?? null;
    facebookPageActivity.posts = (saved?.accountPosts ?? []).filter(post => post.publishedAt >= start).map(post => ({
      id: post.platformPostId, message: post.caption, createdAt: post.publishedAt.toISOString(), permalink: post.permalink,
      imageUrl: null, likes: post.likes, comments: post.comments, shares: post.shares, reach: post.reach, impressions: post.impressions,
    }));
    facebookPageActivityError = includeSyncErrors ? facebookConnection.lastSyncError : null;
  }

  const accountPosts = connections.flatMap((connection) => connection.accountPosts.filter(post => post.publishedAt >= start).map((post) => ({
    id: `${connection.id}:${post.platformPostId}`,
    connectionId: connection.id,
    platform: connection.platform,
    platformPostId: post.platformPostId,
    caption: post.caption,
    postType: post.postType,
    publishedAt: post.publishedAt.toISOString(),
    permalink: post.permalink,
    views: post.views,
    reach: post.reach,
    impressions: post.impressions,
    engagement: post.engagement,
    likes: post.likes,
    comments: post.comments,
    shares: post.shares,
    saves: post.saves,
    metricsUpdatedAt: post.metricsUpdatedAt?.toISOString() ?? null,
    accountName: connection.accountName,
    username: connection.username,
    source: "PLATFORM" as const,
  })));
  accountPosts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const leadWhere = { calendarId, ...(platform ? { socialConversation: { platform } } : {}),
    AND: [{ OR: [{ socialConversation: null }, { socialConversation: { connection: { status: { in: ["CONNECTED", "NEEDS_REAUTH"] as Array<"CONNECTED" | "NEEDS_REAUTH"> } } } }] }],
  };
  const includeLeadCounts = (includeSyncErrors && includeLeads) || includeLeadSummary;
  let leadHistoryStartedAt: Date | null = null;
  if (includeLeadCounts && db.leadAnalyticsTracking) {
    try { leadHistoryStartedAt = (await db.leadAnalyticsTracking.findUnique({where:{id:"lead-milestones-v1"}}))?.startedAt ?? null; }
    catch (error) {
      // Keep existing analytics readable while this additive migration rolls out.
      if (!error || typeof error !== "object" || !("code" in error) || !["P2021","P2022"].includes(String(error.code))) throw error;
    }
  }
  const milestoneBasis = !leadHistoryStartedAt ? "current" as const
    : end < leadHistoryStartedAt ? "unavailable" as const
    : start < leadHistoryStartedAt ? "tracked-period" as const : "period" as const;
  const milestoneCountsAvailable = milestoneBasis === "period" || milestoneBasis === "tracked-period";
  const milestoneCountsComplete = milestoneBasis === "period";
  const milestoneInPeriod = (kind: "HOT" | "CUSTOMER") => ({milestones:{some:{kind,occurredAt:{gte:start,lte:end}}}});
  const [leadTotal, newLeads, previousLeads, hotCount, customers, hottest] = includeLeadCounts ? await Promise.all([
    db.calendarLead.count({ where: { ...leadWhere, createdAt: { lte: end } } }),
    db.calendarLead.count({ where: { ...leadWhere, createdAt: { gte: start, lte: end } } }),
    db.calendarLead.count({ where: { ...leadWhere, createdAt: { gte: previousStart, lte: previousEnd } } }),
    milestoneCountsAvailable ? db.calendarLead.count({ where: { ...leadWhere, ...milestoneInPeriod("HOT") } })
      : milestoneBasis === "current" ? db.calendarLead.count({where:{...leadWhere,temperature:"HOT",status:{notIn:["CUSTOMER","LOST"]}}}) : Promise.resolve(null),
    milestoneCountsAvailable ? db.calendarLead.count({ where: { ...leadWhere, ...milestoneInPeriod("CUSTOMER") } })
      : milestoneBasis === "current" ? db.calendarLead.count({where:{...leadWhere,status:"CUSTOMER"}}) : Promise.resolve(null),
    includeSyncErrors && includeLeads && advancedAccess && milestoneCountsAvailable ? db.calendarLead.findMany({
      where: { ...leadWhere, ...milestoneInPeriod("HOT"), temperature: "HOT", status: { notIn: ["CUSTOMER", "LOST"] } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 5,
      select: { id: true, name: true, company: true, username: true, status: true, source: true, updatedAt: true,
        socialConversation: { select: { platform: true, participantName: true, participantUsername: true } } },
    }) : Promise.resolve([]),
  ]) : [0, 0, 0, 0, 0, []] as const;
  // The lower panel and overview must compare the same enriched post data.
  // Keep earlier saved posts for comparisons; replace current records by ID.
  const comparisonAccounts = connections.map(connection => {
    const merged = new Map(connection.accountPosts.map(post => [post.platformPostId, post]));
    for (const post of accountPosts.filter(post => post.connectionId === connection.id)) {
      merged.set(post.platformPostId, { ...merged.get(post.platformPostId), ...post, publishedAt: new Date(post.publishedAt), metricsUpdatedAt: post.metricsUpdatedAt ? new Date(post.metricsUpdatedAt) : null });
    }
    return { ...connection, accountPosts: [...merged.values()] };
  });
  const compared = compareAccounts(comparisonAccounts, start, end, previousStart);
  const activeAccounts = connections.filter(connection => connection.status === "CONNECTED");
  // Post media views are distinct from video views and unique Page reach.
  const activeIds = new Set(activeAccounts.map(connection => connection.id));
  const facebookPosts = accountPosts.filter(post => post.platform === "FACEBOOK" && activeIds.has(post.connectionId));
  const mediaCounts = facebookPosts.filter(post => post.impressions !== null);
  if (mediaCounts.length) compared.postMediaViews = {
    value: mediaCounts.reduce((total, post) => total + post.impressions!, 0), delta: null, percent: null,
    basis: `Lifetime media views of ${mediaCounts.length} available Facebook posts`,
    note: "Available post counters; not a complete historical Page total or video-only views.",
  };
  // Creator retains current totals; comparisons and historical detail require Studio.
  const performance = advancedAccess ? compared : Object.fromEntries(Object.entries(compared).map(([key, metric]) => [key, {
    ...metric, delta: null, percent: null, note: "Upgrade to Studio for period comparisons.",
  }]));

  return {
    advancedAccess,
    period: { start: start.toISOString(), end: end.toISOString() },
    comparisonPeriod: { start: previousStart.toISOString(), end: previousEnd.toISOString() },
    performance,
    leads: includeLeadCounts ? { total: leadTotal, acquired: change(newLeads, previousLeads, "vs previous period"), hotCount, customers, hottest, historyStartedAt:leadHistoryStartedAt?.toISOString() ?? null, milestoneCountsAvailable, milestoneCountsComplete, milestoneBasis } : null,
    clientSharing: { enabled: true },
    connections: connections.map((connection) => ({
      id: connection.id,
      platform: connection.platform,
      platformAccountId: connection.platformAccountId,
      accountName: connection.accountName,
      username: connection.username,
      status: connection.status,
      connectedAt: connection.connectedAt,
      disconnectedAt: connection.disconnectedAt,
      lastSyncAttemptAt: connection.lastSyncAttemptAt,
      lastSyncAt: connection.lastSyncAt,
      ...(includeSyncErrors ? { lastSyncError: "lastSyncError" in connection ? connection.lastSyncError : null } : {}),
      accountMetricSnapshots: connection.accountMetricSnapshots.filter(snapshot => snapshot.snapshotDate >= start).slice(0, advancedAccess ? undefined : 1),
    })),
    posts: posts.filter(post => post.connection && currentIds.has(post.connection.id)).map((post) => ({
      id: post.id,
      platform: post.platform,
      platformPostId: post.platformPostId,
      permalink: post.permalink,
      status: post.status,
      publishedAt: post.publishedAt,
      platformPostType: post.platformPostType,
      metricSnapshots: post.metricSnapshots.slice(0, advancedAccess ? undefined : 1),
      connection: post.connection,
      calendarPost: {
        id: post.calendarPost.id,
        caption: post.calendarPost.caption,
        postType: post.calendarPost.postType,
        ...(includeSyncErrors ? { category: post.calendarPost.category } : {}),
        assets: post.calendarPost.assets.map((asset) => ({
          mediaType: asset.mediaType,
          displayOrder: asset.displayOrder,
          previewUrl: publicUrlFor(asset.fileKey),
        })),
      },
    })),
    accountPosts,
    insights: selectedInsights.map((insight) => {
      const saved = insight.supportingData as { strategy?: unknown; evidence?: string; researchSources?: unknown; targetMonth?: unknown } | null;
      const detail = { strategy: saved?.strategy ?? null, evidence: saved?.evidence ?? null, researchSources: saved?.researchSources ?? [], targetMonth: saved?.targetMonth ?? null };
      return includeSyncErrors ? { ...insight, ...detail } : {
          id: insight.id,
          platform: insight.platform,
          periodStart: insight.periodStart,
          periodEnd: insight.periodEnd,
          type: insight.type,
          title: insight.title,
          description: insight.description,
          recommendation: insight.recommendation,
          generatedAt: insight.generatedAt,
          ...detail,
        };
    }),
    facebookPageActivity,
    facebookPageActivityError,
  };
}
