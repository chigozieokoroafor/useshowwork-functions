import type { SocialConnection, SocialPlatform } from "@prisma/client";

export type NormalizedSocialMetrics = {
  /** Date represented by account counters when the provider excludes today. */
  snapshotDate?: Date;
  reach?: number | null;
  impressions?: number | null;
  views?: number | null;
  engagement?: number | null;
  engagementRate?: number | null;
  engagementRateBasis?: "reach" | "impressions" | "views" | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  clicks?: number | null;
  followers?: number | null;
  /** Non-fatal API limitations to surface in the connection's sync status. */
  reportingWarnings?: string[];
  additionalMetrics?: Record<string, unknown>;
  /** Latest native content fetched from the connected platform account. */
  accountPosts?: SocialAccountPostRecord[];
  sourceUpdatedAt?: Date | null;
  /** Optional historical daily account metrics fetched from a platform insights edge. */
  dailySnapshots?: Array<{
    snapshotDate: Date;
    reach?: number | null;
    impressions?: number | null;
    views?: number | null;
    engagement?: number | null;
    additionalMetrics?: Record<string, unknown>;
  }>;
};

export type PublishedPostRef = {
  id: string;
  platformPostId: string | null;
  providerReference: string | null;
  publishedAt: Date | null;
};

export type SocialAccountPostRecord = {
  platformPostId: string;
  caption?: string | null;
  postType?: string | null;
  publishedAt: Date;
  permalink?: string | null;
  views?: number | null;
  reach?: number | null;
  impressions?: number | null;
  engagement?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
};

export type FacebookPagePost = {
  id: string;
  message: string | null;
  createdAt: string | null;
  permalink: string | null;
  imageUrl: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  reach: number | null;
  impressions: number | null;
};

export type FacebookPageActivity = {
  pageId: string;
  pageName: string;
  followers: number | null;
  posts: FacebookPagePost[];
  notices: string[];
  latestMetrics?: {
    asOf: string; reach: number | null; views: number | null;
    engagement: number | null; mediaViews: number | null;
  } | null;
};

export interface SocialPlatformAdapter {
  readonly platform: SocialPlatform;
  refreshConnection?(connection: SocialConnection): Promise<SocialConnection>;
  publishPost?(calendarPostId: string): Promise<void>;
  fetchPublishedPosts?(connection: SocialConnection): Promise<PublishedPostRef[]>;
  fetchPageActivity?(connection: SocialConnection, period: { start: Date; end: Date }): Promise<FacebookPageActivity>;
  fetchAccountMetrics(connection: SocialConnection): Promise<NormalizedSocialMetrics>;
  fetchPostMetrics(
    connection: SocialConnection,
    posts: PublishedPostRef[],
  ): Promise<Map<string, NormalizedSocialMetrics>>;
}

export type SocialReportingAdapter = SocialPlatformAdapter;
