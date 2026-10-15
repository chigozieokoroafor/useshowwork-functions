import type { SocialConnection, SocialPlatform } from "@prisma/client";

export async function sendMetaInboxMessage({
  connection,
  instagramPageId,
  recipientId,
  text,
}: {
  connection: SocialConnection;
  instagramPageId?: string | null;
  recipientId: string;
  text: string;
}) {
  if (connection.platform !== "FACEBOOK" && connection.platform !== "INSTAGRAM") {
    throw new Error("This platform’s inbox is not enabled yet.");
  }
  if (!connection.accessToken) throw new Error("Reconnect this account to enable replies.");
  if (connection.status !== "CONNECTED" || (connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() <= Date.now())) throw new Error("Reconnect this account before replying.");
  if (!recipientId.trim() || !text.trim()) throw new Error("Select a recipient and enter a reply.");
  const endpointId = connection.platform === "INSTAGRAM"
    ? instagramPageId
    : connection.platformAccountId;
  if (!endpointId) {
    throw new Error(connection.platform === "INSTAGRAM"
      ? "Reconnect Instagram to refresh its linked Facebook Page connection before replying."
      : "Reconnect this account to enable replies.");
  }
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  const response = await fetch(`https://graph.facebook.com/${version}/${endpointId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      ...(connection.platform === "INSTAGRAM" ? { messaging_type: "RESPONSE" } : {}),
      message: { text },
      access_token: connection.accessToken,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({})) as {
    message_id?: string;
    error?: {
      message?: string;
      type?: string;
      code?: number;
      error_subcode?: number;
      fbtrace_id?: string;
    };
  };
  if (!response.ok || result.error) {
    const metaError = result.error;
    const diagnostics = [
      typeof metaError?.code === "number" ? `code=${metaError.code}` : null,
      typeof metaError?.error_subcode === "number" ? `subcode=${metaError.error_subcode}` : null,
      metaError?.type ? `type=${metaError.type}` : null,
      metaError?.fbtrace_id ? `fbtrace_id=${metaError.fbtrace_id}` : null,
    ].filter(Boolean);
    const message = metaError?.message || `Meta could not send the message (${response.status}).`;
    throw new Error(diagnostics.length ? `${message} [Meta ${diagnostics.join(", ")}]` : message);
  }
  if (typeof result.message_id !== "string" || !result.message_id.trim()) throw new Error("Meta did not confirm the sent message. Check the conversation before trying again.");
  return result.message_id;
}

/** Best-effort Messenger profile lookup for a Page-scoped user ID (PSID). */
export async function getFacebookMessengerProfile({
  pageScopedUserId,
  pageAccessToken,
}: {
  pageScopedUserId: string;
  pageAccessToken: string;
}): Promise<{ name: string | null; username: string | null } | null> {
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(pageScopedUserId)}`);
  url.searchParams.set("fields", "first_name,last_name");
  url.searchParams.set("access_token", pageAccessToken);
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const profile = await response.json().catch(() => null) as { first_name?: unknown; last_name?: unknown } | null;
    if (!profile) return null;
    const name = [profile.first_name, profile.last_name]
      .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
      .map((part) => part.trim())
      .join(" ");
    return name ? { name, username: null } : null;
  } catch {
    // Profile access can be unavailable because of Meta permissions or API
    // restrictions. Receiving the message must still succeed in that case.
    return null;
  }
}

/** Best-effort Instagram Messaging profile lookup using the IGSID and the
 * connected account's Page access token. Meta may withhold profile fields;
 * callers should retain the sender ID as a fallback. */
export async function getInstagramMessagingProfile({
  instagramScopedUserId,
  pageAccessToken,
}: {
  instagramScopedUserId: string;
  pageAccessToken: string;
}): Promise<{ name: string | null; username: string | null } | null> {
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(instagramScopedUserId)}`);
  url.searchParams.set("fields", "name,username");
  url.searchParams.set("access_token", pageAccessToken);
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const profile = await response.json().catch(() => null) as { name?: unknown; username?: unknown } | null;
    if (!profile) return null;
    const clean = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    const name = clean(profile.name);
    const username = clean(profile.username)?.replace(/^@/, "") ?? null;
    return name || username ? { name, username } : null;
  } catch {
    return null;
  }
}

export function metaWebhookPlatform(object: string): SocialPlatform | null {
  if (object === "page") return "FACEBOOK";
  if (object === "instagram") return "INSTAGRAM";
  return null;
}

export async function subscribeMetaMessagingAccount(accountId: string, accessToken: string, platform: "FACEBOOK" | "INSTAGRAM") {
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  // Instagram DMs only need the `messages` event. Keep Facebook's
  // established subscription fields unchanged.
  const fields = platform === "FACEBOOK" ? "messages,messaging_postbacks" : "messages";
  const response = await fetch(`https://graph.facebook.com/${version}/${accountId}/subscribed_apps`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ subscribed_fields: fields, access_token: accessToken }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as { success?: boolean; error?: { message?: string } };
  if (!response.ok || data.error || data.success !== true) throw new Error(data.error?.message || `Meta webhook subscription was not confirmed (${response.status}).`);
}
