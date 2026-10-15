import { pageAccountMetrics, pagePostMetrics } from "@/lib/linkedin/analytics";
import type { SocialReportingAdapter, NormalizedSocialMetrics } from "@/lib/reporting/types";
import { freshConnection, requireScopes } from "@/lib/socialTokens";
import { linkedInHeaders, providerJson } from "@/lib/publishing/http";

export const linkedinReportingAdapter: SocialReportingAdapter = {
  platform: "LINKEDIN", refreshConnection: freshConnection,
  async fetchAccountMetrics(connection) {
    if (connection.platformAccountId.startsWith("urn:li:organization:")) return pageAccountMetrics(connection);
    requireScopes(connection, ["r_member_postAnalytics"]);
    // Fetch bounded daily member analytics; never treat lifetime totals as
    // daily account activity. Reach cannot be summed across days.
    const start = new Date(); start.setUTCDate(start.getUTCDate() - 30);
    const date = `(year:${start.getUTCFullYear()},month:${start.getUTCMonth() + 1},day:${start.getUTCDate()})`;
    const snapshots = new Map<string, { snapshotDate: Date; impressions?: number; engagement?: number }>();
    for (const metric of ["IMPRESSION", "REACTION", "COMMENT", "RESHARE"]) {
      const url = `https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=me&queryType=${metric}&aggregation=DAILY&dateRange=(start:${date})&start=0&count=100`;
      const response = await providerJson<{ elements?: { count: number; dateRange?: { start: { year: number; month: number; day: number } } }[] }>(url, { headers: linkedInHeaders(connection.accessToken!) });
      for (const point of response.elements ?? []) {
        const day = point.dateRange?.start; if (!day || typeof point.count !== "number") continue;
        const key = `${day.year}-${day.month}-${day.day}`;
        const value = snapshots.get(key) ?? { snapshotDate: new Date(Date.UTC(day.year, day.month - 1, day.day)) };
        if (metric === "IMPRESSION") value.impressions = point.count;
        else value.engagement = (value.engagement ?? 0) + point.count;
        snapshots.set(key, value);
      }
    }
    const dailySnapshots = [...snapshots.values()];
    const current = [...dailySnapshots].sort((a, b) => b.snapshotDate.getTime() - a.snapshotDate.getTime())[0];
    return { snapshotDate: current?.snapshotDate, impressions: current?.impressions ?? null, engagement: current?.engagement ?? null, dailySnapshots, reportingWarnings: ["LinkedIn member analytics cover the last 30 days. Post-level metrics cover up to 100 posts published through Showwork; follower counts and native post discovery are not included."] };
  },
  async fetchPostMetrics(connection, posts) {
    if (connection.platformAccountId.startsWith("urn:li:organization:")) return pagePostMetrics(connection, posts);
    requireScopes(connection, ["r_member_postAnalytics"]);
    const output = new Map<string, NormalizedSocialMetrics>();
    for (const post of posts.filter(post => post.platformPostId).slice(0, 100)) {
      const urn = post.platformPostId!;
      if (!/^urn:li:(share|ugcPost):/.test(urn)) continue;
      const entity = `(${urn.includes(":ugcPost:") ? "ugc" : "share"}:${encodeURIComponent(urn)})`;
      const metrics: NormalizedSocialMetrics = {};
      const mapping = { IMPRESSION: "impressions", MEMBERS_REACHED: "reach", REACTION: "likes", COMMENT: "comments", RESHARE: "shares" } as const;
      for (const [queryType, field] of Object.entries(mapping)) {
        const result = await providerJson<{ elements?: { count: number }[] }>(`https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=entity&entity=${entity}&queryType=${queryType}&aggregation=TOTAL`, { headers: linkedInHeaders(connection.accessToken!) });
        metrics[field] = result.elements?.[0]?.count ?? null;
      }
      metrics.engagement = metrics.likes != null && metrics.comments != null && metrics.shares != null ? metrics.likes + metrics.comments + metrics.shares : null;
      metrics.engagementRate = metrics.impressions && metrics.engagement != null ? metrics.engagement / metrics.impressions : null;
      metrics.engagementRateBasis = metrics.impressions ? "impressions" : null;
      output.set(post.id, metrics);
    }
    return output;
  },
};
