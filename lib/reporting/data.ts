import { canUseCalendarFeature } from "@/lib/calendarPermissions";
import type { SocialPlatform } from "@prisma/client";
import { db } from "@/lib/db";
import { publicUrlFor } from "@/lib/r2";
import { getSocialReportingAdapter } from "@/lib/reporting/adapters";
import { change, compareAccounts, applyLiveFacebookOverview } from "@/lib/reporting/comparison";
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
) {
  const advancedAccess = await canUseCalendarFeature(calendarId, "advancedAnalytics");
  const { start, end } = reportingPeriod(searchParams);
  const previousEnd = new Date(start.getTime() - 1);
  const previousStart = new Date(start.getTime() - (end.getTime() - start.getTime() + 1));
  const platformValue = searchParams.get("platform")?.toUpperCase();
  if (platformValue && !REPORTING_PLATFORMS.includes(platformValue as SocialPlatform)) {
    throw new Error("Choose a supported social platform.");
  }
  const platform = platformValue as SocialPlatform | null;

  const [connections, posts, insights, facebookConnection] = await Promise.all([
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
        connection: { select: { accountName: true, username: true } },
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
    !platform || platform === "FACEBOOK"
      ? db.socialConnection.findFirst({
          where: { calendarId, platform: "FACEBOOK", status: { in: ["CONNECTED", "NEEDS_REAUTH"] } },
          orderBy: { connectedAt: "desc" },
        })
      : Promise.resolve(null),
  ]);

  let facebookPageActivity: FacebookPageActivity | null = null;
  let facebookPageActivityError: string | null = null;
  if (facebookConnection) {
    // Internal fallback keeps the deliberately selected Page identity
    // visible even when Meta temporarily refuses the live reporting call.
    facebookPageActivity = {
      pageId: facebookConnection.platformAccountId,
      pageName: facebookConnection.accountName || "Facebook Page",
      followers: null,
      posts: [],
      notices: [],
    };
    const adapter = getSocialReportingAdapter("FACEBOOK");
    if (!facebookConnection.accessToken) {
      facebookPageActivityError = "Facebook Page connection needs renewal. Reconnect the selected Page to load Page activity.";
    } else if (!(facebookConnection.tokenScopes ?? "").split(/[\s,]+/).includes("pages_read_engagement")) {
      facebookPageActivityError = "Facebook reporting permission is missing. Reconnect this Page after granting pages_read_engagement.";
    } else if (!adapter?.fetchPageActivity) {
      facebookPageActivityError = "Facebook Page reporting is not available yet.";
    } else {
      try {
        facebookPageActivity = await adapter.fetchPageActivity(facebookConnection, { start, end });
      } catch (error) {
        facebookPageActivityError = error instanceof Error ? error.message : "Could not load Facebook Page activity.";
      }
    }
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
  if (facebookPageActivity) {
    for (const post of facebookPageActivity.posts) {
      if (!post.createdAt) continue;
      const existingIndex = accountPosts.findIndex((item) => item.platform === "FACEBOOK" && item.platformPostId === post.id);
      const enrichedPost = {
        id: existingIndex >= 0 ? accountPosts[existingIndex].id : `FACEBOOK:${post.id}`,
        connectionId: facebookConnection?.id ?? "",
        platform: "FACEBOOK" as const,
        platformPostId: post.id,
        caption: post.message,
        postType: "POST",
        publishedAt: post.createdAt ?? new Date().toISOString(),
        permalink: post.permalink,
        views: null,
        reach: post.reach,
        impressions: post.impressions,
        engagement: [post.likes, post.comments, post.shares].every((value) => value != null)
          ? (post.likes ?? 0) + (post.comments ?? 0) + (post.shares ?? 0)
          : null,
        likes: post.likes,
        comments: post.comments,
        shares: post.shares,
        saves: null,
        metricsUpdatedAt: null,
        accountName: facebookPageActivity.pageName,
        username: null,
        source: "PLATFORM" as const,
      };
      if (existingIndex >= 0) accountPosts[existingIndex] = { ...accountPosts[existingIndex], ...enrichedPost };
      else accountPosts.push(enrichedPost);
    }
  }
  accountPosts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const leadWhere = { calendarId, ...(platform ? { socialConversation: { platform } } : {}) };
  const [leadTotal, newLeads, previousLeads, hotCount, customers, hottest] = includeSyncErrors && includeLeads ? await Promise.all([
    db.calendarLead.count({ where: { ...leadWhere, createdAt: { lte: end } } }),
    db.calendarLead.count({ where: { ...leadWhere, createdAt: { gte: start, lte: end } } }),
    db.calendarLead.count({ where: { ...leadWhere, createdAt: { gte: previousStart, lte: previousEnd } } }),
    db.calendarLead.count({ where: { ...leadWhere, createdAt: { gte: start, lte: end }, temperature: "HOT", status: { notIn: ["CUSTOMER", "LOST"] } } }),
    db.calendarLead.count({ where: { ...leadWhere, createdAt: { gte: start, lte: end }, status: "CUSTOMER" } }),
    db.calendarLead.findMany({
      where: { ...leadWhere, createdAt: { gte: start, lte: end }, temperature: "HOT", status: { notIn: ["CUSTOMER", "LOST"] } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 5,
      select: { id: true, name: true, company: true, username: true, status: true, source: true, updatedAt: true,
        socialConversation: { select: { platform: true, participantName: true, participantUsername: true } } },
    }),
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
  let compared = compareAccounts(comparisonAccounts, start, end, previousStart);
  const activeAccounts = connections.filter(connection => connection.status === "CONNECTED");
  if (!facebookPageActivityError && facebookPageActivity && activeAccounts.length === 1 && activeAccounts[0].id === facebookConnection?.id) {
    compared = applyLiveFacebookOverview(compared, facebookPageActivity, start, end);
  }
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
    leads: includeSyncErrors && includeLeads && advancedAccess ? { total: leadTotal, acquired: change(newLeads, previousLeads, "vs previous period"), hotCount, customers, hottest } : null,
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
    posts: posts.map((post) => ({
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
    insights: insights.map((insight) => includeSyncErrors
      ? insight
      : {
          id: insight.id,
          platform: insight.platform,
          periodStart: insight.periodStart,
          periodEnd: insight.periodEnd,
          type: insight.type,
          title: insight.title,
          description: insight.description,
          recommendation: insight.recommendation,
          generatedAt: insight.generatedAt,
        }),
    facebookPageActivity,
    facebookPageActivityError,
  };
}
