import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { publishingFetch as fetch } from "@/lib/publishing/executionContext";
/* canonical-only-helper */
import { publishingAccountIOActive } from "@/lib/publishing/executionContext";
/* end-canonical-only-helper */
// ─────────────────────────────────────────────
// TIKTOK CONTENT POSTING API — connection (standard OAuth 2.0) and
// Direct Post publishing helpers.
//
// Unaudited clients are restricted to private viewing. Public publishing
// requires TikTok's content audit and the user's permitted privacy choice.
// PULL_FROM_URL also requires a verified media domain.
//
// TIKTOK_CLIENT_KEY is safe to reference in a redirect URL (it's
// meant to be public, TikTok's equivalent of an App ID).
// TIKTOK_CLIENT_SECRET must only ever be used in the two
// server-to-server token calls below — never sent to the browser.
// ─────────────────────────────────────────────

const API_BASE = "https://open.tiktokapis.com/v2";

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;

function requireAppCredentials() {
  if (!CLIENT_KEY || !CLIENT_SECRET) {
    throw new Error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set — TikTok publishing isn't configured yet.");
  }
  return { CLIENT_KEY, CLIENT_SECRET };
}

// user.info.basic — for the account's display name/username.
// video.publish — the actual Direct Post permission.
export const TIKTOK_OAUTH_SCOPES = "user.info.basic,user.info.stats,video.list,video.publish";

/** Builds the TikTok authorization page URL the manager is redirected to. */
export function buildTikTokAuthUrl({ redirectUri, state, codeChallenge }: { redirectUri: string; state: string; codeChallenge: string }): string {
  const { CLIENT_KEY } = requireAppCredentials();
  const params = new URLSearchParams({
    client_key: CLIENT_KEY,
    scope: TIKTOK_OAUTH_SCOPES,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

interface TikTokTokenResponse {
  open_id: string;
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TikTokTokenResponse> {
  const { CLIENT_KEY, CLIENT_SECRET } = requireAppCredentials();
  const res = await fetch(`${API_BASE}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: CLIENT_KEY, client_secret: CLIENT_SECRET, ...body }).toString(),
    signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  const data = (await res.json()) as TikTokTokenResponse;
  if (!res.ok || data.error) {
    throw new Error(data.error_description ?? data.error ?? `TikTok token request failed (${res.status})`);
  }
  if (!data.access_token || !data.refresh_token || !data.open_id || !Number.isFinite(data.expires_in) || !Number.isFinite(data.refresh_expires_in)) throw new Error("TikTok returned an incomplete connection. Reconnect the account.");
  return data;
}

/** Exchanges the OAuth `code` for the account's access + refresh tokens. */
export function exchangeCodeForTikTokTokens(code: string, redirectUri: string, codeVerifier: string) {
  return tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: codeVerifier });
}

/** Mints a fresh access token from a still-valid refresh token — no user interaction needed. */
export function refreshTikTokAccessToken(refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export class TikTokApiError extends Error {
  constructor(public code: string, public status: number, detail?: string) {
    const messages: Record<string, string> = {
      spam_risk_too_many_posts: "TikTok's daily posting limit has been reached. Try again later.",
      spam_risk_user_banned_from_posting: "TikTok currently prevents this account from posting. Check the account in TikTok.",
      reached_active_user_cap: "This app's TikTok creator limit has been reached. Try again later.",
      rate_limit_exceeded: "TikTok is receiving too many requests. Try again shortly.",
      scope_not_authorized: "TikTok publishing permission is missing. Reconnect and grant publishing access.",
      access_token_invalid: "TikTok's connection expired. Reconnect the account.",
      url_ownership_unverified: "The media domain has not been verified for this TikTok app. Contact support.",
      unaudited_client_can_only_post_to_private_accounts: "Until TikTok approves this app, use a private TikTok account and select Only me.",
    };
    super(messages[code] || `TikTok could not complete the request (${code}). Try again or contact support.`);
  }
}

async function apiPost<T>(path: string, accessToken: string, body: Record<string, unknown>): Promise<T> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { if (!publishingAccountIOActive()) { await assertLegacyPublishingAllowed("lib/tiktok.ts#apiPost@100"); } } /* end-canonical-integration-boundary */

  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok || data.error?.code !== "ok") {
    // TikTok's human-readable `message` text is often identical
    // generic wording across several different underlying error
    // codes (e.g. several App-status and content-policy errors all
    // point to the same guidelines URL) — the `code` itself is what
    // actually tells you which one it really is, so it's included
    // here even though it makes the message slightly less clean.
    const code = data.error?.code;
    const message = data.error?.message ?? `TikTok API request failed (${res.status})`;
    throw new TikTokApiError(code || "request_failed", res.status, message);
  }
  return data.data as T;
}

/** The account's display name — TikTok's closest equivalent to a username for display purposes. */
export async function getTikTokDisplayName(accessToken: string): Promise<string> {
  const res = await fetch(`${API_BASE}/user/info/?fields=display_name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok || data.error?.code !== "ok") {
    throw new Error(data.error?.message ?? "Failed to fetch TikTok account info");
  }
  return data.data.user.display_name;
}

export interface CreatorInfo {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

/**
 * Must be called immediately before every single publish — required
 * by TikTok's own review criteria, since which privacy levels and
 * which comment/duet/stitch toggles are even available differs per
 * account and can change at any time. Never cache this between
 * publishes.
 */
export async function queryTikTokCreatorInfo(accessToken: string): Promise<CreatorInfo> {
  const info = await apiPost<CreatorInfo>("/post/publish/creator_info/query/", accessToken, {});
  if (!info || !info.creator_nickname || !info.creator_username || !Array.isArray(info.privacy_level_options) || !info.privacy_level_options.length ||
    [info.comment_disabled, info.duet_disabled, info.stitch_disabled].some(value => typeof value !== "boolean") ||
    !Number.isFinite(info.max_video_post_duration_sec) || info.max_video_post_duration_sec <= 0) throw new Error("TikTok did not return complete creator permissions. Refresh account settings before publishing.");
  return info;
}

interface PublishInitResponse {
  publish_id: string;
}

/**
 * Starts a Direct Post video publish, pulling the video from a
 * public URL (PULL_FROM_URL) rather than uploading bytes directly —
 * this is the simpler transfer method and matches how the video is
 * already hosted publicly on R2 for Instagram, but requires that R2
 * domain to be verified with TikTok first (a one-time manual setup
 * step, separate from anything this code does).
 *
 * privacyLevel must be one of the exact strings creatorInfo just
 * returned as available for this specific account — never assumed
 * or hardcoded, since TikTok rejects apps that pre-select a privacy
 * level the account doesn't actually offer.
 */
export function initTikTokVideoPublish({
  accessToken,
  videoUrl,
  caption,
  privacyLevel,
  disableComment,
  postInfo,
}: {
  accessToken: string;
  videoUrl: string;
  caption: string;
  privacyLevel: string;
  disableComment: boolean;
  postInfo?: Record<string, unknown>;
}): Promise<PublishInitResponse> {
  return apiPost<PublishInitResponse>("/post/publish/video/init/", accessToken, {
    post_info: {
      title: caption,
      privacy_level: privacyLevel,
      disable_comment: disableComment,
      disable_duet: true, disable_stitch: true,
      brand_content_toggle: false, brand_organic_toggle: false,
      ...postInfo,
    },
    source_info: {
      source: "PULL_FROM_URL",
      video_url: videoUrl,
    },
  });
}

/**
 * Starts a Direct Post photo publish — TikTok's newer photo-mode
 * endpoint, separate from the video one above. Supports multiple
 * photo URLs for a carousel-style post, same idea as Instagram's
 * carousel but a completely different underlying endpoint.
 */
export function initTikTokPhotoPublish({
  accessToken,
  photoUrls,
  caption,
  privacyLevel,
  disableComment = true,
  postInfo,
  photoTitle = "",
  isAigc = false,
}: {
  accessToken: string;
  photoUrls: string[];
  caption: string;
  privacyLevel: string;
  disableComment?: boolean;
  postInfo?: Record<string, unknown>;
  photoTitle?: string;
  isAigc?: boolean;
}): Promise<PublishInitResponse> {
  return apiPost<PublishInitResponse>("/post/publish/content/init/", accessToken, {
    media_type: "PHOTO",
    is_aigc: isAigc,
    post_mode: "DIRECT_POST",
    post_info: {
      title: photoTitle,
      description: caption,
      disable_comment: disableComment,
      privacy_level: privacyLevel,
      brand_content_toggle: false, brand_organic_toggle: false,
      ...postInfo,
    },
    source_info: {
      source: "PULL_FROM_URL",
      photo_images: photoUrls,
      photo_cover_index: 0,
    },
  });
}

export interface PublishStatus {
  status: "PROCESSING_DOWNLOAD" | "PROCESSING_UPLOAD" | "PUBLISH_COMPLETE" | "FAILED" | "SEND_TO_USER_INBOX";
  fail_reason?: string;
  publicaly_available_post_id?: (string | number)[];
}

export function checkTikTokPublishStatus(accessToken: string, publishId: string): Promise<PublishStatus> {
  return apiPost<PublishStatus>("/post/publish/status/fetch/", accessToken, { publish_id: publishId });
}

/**
 * TikTok processes a publish asynchronously — init returns
 * immediately with a publish_id, and the actual result (success or
 * failure) only becomes known moments later. This polls status
 * until it settles, the same role waitForContainerReady plays for
 * Instagram videos, just with an extra terminal state to watch for.
 */
export async function waitForTikTokPublishResult(accessToken: string, publishId: string, maxAttempts = 20): Promise<PublishStatus> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await checkTikTokPublishStatus(accessToken, publishId);
    if (result.status === "PUBLISH_COMPLETE") return result;
    if (result.status === "FAILED") throw new Error(result.fail_reason ?? "TikTok reported the publish failed");
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Timed out waiting for TikTok to finish publishing");
}
