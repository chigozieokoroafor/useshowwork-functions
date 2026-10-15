import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type PublishingChannel = "facebook" | "linkedin" | "x";
export type OAuthChannel = PublishingChannel | "tiktok-messaging" | "tiktok" | "instagram";

type OAuthStatePayload = {
  channel: OAuthChannel;
  calendarId: string;
  nonce: string;
  expiresAt: number;
};

const STATE_TTL_SECONDS = 10 * 60;

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is required to start a secure channel connection.");
  return value;
}

function cookieName(channel: OAuthChannel) {
  return `showwork_${channel}_oauth_state`;
}

export function createChannelOAuthState(channel: OAuthChannel, calendarId: string) {
  const nonce = randomBytes(32).toString("base64url");
  const payload: OAuthStatePayload = {
    channel,
    calendarId,
    nonce,
    expiresAt: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret()).update(encoded).digest("base64url");
  return {
    state: `${encoded}.${signature}`,
    nonce,
    cookieName: cookieName(channel),
    maxAge: STATE_TTL_SECONDS,
  };
}

export function verifyChannelOAuthState(
  channel: OAuthChannel,
  state: string | null,
  cookieNonce: string | undefined,
): string | null {
  if (!state || !cookieNonce) return null;
  const [encoded, suppliedSignature, extra] = state.split(".");
  if (!encoded || !suppliedSignature || extra) return null;

  try {
    const expectedSignature = createHmac("sha256", secret()).update(encoded).digest();
    const actualSignature = Buffer.from(suppliedSignature, "base64url");
    if (
      expectedSignature.length !== actualSignature.length ||
      !timingSafeEqual(expectedSignature, actualSignature)
    ) return null;

    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
    const nonceMatches = Buffer.byteLength(payload.nonce) === Buffer.byteLength(cookieNonce) &&
      timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(cookieNonce));
    if (
      payload.channel !== channel ||
      !payload.calendarId ||
      !nonceMatches ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt < Math.floor(Date.now() / 1000)
    ) return null;

    return payload.calendarId;
  } catch {
    return null;
  }
}

export function channelOAuthCookieOptions(channel: OAuthChannel, maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: channel === "tiktok" ? "/api/calendars/tiktok/callback" : channel==='instagram'?'/api/calendars/instagram/callback':`/api/calendars/channels/${channel}/callback`,
    maxAge,
  };
}

export function xPkceCookieName() {
  return "showwork_x_pkce_verifier";
}
