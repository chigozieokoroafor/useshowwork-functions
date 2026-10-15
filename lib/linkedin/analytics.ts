import type { SocialConnection } from "@prisma/client";
import type { NormalizedSocialMetrics, PublishedPostRef } from "@/lib/reporting/types";
import { linkedInHeaders, providerJson } from "@/lib/publishing/http";
import { requireScopes } from "@/lib/socialTokens";
type Statistics = { impressionCount?: number; uniqueImpressionsCount?: number; clickCount?: number; likeCount?: number; commentCount?: number; shareCount?: number };
function normalize(stats: Statistics): NormalizedSocialMetrics {
  const engagement = [stats.likeCount, stats.commentCount, stats.shareCount].every(v => typeof v === "number") ? stats.likeCount! + stats.commentCount! + stats.shareCount! : null;
  return { impressions: stats.impressionCount ?? null, reach: stats.uniqueImpressionsCount ?? null, clicks: stats.clickCount ?? null, likes: stats.likeCount ?? null, comments: stats.commentCount ?? null, shares: stats.shareCount ?? null, engagement,
    engagementRate: stats.impressionCount && engagement !== null ? engagement / stats.impressionCount : null, engagementRateBasis: stats.impressionCount ? "impressions" : null };
}
function endpoint(connection: SocialConnection) {
  requireScopes(connection, ["rw_organization_admin"]);
  return `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(connection.platformAccountId)}`;
}
export async function pageAccountMetrics(connection: SocialConnection): Promise<NormalizedSocialMetrics> {
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  const start = end.getTime() - 30 * 86400000;
  const headers = linkedInHeaders(connection.accessToken!);
  const result = await providerJson<{ elements?: { timeRange?: { start: number }; totalShareStatistics: Statistics }[] }>(`${endpoint(connection)}&timeIntervals=(timeRange:(start:${start},end:${end.getTime()}),timeGranularityType:DAY)`, { headers });
  const dailySnapshots = (result.elements || []).filter(item => Number.isFinite(item.timeRange?.start)).map(item => ({ snapshotDate: new Date(item.timeRange!.start), ...normalize(item.totalShareStatistics) }));
  const warnings = ["LinkedIn Page daily statistics cover the last 30 completed days; post statistics cover up to 100 Showwork posts."];
  let followers: number | null = null;
  try { followers = (await providerJson<{ firstDegreeSize: number }>(`https://api.linkedin.com/rest/networkSizes/${encodeURIComponent(connection.platformAccountId)}?edgeType=CompanyFollowedByMember`, { headers })).firstDegreeSize; }
  catch { warnings.push("LinkedIn Page follower count could not be retrieved."); }
  return { followers, dailySnapshots, reportingWarnings: warnings };
}
export async function pagePostMetrics(connection: SocialConnection, posts: PublishedPostRef[]) {
  const output = new Map<string, NormalizedSocialMetrics>();
  const base = endpoint(connection);
  for (const post of posts.filter(post => /^urn:li:(share|ugcPost):/.test(post.platformPostId || "")).slice(0, 100)) {
    const parameter = post.platformPostId!.includes(":ugcPost:") ? "ugcPosts" : "shares";
    const result = await providerJson<{ elements?: { totalShareStatistics: Statistics }[] }>(`${base}&${parameter}=List(${encodeURIComponent(post.platformPostId!)})`, { headers: linkedInHeaders(connection.accessToken!) });
    output.set(post.id, normalize(result.elements?.[0]?.totalShareStatistics || {}));
  }
  return output;
}
