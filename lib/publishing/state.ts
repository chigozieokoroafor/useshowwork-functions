import type { CalendarPost, InstagramPublishStatus, Prisma, SocialPlatform } from "@prisma/client";

export const PUBLISHING_PLATFORMS: SocialPlatform[] = ["INSTAGRAM", "TIKTOK", "FACEBOOK", "LINKEDIN", "X"];
export function statusField(platform: SocialPlatform) {
  return platform === "INSTAGRAM" ? "instagramPublishStatus" : platform === "TIKTOK" ? "tikTokPublishStatus" : "publishStatus";
}
export function publishingStatus(post: Pick<CalendarPost, "platform" | "instagramPublishStatus" | "tikTokPublishStatus" | "publishStatus">) {
  return post[statusField(post.platform)];
}
export function statusWhere(platform: SocialPlatform, status: InstagramPublishStatus): Prisma.CalendarPostWhereInput {
  return { platform, [statusField(platform)]: status };
}
export function statusUpdate(platform: SocialPlatform, status: InstagramPublishStatus, error: string | null = null): Prisma.CalendarPostUpdateManyMutationInput {
  const errorField = platform === "INSTAGRAM" ? "instagramPublishError" : platform === "TIKTOK" ? "tikTokPublishError" : "publishError";
  return { [statusField(platform)]: status, [errorField]: error };
}
export function buildCaption(post: { caption: string | null; cta: string | null; hashtags: string | null; taggedAccounts: string | null; linkUrl?: string | null }) {
  const mentions = post.taggedAccounts?.split(/[\s,]+/).filter(Boolean).map(value => value.startsWith("@") ? value : `@${value}`).join(" ");
  return [post.caption, mentions, post.cta, post.hashtags, post.linkUrl].map(value => value?.trim()).filter(Boolean).join("\n\n");
}
export function validatePublishContent(platform: SocialPlatform, assets: { mediaType: string }[], caption: string, postType?: string | null) {
  if (!PUBLISHING_PLATFORMS.includes(platform)) throw new Error("Publishing is not available for this channel.");
  if (/story/i.test(postType ?? "")) throw new Error("Automatic Story publishing is not supported for this channel. Choose a feed post or video.");
  if (assets.some(asset => !["PHOTO", "VIDEO"].includes(asset.mediaType))) throw new Error("Only photos and videos can be published through this integration.");
  const videos = assets.filter(asset => asset.mediaType === "VIDEO").length;
  if (platform !== "INSTAGRAM" && videos && (videos !== 1 || assets.length !== 1)) throw new Error("Choose one video, or a collection of photos. Mixed media and multiple videos are not supported for this channel.");
  if (!assets.length && (!caption.trim() || ["INSTAGRAM", "TIKTOK"].includes(platform))) throw new Error("Add content before publishing this post.");
  const photoLimit = platform === "TIKTOK" ? 35 : platform === "X" ? 4 : platform === "LINKEDIN" ? 20 : 10;
  if (assets.length > photoLimit) throw new Error(`This channel supports at most ${photoLimit} attachments per post.`);
  const captionLimit = platform === "TIKTOK" ? (videos ? 2200 : 4000) : platform === "LINKEDIN" ? 3000 : platform === "INSTAGRAM" ? 2200 : 63206;
  if (caption.length > captionLimit) throw new Error(`Shorten the caption to ${captionLimit} characters or fewer.`);
}
