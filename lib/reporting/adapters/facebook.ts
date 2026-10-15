import type { SocialConnection } from "@prisma/client";
import type {
  FacebookPageActivity,
  FacebookPagePost,
  NormalizedSocialMetrics,
  PublishedPostRef,
  SocialReportingAdapter,
} from "@/lib/reporting/types";

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const PAGE_POST_LIMIT = 5;
const LIKE_INSIGHT_LIMIT = 20;

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } };
type GraphCount = { summary?: { total_count?: number }; count?: number };
type InsightValue = { name?: string; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } };

function scopesFor(connection: SocialConnection) {
  return new Set((connection.tokenScopes ?? "").split(/[\s,]+/).filter(Boolean));
}

function requireConnection(connection: SocialConnection) {
  if (!connection.accessToken) {
    throw new Error("Facebook Page connection needs to be renewed. Reconnect the selected Page to continue reporting.");
  }
  if (!scopesFor(connection).has("pages_read_engagement")) {
    throw new Error("Facebook reporting permission is missing. Reconnect this Page after granting pages_read_engagement.");
  }
  return connection.accessToken;
}

async function graphGet<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.search = new URLSearchParams({ ...params, access_token: token }).toString();
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json().catch(() => ({})) as T & GraphError;
  const apiError = data.error;
  if (!response.ok || apiError) {
    const detail = (apiError?.message || `Facebook Graph API request failed (${response.status}).`)
      .split(token).join("[redacted]")
      .replace(/([?&](?:access_token|input_token|appsecret_proof)=)[^&\s]+/gi, "$1[redacted]");
    if (apiError?.code === 190) throw new Error(`Facebook Page connection needs renewal: ${detail}`);
    if (apiError?.code === 4 || apiError?.code === 17 || apiError?.code === 32 || apiError?.code === 613 || response.status === 429) {
      throw new Error("Facebook temporarily rate-limited reporting. Wait a few minutes, then refresh.");
    }
    if (apiError?.code === 10 || apiError?.code === 200) {
      throw new Error(`Meta denied access to Facebook GET ${path} (error ${apiError.code}${apiError.error_subcode ? `/${apiError.error_subcode}` : ""}). ${detail}${apiError.fbtrace_id ? ` Meta trace: ${apiError.fbtrace_id}.` : ""}`);
    }
    throw new Error(detail);
  }
  return data;
}

function asCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

async function optionalCount(path: string, token: string, params?: Record<string, string>): Promise<number | null> {
  try {
    const result = await graphGet<GraphCount>(path, token, params);
    return asCount(result.summary?.total_count ?? result.count);
  } catch {
    // Some Page/post metrics depend on Page role, post type, or Meta access.
    // Keep the post visible even when one optional count is unavailable.
    return null;
  }
}

async function optionalInsight(pageId: string, token: string, metric: string, period = "day"): Promise<number | null> {
  try {
    const result = await graphGet<{
      data?: Array<{ name?: string; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } }>;
    }>(`/${encodeURIComponent(pageId)}/insights`, token, { metric, period });
    const insight = result.data?.find((entry) => entry.name === metric);
    const last = insight?.total_value?.value ?? insight?.values?.at(-1)?.value;
    return asCount(last);
  } catch {
    // Insights are optional and can be unavailable for a Page or metric.
    return null;
  }
}

async function fetchPageInsights(pageId: string, token: string) {
  const metrics = [
    "page_total_media_view_unique",
    "page_media_view",
    "page_video_views",
    "page_post_engagements",
  ];
  const warnings: string[] = [];
  let rows: InsightValue[] = [];
  try {
    const result = await graphGet<{ data?: InsightValue[] }>(
      `/${encodeURIComponent(pageId)}/insights`,
      token,
      { metric: metrics.join(","), period: "day" },
    );
    rows = result.data ?? [];
  } catch {
    // One unsupported metric can fail the entire multi-metric request. Retry
    // independently so available metrics still populate the report.
    const settled = await Promise.all(metrics.map(async metric => {
      try {
        const result = await graphGet<{ data?: InsightValue[] }>(
          `/${encodeURIComponent(pageId)}/insights`, token, { metric, period: "day" },
        );
        return { metric, row: result.data?.find(item => item.name === metric) ?? null };
      } catch (error) {
        return { metric, row: null, error: error instanceof Error ? error.message : "Unknown Meta Insights error" };
      }
    }));
    rows = settled.flatMap(item => item.row ? [item.row] : []);
    warnings.push(...settled.flatMap(item => item.error ? [`${item.metric}: ${item.error}`] : []));
  }
  const values = Object.fromEntries(metrics.map(metric => {
    const insight = rows.find(row => row.name === metric);
    const raw = insight?.total_value?.value ?? insight?.values?.at(-1)?.value;
    return [metric, asCount(raw)];
  })) as Record<typeof metrics[number], number | null>;
  for (const metric of metrics) {
    if (values[metric] === null && !warnings.some(warning => warning.startsWith(`${metric}:`))) {
      warnings.push(`${metric}: Meta returned no value for this Page or date.`);
    }
  }
  return { values, warnings };
}

type PagePostRecord = {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
  likes?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
};

/** Page-owned content is required; engagement expansions have independent access rules.
 * Fetch optional fields in separate, bounded Page-edge requests so one denial cannot
 * discard authorized posts. Match results to the core feed by ID, never by position.
 */
async function fetchPagePosts(connection: SocialConnection, token: string, params: Record<string, string>) {
  const path = `/${encodeURIComponent(connection.platformAccountId)}/posts`;
  const core = await graphGet<{ data?: PagePostRecord[] }>(path, token, {
    ...params, fields: "id,message,created_time,permalink_url,full_picture",
  });
  const posts: PagePostRecord[] = (core.data ?? []).map(post => ({
    id: post.id, message: post.message, created_time: post.created_time,
    permalink_url: post.permalink_url, full_picture: post.full_picture,
  }));
  const notices: string[] = [];
  if (!posts.length) return { posts, notices };

  // Aggregate Post Insights can be authorized even when the public likes edge
  // is restricted. This is the specific Like-reaction metric, not all reactions.
  if (scopesFor(connection).has("read_insights")) {
    const eligible = posts.slice(0, LIKE_INSIGHT_LIMIT);
    for (let offset = 0; offset < eligible.length; offset += 2) {
      await Promise.all(eligible.slice(offset, offset + 2).map(async post => {
        const likes = await optionalInsight(post.id, token, "post_reactions_like_total", "lifetime");
        if (likes !== null) post.likes = { summary: { total_count: likes } };
      }));
    }
  }
  const fields: Array<{ key: "likes" | "comments" | "shares"; field: string; label: string }> = [
    ...(posts.some(post => asCount(post.likes?.summary?.total_count) === null)
      ? [{ key: "likes" as const, field: "likes.limit(0).summary(true)", label: "Like counts" }] : []),
    { key: "shares", field: "shares", label: "Share counts" },
  ];
  if (scopesFor(connection).has("pages_read_user_content")) {
    fields.push({ key: "comments", field: "comments.limit(0).summary(true)", label: "Comment counts" });
  } else {
    notices.push("Page content loaded. Comment counts need the additional pages_read_user_content permission and are unavailable on this connection.");
  }
  const results = await Promise.all(fields.map(async field => {
    try {
      const result = await graphGet<{ data?: PagePostRecord[] }>(path, token, { ...params, fields: `id,${field.field}` });
      return { ...field, records: result.data ?? [], error: null };
    } catch (error) {
      return { ...field, records: [] as PagePostRecord[], error: error instanceof Error ? error.message : "Meta did not return this metric." };
    }
  }));
  for (const result of results) {
    if (result.error) {
      notices.push(`${result.label} unavailable; the Page content remains accessible. ${result.error}`);
      continue;
    }
    const values = new Map(result.records.map(post => [post.id, post]));
    for (const post of posts) {
      const value = values.get(post.id);
      if (value && !(result.key === "likes" && asCount(post.likes?.summary?.total_count) !== null)) Object.assign(post, { [result.key]: value[result.key] });
    }
  }
  return { posts, notices };
}

async function fetchPostMetricValues(postId: string, token: string, includeInsights: boolean, includeComments: boolean) {
  const encodedId = encodeURIComponent(postId);
  const [likes, comments, shares] = await Promise.all([
    includeInsights
      ? optionalInsight(postId, token, "post_reactions_like_total", "lifetime").then(value => value ?? optionalCount(`/${encodedId}/likes`, token, { summary: "true", limit: "0" }))
      : optionalCount(`/${encodedId}/likes`, token, { summary: "true", limit: "0" }),
    includeComments ? optionalCount(`/${encodedId}/comments`, token, { summary: "true", limit: "0" }) : Promise.resolve(null),
    optionalCount(`/${encodedId}`, token, { fields: "shares" }),
  ]);
  const [reach, impressions] = includeInsights
    ? await Promise.all([
        optionalInsight(postId, token, "post_total_media_view_unique", "lifetime"),
        optionalInsight(postId, token, "post_media_view", "lifetime"),
      ])
    : [null, null];
  return { likes, comments, shares, reach, impressions };
}

async function fetchPageIdentity(connection: SocialConnection, token: string) {
  const id = encodeURIComponent(connection.platformAccountId);
  try {
    return await graphGet<{ id?: string; name?: string }>(`/${id}`, token, { fields: "id,name" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Facebook Page is no longer accessible.";
    throw new Error(message.toLowerCase().includes("permission") ? message : `Could not read the selected Facebook Page. Confirm it is still accessible, then reconnect it. ${message}`);
  }
}

export const facebookReportingAdapter: SocialReportingAdapter = {
  platform: "FACEBOOK",

  async fetchAccountMetrics(connection: SocialConnection): Promise<NormalizedSocialMetrics> {
    const token = requireConnection(connection);
    const page = await fetchPageIdentity(connection, token);

    let pageCounts: { followers_count?: number; fan_count?: number } = {};
    try {
      pageCounts = await graphGet(
        `/${encodeURIComponent(connection.platformAccountId)}`,
        token,
        { fields: "followers_count,fan_count" },
      );
    } catch {
      // A Page/API version may expose only one of these fields. Preserve the
      // follower value even when the separate likes count is unavailable.
      pageCounts = await graphGet<{ followers_count?: number }>(
        `/${encodeURIComponent(connection.platformAccountId)}`,
        token,
        { fields: "followers_count" },
      ).catch(() => ({}));
    }
    const followersCount = asCount(pageCounts.followers_count);
    const pageLikes = asCount(pageCounts.fan_count);

    const metrics: NormalizedSocialMetrics = {
      // Do not substitute fan_count (Page likes) for followers. They are
      // different measures and presenting likes as followers is misleading.
      followers: followersCount,
      additionalMetrics: {
        pageId: page.id ?? connection.platformAccountId,
        pageName: page.name ?? connection.accountName ?? "Facebook Page",
        ...(pageLikes !== null ? { pageLikes } : {}),
      },
    };

    const postWarnings: string[] = [];

    // Fetch the Page's own recent posts independently of Showwork's
    // PublishedSocialPost table. Optional engagement reads are separately bounded.
    try {
      const until = new Date();
      const since = new Date(until.getTime() - 366 * 24 * 60 * 60 * 1000);
      const nativePosts = await fetchPagePosts(connection, token, {
        limit: "100",
        since: String(Math.floor(since.getTime() / 1000)),
        until: String(Math.floor(until.getTime() / 1000)),
      });
      postWarnings.push(...nativePosts.notices);
      metrics.accountPosts = nativePosts.posts.flatMap((post) => {
        if (!post.created_time) return [];
        const publishedAt = new Date(post.created_time);
        if (!Number.isFinite(publishedAt.getTime())) return [];
        const likes = asCount(post.likes?.summary?.total_count);
        const comments = asCount(post.comments?.summary?.total_count);
        const shares = asCount(post.shares?.count);
        return [{
          platformPostId: post.id,
          caption: post.message ?? null,
          postType: "POST",
          publishedAt,
          permalink: post.permalink_url ?? null,
          likes,
          comments,
          shares,
          engagement: likes !== null && comments !== null && shares !== null ? likes + comments + shares : null,
        }];
      });
    } catch (error) {
      // Page insights remain useful if reading the optional native feed fails.
      console.warn("Facebook Page post list could not be read:", error);
    }

    if (!scopesFor(connection).has("read_insights")) {
      metrics.reportingWarnings = [...postWarnings, "Facebook Insights permission is missing. Reconnect this Page with read_insights granted to load Page performance metrics."];
    } else {
      // Eligibility varies by metric. Let Meta authorize the real requests;
      // fan_count alone must not block metrics that Meta actually provides.
      const { values, warnings } = await fetchPageInsights(connection.platformAccountId, token);
      // Meta's current media-view metrics replace deprecated impression and
      // unique-impression fields. `page_video_views` remains video-only;
      // `page_media_view` includes all displayed/played Page content.
      metrics.reach = values.page_total_media_view_unique;
      metrics.impressions = values.page_media_view;
      metrics.views = values.page_video_views;
      metrics.engagement = values.page_post_engagements;
      metrics.engagementRate = metrics.engagement !== null && metrics.reach ? metrics.engagement / metrics.reach : null;
      metrics.engagementRateBasis = metrics.engagementRate !== null ? "reach" : null;
      metrics.reportingWarnings = [...postWarnings, ...warnings];
    }
    return metrics;
  },

  async fetchPostMetrics(connection: SocialConnection, posts: PublishedPostRef[]) {
    const token = requireConnection(connection);
    const results = new Map<string, NormalizedSocialMetrics>();
    const includeInsights = scopesFor(connection).has("read_insights");
    for (const post of posts) {
      const postId = post.platformPostId || post.providerReference;
      if (!postId) continue;
      const [counts, engagement] = await Promise.all([
        fetchPostMetricValues(postId, token, includeInsights, scopesFor(connection).has("pages_read_user_content")),
        includeInsights ? optionalInsight(postId, token, "post_engaged_users", "lifetime") : Promise.resolve(null),
      ]);
      results.set(post.id, {
        ...counts,
        engagement,
        engagementRate: engagement !== null && counts.reach ? engagement / counts.reach : null,
        engagementRateBasis: engagement !== null && counts.reach ? "reach" : null,
      });
    }
    return results;
  },

  async fetchPageActivity(connection: SocialConnection, period): Promise<FacebookPageActivity> {
    const token = requireConnection(connection);
    const page = await fetchPageIdentity(connection, token);
    const pageId = page.id || connection.platformAccountId;

    const followers = await graphGet<{ followers_count?: number }>(`/${encodeURIComponent(pageId)}`, token, { fields: "followers_count" })
      .then((result) => asCount(result.followers_count)).catch(() => null);

    const result = await fetchPagePosts(connection, token, {
      limit: String(PAGE_POST_LIMIT),
      since: String(Math.floor(period.start.getTime() / 1000)),
      until: String(Math.floor(period.end.getTime() / 1000)),
    });

    const includeInsights = scopesFor(connection).has("read_insights");
    const pagePosts: FacebookPagePost[] = [];
    const records = result.posts;
    // The core feed plus up to three optional Page-edge reads remain bounded.
    // Insights need at most two follow-up requests per displayed post.
    for (let offset = 0; offset < records.length; offset += 2) {
      const batch = await Promise.all(records.slice(offset, offset + 2).map(async (post): Promise<FacebookPagePost> => {
        const [reach, impressions] = includeInsights
          ? await Promise.all([
              optionalInsight(post.id, token, "post_total_media_view_unique", "lifetime"),
              optionalInsight(post.id, token, "post_media_view", "lifetime"),
            ])
          : [null, null];
        return {
          id: post.id,
          message: post.message ?? null,
          createdAt: post.created_time ?? null,
          permalink: post.permalink_url ?? null,
          imageUrl: post.full_picture ?? null,
          likes: asCount(post.likes?.summary?.total_count),
          comments: asCount(post.comments?.summary?.total_count),
          shares: asCount(post.shares?.count),
          reach,
          impressions,
        };
      }));
      pagePosts.push(...batch);
    }

    let latestMetrics: FacebookPageActivity["latestMetrics"] = null;
    if (includeInsights) {
      const insights = await fetchPageInsights(pageId, token);
      latestMetrics = {
        asOf: new Date().toISOString(), reach: insights.values.page_total_media_view_unique,
        views: insights.values.page_video_views, engagement: insights.values.page_post_engagements,
        mediaViews: insights.values.page_media_view,
      };
    }

    return {
      pageId,
      pageName: page.name || connection.accountName || "Facebook Page",
      latestMetrics,
      followers,
      posts: pagePosts,
      notices: [
        ...result.notices,
        ...(!includeInsights ? ["Facebook Insights permission is missing. Reconnect this Page with read_insights granted to load Page performance metrics."] : []),
      ],
    };
  },
};
