import { linkedInMessagingConfigured } from "@/lib/linkedin/messagingAccess";
import {publishingFetch as fetch} from '@/lib/publishing/executionContext';
import { linkedInMessagingProvider } from "@/lib/linkedin/messagingProvider";
import { createHash, randomBytes } from "node:crypto";
import type { PublishingChannel } from "@/lib/channelOAuthState";

type OAuthTokens = {
  access_token: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

function credentials(channel: PublishingChannel) {
  if (channel === "facebook") {
    const clientId = process.env.FACEBOOK_APP_ID;
    const clientSecret = process.env.FACEBOOK_APP_SECRET;
    if (!clientId || !clientSecret) throw new Error("Facebook publishing is not configured.");
    return { clientId, clientSecret };
  }
  if (channel === "linkedin") {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("LinkedIn publishing is not configured.");
    return { clientId, clientSecret };
  }
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("X publishing is not configured.");
  return { clientId, clientSecret };
}

export function createXCodeVerifier() {
  return randomBytes(48).toString("base64url");
}

export function createXCodeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildChannelAuthorizationUrl({
  channel,
  redirectUri,
  state,
  codeChallenge,
  linkedInPages = false,
  linkedInAnalytics = false,
}: {
  channel: PublishingChannel;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
  linkedInPages?: boolean;
  linkedInAnalytics?: boolean;
}) {
  const { clientId } = credentials(channel);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });

  if (channel === "facebook") {
    params.set("scope", "pages_show_list,pages_read_engagement,pages_manage_posts,read_insights,pages_messaging,pages_manage_metadata");
    params.set("auth_type", "rerequest");
    return `https://www.facebook.com/${process.env.META_GRAPH_API_VERSION || "v26.0"}/dialog/oauth?${params}`;
  }

  if (channel === "linkedin") {
    params.set("scope", ["openid", "profile", "w_member_social", ...(linkedInMessagingConfigured() && linkedInPages ? linkedInMessagingProvider!.requiredScopes : []), ...(linkedInPages ? ["rw_organization_admin", "w_organization_social", "r_organization_social"] : []), ...(linkedInAnalytics || process.env.LINKEDIN_ANALYTICS_ENABLED === "true" ? ["r_member_postAnalytics"] : [])].join(" "));
    return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
  }

  if (!codeChallenge) throw new Error("X OAuth requires a PKCE code challenge.");
  params.set("scope", "tweet.read tweet.write users.read offline.access media.write dm.read dm.write");
  params.set("code_challenge", codeChallenge);
  params.set("code_challenge_method", "S256");
  return `https://twitter.com/i/oauth2/authorize?${params}`;
}

async function readJson<T>(response: Response, provider: string): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & {
    error?: string | { message?: string };
    error_description?: string;
  };
  if (!response.ok || data.error) {
    const message = typeof data.error === "string"
      ? data.error_description || data.error
      : data.error?.message;
    throw new Error(message || `${provider} request failed (${response.status}).`);
  }
  return data;
}

export async function exchangeChannelCode({
  channel,
  code,
  redirectUri,
  codeVerifier,
}: {
  channel: PublishingChannel;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}) {
  const { clientId, clientSecret } = credentials(channel);

  if (channel === "facebook") {
    const url = new URL(`https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || "v26.0"}/oauth/access_token`);
    url.search = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }).toString();
    return readJson<OAuthTokens>(await fetch(url, { cache: "no-store" }), "Facebook");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });

  if (channel === "linkedin") {
    body.set("client_secret", clientSecret);
    return readJson<OAuthTokens>(await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    }), "LinkedIn");
  }

  if (!codeVerifier) throw new Error("The X authorization session expired. Please connect again.");
  body.set("code_verifier", codeVerifier);
  return readJson<OAuthTokens>(await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body,
    cache: "no-store",
  }), "X");
}

export async function getFacebookPages(userAccessToken: string) {
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  const url = new URL(`https://graph.facebook.com/${version}/me/accounts`);
  url.search = new URLSearchParams({
    fields: "id,name,access_token",
    access_token: userAccessToken,
  }).toString();
  const result = await readJson<{ data?: { id: string; name: string; access_token: string }[] }>(
    await fetch(url, { cache: "no-store" }),
    "Facebook Pages",
  );
  return result.data ?? [];
}

export async function getFacebookGrantedPermissions(userAccessToken: string) {
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  const url = new URL(`https://graph.facebook.com/${version}/me/permissions`);
  url.search = new URLSearchParams({ access_token: userAccessToken }).toString();
  const result = await readJson<{ data?: { permission: string; status: string }[] }>(
    await fetch(url, { cache: "no-store" }),
    "Facebook permissions",
  );
  return (result.data ?? [])
    .filter((permission) => permission.status === "granted")
    .map((permission) => permission.permission);
}

export async function exchangeForLongLivedFacebookToken(shortLivedToken: string) {
  const { clientId, clientSecret } = credentials("facebook");
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  const url = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  url.search = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: shortLivedToken,
  }).toString();
  return readJson<OAuthTokens>(await fetch(url, { cache: "no-store" }), "Facebook token exchange");
}

export async function getLinkedInMember(accessToken: string) {
  return readJson<{ sub: string; name?: string; given_name?: string; family_name?: string }>(
    await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    }),
    "LinkedIn profile",
  );
}

export async function getXMember(accessToken: string) {
  const url = new URL("https://api.x.com/2/users/me");
  url.searchParams.set("user.fields", "name,username");
  const result = await readJson<{ data: { id: string; name: string; username: string } }>(
    await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    }),
    "X profile",
  );
  return result.data;
}
