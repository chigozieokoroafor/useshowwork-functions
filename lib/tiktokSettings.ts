export const TIKTOK_CONSENT_VERSION = "2026-10-08-v2-conversion";
export type TikTokSettings = {
  privacyLevel: string | null;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  disclosureEnabled: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  photoTitle: string;
  isAigc: boolean;
};
export const emptyTikTokSettings: TikTokSettings = {
  privacyLevel: null, allowComment: false, allowDuet: false, allowStitch: false,
  disclosureEnabled: false, yourBrand: false, brandedContent: false, photoTitle: "", isAigc: false,
};
export type TikTokCreator = {
  creator_nickname: string; creator_username: string; creator_avatar_url: string;
  privacy_level_options: string[]; comment_disabled: boolean; duet_disabled: boolean;
  stitch_disabled: boolean; max_video_post_duration_sec: number;
};
export function parseTikTokSettings(value: unknown): TikTokSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review your TikTok settings before publishing.");
  const input = value as Record<string, unknown>;
  const result = { ...emptyTikTokSettings };
  for (const key of ["allowComment", "allowDuet", "allowStitch", "disclosureEnabled", "yourBrand", "brandedContent", "isAigc"] as const) {
    if (typeof input[key] !== "boolean") throw new Error(`Choose a valid TikTok ${key} setting.`);
    result[key] = input[key];
  }
  if (typeof input.privacyLevel !== "string" || !["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"].includes(input.privacyLevel)) throw new Error("Choose TikTok visibility before publishing.");
  result.privacyLevel = input.privacyLevel;
  if (typeof input.photoTitle !== "string" || input.photoTitle.length > 90) throw new Error("TikTok photo title must be at most 90 characters.");
  result.photoTitle = input.photoTitle;
  return result;
}
export function validateTikTokSettings(settings: TikTokSettings, creator: TikTokCreator, isVideo: boolean) {
  if (!settings.privacyLevel || !creator.privacy_level_options.includes(settings.privacyLevel)) throw new Error("This account no longer allows the selected visibility. Refresh TikTok settings and choose again.");
  if (settings.disclosureEnabled && !settings.yourBrand && !settings.brandedContent) throw new Error("You need to indicate if your content promotes yourself, a third party, or both.");
  if (!settings.disclosureEnabled && (settings.yourBrand || settings.brandedContent)) throw new Error("Enable Content Disclosure or clear its selections.");
  if (settings.brandedContent && !["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"].includes(settings.privacyLevel)) throw new Error("Branded content visibility must be public or friends and cannot be set to private.");
  if (settings.allowComment && creator.comment_disabled) throw new Error("Comments are disabled in this TikTok account. Review your settings again.");
  if (isVideo && ((settings.allowDuet && creator.duet_disabled) || (settings.allowStitch && creator.stitch_disabled))) throw new Error("Duet or Stitch is now disabled in this TikTok account. Review your settings again.");
  if (!isVideo && (settings.allowDuet || settings.allowStitch)) throw new Error("Duet and Stitch are unavailable for photo posts.");
}
export function tikTokPostInfo(settings: TikTokSettings, creator: TikTokCreator, isVideo: boolean) {
  return {
    privacy_level: settings.privacyLevel,
    disable_comment: creator.comment_disabled || !settings.allowComment,
    ...(isVideo ? { disable_duet: creator.duet_disabled || !settings.allowDuet, disable_stitch: creator.stitch_disabled || !settings.allowStitch, is_aigc: settings.isAigc } : {}),
    brand_organic_toggle: settings.disclosureEnabled && settings.yourBrand,
    brand_content_toggle: settings.disclosureEnabled && settings.brandedContent,
  };
}
