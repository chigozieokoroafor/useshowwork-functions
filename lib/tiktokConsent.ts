import { createHash } from "node:crypto";
import { buildCaption } from "@/lib/publishing/state";
import { TIKTOK_CONSENT_VERSION, type TikTokSettings } from "@/lib/tiktokSettings";

type Content = { caption: string | null; cta: string | null; hashtags: string | null; taggedAccounts: string | null; linkUrl?: string | null; postType?: string | null; assets: { id: string; fileKey: string; mediaType: string; displayOrder?: number;objectVersion?:string|null;contentSha256?:string|null }[] };
export function tikTokConsentHash(post: Content, settings: TikTokSettings, accountId: string) {
  return createHash("sha256").update(JSON.stringify({ version: TIKTOK_CONSENT_VERSION, accountId,
    caption: buildCaption(post), postType: post.postType ?? null, settings,
    assets: [...post.assets].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.id.localeCompare(b.id)).map(a => ({ id: a.id, key: a.fileKey, type: a.mediaType,...(a.objectVersion!=null&&a.contentSha256!=null?{objectVersion:a.objectVersion,contentSha256:a.contentSha256}:{}) })),
  })).digest("hex");
}
