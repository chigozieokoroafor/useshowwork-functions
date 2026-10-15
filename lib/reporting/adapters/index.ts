import type { SocialPlatform } from "@prisma/client";
import type { SocialPlatformAdapter } from "@/lib/reporting/types";
import { instagramReportingAdapter } from "@/lib/reporting/adapters/instagram";
import { tiktokReportingAdapter } from "@/lib/reporting/adapters/tiktok";
import { facebookReportingAdapter } from "@/lib/reporting/adapters/facebook";
import { publishPostToInstagram } from "@/lib/instagramPublishing";
import { publishPostToTikTok } from "@/lib/tiktokPublishing";
import {publishingIntegrationInstalled} from '@/lib/publishing/applicationBoundary';

import { xReportingAdapter } from "./x";
import { linkedinReportingAdapter } from "./linkedin";

const adapters: Partial<Record<SocialPlatform, SocialPlatformAdapter>> = {
  INSTAGRAM: { ...instagramReportingAdapter, publishPost: publishPostToInstagram },
  TIKTOK: { ...tiktokReportingAdapter, publishPost: publishPostToTikTok },
  FACEBOOK: facebookReportingAdapter,
  X: xReportingAdapter,
  LINKEDIN: linkedinReportingAdapter,
};

export function getSocialPlatformAdapter(platform: SocialPlatform) {
  if(publishingIntegrationInstalled()){const adapter=adapters[platform];if(!adapter)return null;const {publishPost:retired,...readOnly}=adapter;return readOnly;}
  return adapters[platform] ?? null;
}

export const getSocialReportingAdapter = getSocialPlatformAdapter;
