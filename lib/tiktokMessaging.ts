import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://business-api.tiktok.com/open_api/v1.3";
export const TIKTOK_MESSAGING_SCOPES = ["message.list.read", "message.list.send", "message.list.manage", "user.account.type"];
export function tikTokMessagingConfigured() {
  return !!(process.env.TIKTOK_BUSINESS_CLIENT_ID && process.env.TIKTOK_BUSINESS_CLIENT_SECRET && process.env.TIKTOK_BUSINESS_AUTH_URL);
}
export function buildTikTokMessagingAuthUrl(state: string, redirectUri: string) {
  if (!tikTokMessagingConfigured()) throw new Error("Configure the approved TikTok Business Messaging app first.");
  // Use the account-holder URL issued by TikTok; Business and publishing
  // apps have different IDs, tokens and authorization parameters.
  const url = new URL(process.env.TIKTOK_BUSINESS_AUTH_URL!);
  if (url.protocol !== "https:" || url.hostname !== "www.tiktok.com" || !url.pathname.startsWith("/v2/auth/authorize")) throw new Error("Use the TikTok account holder authorization URL from your Business app.");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("disable_auto_auth", "1");
  return url.toString();
}
export async function tikTokBusinessRequest<T>(path: string, options: { token?: string; query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, value);
  const response = await fetch(url.toString(), {
    method: options.body === undefined ? "GET" : "POST",
    headers: { ...(options.token ? { "Access-Token": options.token } : {}), ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(15_000), cache: "no-store",
  });
  const result = await response.json();
  // Provider messages can contain submitted values; do not expose them or tokens.
  if (!response.ok || result.code !== 0 || !result.data) throw new Error(`TikTok Business request failed (HTTP ${response.status}, code ${typeof result.code === "number" ? result.code : "unknown"}). Check Business Messaging approval and account permissions.`);
  return result.data as T;
}
export type TikTokBusinessTokens = { access_token: string; refresh_token: string; open_id: string; scope: string; expires_in: number; refresh_token_expires_in: number };
export async function tikTokMessagingTokens(input: { code: string; redirectUri: string } | { refreshToken: string }) {
  const refreshing = "refreshToken" in input;
  const data = await tikTokBusinessRequest<TikTokBusinessTokens>(refreshing ? "/tt_user/oauth2/refresh_token/" : "/tt_user/oauth2/token/", { body: {
    client_id: process.env.TIKTOK_BUSINESS_CLIENT_ID, client_secret: process.env.TIKTOK_BUSINESS_CLIENT_SECRET,
    ...(refreshing ? { grant_type: "refresh_token", refresh_token: input.refreshToken } : { grant_type: "authorization_code", auth_code: input.code, redirect_uri: input.redirectUri }),
  } });
  if (!data.access_token || !data.refresh_token || !data.open_id || typeof data.scope !== "string" || !(data.expires_in > 0) || !(data.refresh_token_expires_in > 0)) throw new Error("TikTok returned incomplete Business credentials. Reconnect messaging.");
  if (!TIKTOK_MESSAGING_SCOPES.every(scope => data.scope.split(/[\s,]+/).includes(scope))) throw new Error("Authorize all four TikTok Business Messaging permissions before connecting.");
  return data;
}
export async function subscribeTikTokMessaging(callbackUrl: string) {
  if (new URL(callbackUrl).protocol !== "https:") throw new Error("TikTok messaging requires an HTTPS webhook callback.");
  await tikTokBusinessRequest("/business/webhook/update/", { body: { app_id: process.env.TIKTOK_BUSINESS_CLIENT_ID, secret: process.env.TIKTOK_BUSINESS_CLIENT_SECRET, event_type: "DIRECT_MESSAGE", callback_url: callbackUrl } });
}
export function verifyTikTokMessagingSignature(raw: string, header: string | null, secret = process.env.TIKTOK_BUSINESS_CLIENT_SECRET, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = header.split(",").map(part => part.trim());
  const timestamps = parts.filter(part => part.startsWith("t="));
  const signatures = parts.filter(part => part.startsWith("s="));
  if (timestamps.length !== 1 || !signatures.length) return false;
  const timestamp = timestamps[0].slice(2);
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest();
  return signatures.some(part => /^[a-f0-9]{64}$/i.test(part.slice(2)) && timingSafeEqual(expected, Buffer.from(part.slice(2), "hex")));
}
