import type { SocialConnection } from "@prisma/client";
import type { NormalizedSocialMetrics, PublishedPostRef, SocialAccountPostRecord, SocialReportingAdapter } from "@/lib/reporting/types";

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number } };

type InstagramGraphRequestError = Error & {
  metaCode?: number;
  metaSubcode?: number;
};

async function graphGet<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.search = new URLSearchParams({ ...params, access_token: token }).toString();
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json().catch(() => ({})) as T & GraphError;
  if (!response.ok || data.error) {
    const detail = data.error?.message || `Instagram reporting request failed (${response.status}).`;
    const code = typeof data.error?.code === "number" ? ` (Meta code ${data.error.code})` : "";
    const request = path.replace(/^\/+/, "");
    const error = new Error(data.error?.code === 190
      ? `Instagram connection needs renewal: ${detail}${code}`
      : `Instagram reporting request for ${request} failed${code}: ${detail}`) as InstagramGraphRequestError;
    error.metaCode = data.error?.code;
    error.metaSubcode = data.error?.error_subcode;
    throw error;
  }
  return data;
}

function valueFromInsights(data: UserInsight[], name: string) {
  const insight = data.find((entry) => entry.name === name);
  const value = insight?.total_value?.value ?? insight?.values?.[0]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type UserInsight = {
  name: string;
  values?: { value?: number; end_time?: string }[];
  total_value?: { value?: number };
};

async function readAccountPosts(accountId: string, token: string): Promise<SocialAccountPostRecord[]> {
  const until = new Date();
  const since = new Date(until.getTime() - 366 * 24 * 60 * 60 * 1000);
  const posts: SocialAccountPostRecord[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await graphGet<{
      data?: Array<{
        id: string; caption?: string; media_type?: string; timestamp?: string;
        permalink?: string; like_count?: number; comments_count?: number;
      }>;
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`/${accountId}/media`, token, {
      fields: "id,caption,media_type,timestamp,permalink,like_count,comments_count",
      limit: "100",
      since: String(Math.floor(since.getTime() / 1000)),
      until: String(Math.floor(until.getTime() / 1000)),
      ...(after ? { after } : {}),
    });
    for (const media of result.data ?? []) {
      const publishedAt = media.timestamp ? new Date(media.timestamp) : null;
      if (!publishedAt || !Number.isFinite(publishedAt.getTime())) continue;
      const likes = typeof media.like_count === "number" ? media.like_count : null;
      const comments = typeof media.comments_count === "number" ? media.comments_count : null;
      posts.push({
        platformPostId: media.id,
        caption: media.caption ?? null,
        postType: media.media_type ?? null,
        publishedAt,
        permalink: media.permalink ?? null,
        likes,
        comments,
        engagement: likes !== null && comments !== null ? likes + comments : null,
      });
    }
    after = result.paging?.cursors?.after;
    if (!result.paging?.next || !after) break;
  }
  return posts;
}

async function readAccountInsights(accountId: string, token: string) {
  const until = new Date();
  const since = new Date(until.getTime() - 29 * 24 * 60 * 60 * 1000);
  const range = {
    period: "day",
    since: Math.floor(since.getTime() / 1000).toString(),
    until: Math.floor(until.getTime() / 1000).toString(),
  };
  const data: UserInsight[] = [];
  const warnings: string[] = [];
  let rangeViews: number | null = null;

  // Meta returns account-level views as a range total. Requesting it as a
  // time series can fail or omit the metric while the rest of the batch
  // succeeds, which used to make the UI silently show no view count.
  for (const [metric, metricType] of [
    ["reach", "time_series"],
    ["total_interactions", "total_value"],
    ["likes", "total_value"],
    ["views", "total_value"],
  ] as const) {
    try {
      const result = await graphGet<{ data?: UserInsight[] }>(`/${accountId}/insights`, token, {
        ...range,
        metric,
        metric_type: metricType,
      });
      const insight = result.data?.find((entry) => entry.name === metric);
      if (metric === "views") {
        const seriesTotal = insight?.values?.reduce((sum, item) =>
          typeof item.value === "number" && Number.isFinite(item.value) ? sum + item.value : sum, 0);
        const value = insight?.total_value?.value ?? (insight?.values?.length ? seriesTotal : null);
        if (typeof value === "number" && Number.isFinite(value)) rangeViews = value;
        else warnings.push("views: Meta returned no numeric value for the requested period.");
      }
      if (insight) data.push(insight);
    } catch (error) {
      // Keep other metrics available, but make an unavailable metric visible
      // in server logs rather than silently treating it as a real zero.
      const detail = error instanceof Error ? error.message : "Unknown insights error";
      warnings.push(`${metric}: ${detail}`);
      console.warn(`Instagram account insight ${metric} could not be read:`, {
        accountId,
        error: detail,
      });
    }
  }

  const byDate = new Map<string, Record<string, number | null>>();
  for (const insight of data) {
    const field = insight.name === "total_interactions" ? "engagement" : insight.name;
    if (!["reach", "views", "engagement", "likes"].includes(field)) continue;
    for (const value of insight.values ?? []) {
      if (typeof value.value !== "number" || !Number.isFinite(value.value) || !value.end_time) continue;
      const date = new Date(value.end_time);
      if (!Number.isFinite(date.getTime())) continue;
      const key = date.toISOString().slice(0, 10);
      const metrics = byDate.get(key) ?? {};
      metrics[field] = value.value;
      byDate.set(key, metrics);
    }
    if (!insight.values?.length && typeof insight.total_value?.value === "number") {
      const key = until.toISOString().slice(0, 10);
      const metrics = byDate.get(key) ?? {};
      metrics[field] = insight.total_value.value;
      byDate.set(key, metrics);
    }
  }

  const dailySnapshots: Array<{
    snapshotDate: Date;
    reach?: number | null;
    views?: number | null;
    engagement?: number | null;
    additionalMetrics?: Record<string, number>;
  }> = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, metrics]) => {
    const additionalMetrics: Record<string, number> = {};
    if (typeof metrics.likes === "number") additionalMetrics.likes = metrics.likes;
    return {
      snapshotDate: new Date(`${date}T00:00:00.000Z`),
      reach: metrics.reach ?? null,
      // Views are stored once on the sync-day snapshot below because Meta
      // returns a total for the requested date range, not daily values.
      views: null,
      engagement: metrics.engagement ?? null,
      additionalMetrics,
    };
  });
  return { dailySnapshots, rangeViews, warnings };
}

async function readMediaInsights(mediaId: string, token: string) {
  try {
    const result = await graphGet<{ data?: UserInsight[] }>(
      `/${mediaId}/insights`,
      token,
      { metric: "reach,views,saved,shares,total_interactions" },
    );
    return result.data ?? [];
  } catch {
    // Some metric names vary by media type and API version. Retry each
    // metric separately so a single unsupported metric does not hide the
    // metrics this account can provide.
  const values: UserInsight[] = [];
    for (const metric of ["reach", "views", "saved", "shares", "total_interactions"]) {
      try {
        const result = await graphGet<{ data?: UserInsight[] }>(
          `/${mediaId}/insights`, token, { metric },
        );
        values.push(...(result.data ?? []));
      } catch {
        // Unsupported for this media/account: leave it unavailable.
      }
    }
    return values;
  }
}

export const instagramReportingAdapter: SocialReportingAdapter = {
  platform: "INSTAGRAM",

  async fetchAccountMetrics(connection: SocialConnection): Promise<NormalizedSocialMetrics> {
    const scopes = new Set((connection.tokenScopes ?? "").split(/[\s,]+/).filter(Boolean));
    if (!connection.accessToken) throw new Error("Instagram connection needs to be renewed.");
    const [profile, insights, accountPosts] = await Promise.all([
      graphGet<{ followers_count?: number; media_count?: number }>(
        `/${connection.platformAccountId}`,
        connection.accessToken,
        { fields: "followers_count,media_count" },
      ),
      scopes.has("instagram_manage_insights")
        ? readAccountInsights(connection.platformAccountId, connection.accessToken)
        : Promise.resolve({
            dailySnapshots: [],
            rangeViews: null,
            warnings: ["Instagram Insights permission is missing; account metrics cannot be read until the account is reconnected with instagram_manage_insights."],
          }),
      readAccountPosts(connection.platformAccountId, connection.accessToken).catch((error) => {
        console.warn("Instagram account post list could not be read:", error);
        return [];
      }),
    ]);
    const latest = insights.dailySnapshots.at(-1);
    const snapshotDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const dailySnapshots = [...insights.dailySnapshots];
    // A range total belongs to the sync date. The reporting UI reads this
    // field as a latest value, rather than summing repeated rolling totals.
    if (insights.rangeViews !== null) {
      const today = dailySnapshots.find((item) => item.snapshotDate.getTime() === snapshotDate.getTime());
      if (today) today.views = insights.rangeViews;
      else dailySnapshots.push({ snapshotDate, views: insights.rangeViews });
    }
    return {
      followers: typeof profile.followers_count === "number" ? profile.followers_count : null,
      reach: latest?.reach ?? null,
      views: insights.rangeViews,
      engagement: latest?.engagement ?? null,
      dailySnapshots,
      accountPosts,
      reportingWarnings: insights.warnings,
      additionalMetrics: {
        ...(typeof profile.media_count === "number" ? { mediaCount: profile.media_count } : {}),
        ...(typeof latest?.additionalMetrics?.likes === "number" ? { likes: latest.additionalMetrics.likes } : {}),
      },
    };
  },

  async fetchPostMetrics(connection: SocialConnection, posts: PublishedPostRef[]) {
    if (!connection.accessToken) throw new Error("Instagram connection needs to be renewed.");
    const results = new Map<string, NormalizedSocialMetrics>();
    for (const post of posts) {
      if (!post.platformPostId) continue;
      try {
        const media = await graphGet<{
          media_type?: string;
          like_count?: number;
          comments_count?: number;
          permalink?: string;
          timestamp?: string;
        }>(`/${post.platformPostId}`, connection.accessToken, {
          fields: "media_type,like_count,comments_count,permalink,timestamp",
        });
        const insights = await readMediaInsights(post.platformPostId, connection.accessToken);
        const reach = valueFromInsights(insights, "reach");
        const views = valueFromInsights(insights, "views");
        const likes = typeof media.like_count === "number" ? media.like_count : null;
        const comments = typeof media.comments_count === "number" ? media.comments_count : null;
        const shares = valueFromInsights(insights, "shares");
        const saves = valueFromInsights(insights, "saved");
        const engagement = valueFromInsights(insights, "total_interactions");
        const metrics: NormalizedSocialMetrics = {
          reach,
          views,
          likes,
          comments,
          shares,
          saves,
          engagement,
          engagementRate: engagement !== null && reach ? engagement / reach : null,
          engagementRateBasis: engagement !== null && reach ? "reach" : null,
          additionalMetrics: {
            ...(media.media_type ? { mediaType: media.media_type } : {}),
            ...(media.permalink ? { permalink: media.permalink } : {}),
          },
          sourceUpdatedAt: media.timestamp ? new Date(media.timestamp) : null,
        };
        results.set(post.id, metrics);
      } catch (error) {
        const graphError = error as InstagramGraphRequestError;
        if (graphError.metaCode === 100 && graphError.metaSubcode === 33) {
          // A stale or inaccessible media object must not block account
          // metrics or reporting for other posts on this Instagram account.
          console.warn("Skipping an Instagram post unavailable to the reporting token:", {
            publishedSocialPostId: post.id,
            platformPostId: post.platformPostId,
          });
          continue;
        }
        throw error;
      }
    }
    return results;
  },
};
