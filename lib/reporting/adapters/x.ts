import type {
  SocialReportingAdapter,
  NormalizedSocialMetrics,
  SocialAccountPostRecord,
} from "@/lib/reporting/types";
import { freshConnection, requireScopes } from "@/lib/socialTokens";
import { providerJson } from "@/lib/publishing/http";

type Tweet = {
  id: string;
  text: string;
  created_at?: string;
  public_metrics?: {
    like_count?: number;
    reply_count?: number;
    retweet_count?: number;
    quote_count?: number;
    impression_count?: number;
    bookmark_count?: number;
  };
};

export function xMetrics(tweet: Tweet): NormalizedSocialMetrics {
  const m = tweet.public_metrics;

  const likes = m?.like_count ?? null;
  const comments = m?.reply_count ?? null;

  const shares =
    m?.retweet_count != null && m.quote_count != null
      ? m.retweet_count + m.quote_count
      : null;

  const engagement =
    likes != null && comments != null && shares != null
      ? likes + comments + shares
      : null;

  const impressions = m?.impression_count ?? null;

  return {
    likes,
    comments,
    shares,
    impressions,
    saves: m?.bookmark_count ?? null,
    engagement,
    engagementRate:
      impressions && engagement != null
        ? engagement / impressions
        : null,
    engagementRateBasis: impressions ? "impressions" : null,
  };
}

function xAccountPostMetrics(
  tweet: Tweet,
): Pick<
  SocialAccountPostRecord,
  "likes" | "comments" | "shares" | "impressions" | "saves" | "engagement"
> {
  const metrics = xMetrics(tweet);

  return {
    likes: metrics.likes ?? null,
    comments: metrics.comments ?? null,
    shares: metrics.shares ?? null,
    impressions: metrics.impressions ?? null,
    saves: metrics.saves ?? null,
    engagement: metrics.engagement ?? null,
  };
}

export const xReportingAdapter: SocialReportingAdapter = {
  platform: "X",
  refreshConnection: freshConnection,

  async fetchAccountMetrics(connection) {
    requireScopes(connection, ["tweet.read", "users.read"]);

    const headers = {
      Authorization: `Bearer ${connection.accessToken}`,
    };

    const user = await providerJson<{
      data: {
        public_metrics?: {
          followers_count?: number;
        };
      };
    }>(
      `https://api.x.com/2/users/${encodeURIComponent(
        connection.platformAccountId,
      )}?user.fields=public_metrics`,
      { headers },
    );

    const accountPosts: SocialAccountPostRecord[] = [];
    let token: string | undefined;

    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({
        max_results: "100",
        "tweet.fields": "created_at,public_metrics",
        exclude: "retweets",
        ...(token ? { pagination_token: token } : {}),
      });

      const result = await providerJson<{
        data?: Tweet[];
        meta?: {
          next_token?: string;
        };
      }>(
        `https://api.x.com/2/users/${encodeURIComponent(
          connection.platformAccountId,
        )}/tweets?${query}`,
        { headers },
      );

      for (const tweet of result.data ?? []) {
        if (!tweet.created_at) continue;

        accountPosts.push({
          platformPostId: tweet.id,
          caption: tweet.text,
          publishedAt: new Date(tweet.created_at),
          permalink: `https://x.com/i/web/status/${tweet.id}`,
          ...xAccountPostMetrics(tweet),
        });
      }

      token = result.meta?.next_token;

      if (!token) break;
    }

    return {
      followers: user.data?.public_metrics?.followers_count ?? null,
      accountPosts,
      reportingWarnings: token
        ? ["X reporting is limited to the most recent 1,000 posts."]
        : [],
    };
  },

  async fetchPostMetrics(connection, posts) {
    requireScopes(connection, ["tweet.read"]);

    const output = new Map<string, NormalizedSocialMetrics>();
    const eligible = posts.filter((post) => post.platformPostId);

    for (let offset = 0; offset < eligible.length; offset += 100) {
      const batch = eligible.slice(offset, offset + 100);

      const query = new URLSearchParams({
        ids: batch.map((post) => post.platformPostId!).join(","),
        "tweet.fields": "public_metrics",
      });

      const result = await providerJson<{
        data?: Tweet[];
      }>(`https://api.x.com/2/tweets?${query}`, {
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
        },
      });

      for (const tweet of result.data ?? []) {
        const post = batch.find(
          (candidate) => candidate.platformPostId === tweet.id,
        );

        if (post) {
          output.set(post.id, xMetrics(tweet));
        }
      }
    }

    return output;
  },
};
