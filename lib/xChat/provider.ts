import type { SocialConnection } from "@prisma/client";
import { freshConnection, requireScopes } from "@/lib/socialTokens";

export class XChatError extends Error {
  constructor(message: string, public status = 400, public retrySamePayload = false) { super(message); }
}
export type PublicKey = { public_key_version: string; public_key: string; signing_public_key: string; identity_public_key_signature: string; juicebox_config?: Record<string, unknown> };
export async function chatConnection(stored: SocialConnection, write = false) {
  const connection = await freshConnection(stored);
  requireScopes(connection, ["dm.read", "users.read", "tweet.read", ...(write ? ["dm.write"] : [])]);
  return connection;
}
export async function chatRequest<T>(connection: SocialConnection, path: string, body?: unknown, allowPartialList = false): Promise<T> {
  const response = await fetch(`https://api.x.com/2/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${connection.accessToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  // Do not log or echo provider bodies: setup responses include realm credentials.
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || (data.errors?.length && !(allowPartialList && Array.isArray(data.data))) || data.error) {
    const problems = [data, ...(Array.isArray(data?.errors) ? data.errors : [])];
    if (problems.some(problem => problem?.type === "https://api.x.com/2/problems/recipient-not-messageable")) {
      throw new XChatError("X does not allow this account to message this recipient. Check their message settings and whether either account has blocked the other.", 502);
    }
    const messages: Record<number, string> = {
      400: "X rejected the encrypted reply. Refresh messages to load the latest conversation keys before trying again.",
      401: "X Chat authorization expired. Refresh permissions in Channels.",
      402: "X Chat requires API credits. Check the X developer account billing.",
      403: "X denied Chat API access. Check this app's Chat access and granted DM permissions.",
      404: "X Chat could not find this account, conversation, or endpoint.",
      429: "X Chat rate limit reached. Wait before trying again.",
    };
    throw new XChatError(messages[response.status] || "X Chat returned an invalid or incomplete response. Please try again.", 502, response.status >= 500 || response.ok);
  }
  return data as T;
}
export const publicKeys = (connection: SocialConnection, userId: string, backup = false) => chatRequest<{ data?: PublicKey[] }>(connection,
  `users/${encodeURIComponent(userId)}/public_keys?public_key.fields=public_key_version,public_key,signing_public_key,identity_public_key_signature${backup ? ",juicebox_config" : ""}`);

export function participantForConversation(id: string, accountId: string) {
  if (/^[0-9]{1,19}$/.test(id) && id !== accountId) return id;
  const pair = id.split(/[:-]/);
  if (pair.length === 2 && pair.every(part => /^[0-9]{1,19}$/.test(part)) && pair.includes(accountId)) {
    const other = pair.find(part => part !== accountId);
    if (other) return other;
  }
  throw new XChatError("Choose a one-to-one conversation belonging to this X account.");
}
export function encryptedSendBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new XChatError("Invalid encrypted message.");
  const body = value as Record<string, unknown>;
  const allowed = ["message_id", "encoded_message_create_event", "encoded_message_event_signature"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new XChatError("Only encrypted message fields are accepted.");
  if (typeof body.message_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.message_id)) throw new XChatError("Invalid message ID.");
  for (const field of allowed.slice(1)) {
    if (typeof body[field] !== "string" || !(body[field] as string).length || (body[field] as string).length > 100_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body[field] as string)) throw new XChatError("Invalid encrypted message payload.");
  }
  return { message_id: body.message_id, encoded_message_create_event: body.encoded_message_create_event as string, encoded_message_event_signature: body.encoded_message_event_signature as string };
}

/** Conversation updates and outbound messages do not qualify a contact. */
const inboundEligibility = new Map<string, { eligible: boolean; expires: number }>();
export async function hasRecentXInbound(connection: SocialConnection, participantId: string) {
  const cutoff = connection.connectedAt.getTime();
  // Cache metadata only. Never retain OAuth tokens, ciphertext, or plaintext.
  const cacheKey = connection.id ? `${connection.id}:${cutoff}:${participantId}` : null;
  const cached = cacheKey ? inboundEligibility.get(cacheKey) : undefined;
  if (cached && cached.expires > Date.now()) return cached.eligible;
  const remember = (eligible: boolean) => {
    if (cacheKey) {
      if (inboundEligibility.size >= 1000) inboundEligibility.delete(inboundEligibility.keys().next().value!);
      inboundEligibility.set(cacheKey, { eligible, expires: Date.now() + (eligible ? 300_000 : 30_000) });
    }
    return eligible;
  };
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const params = new URLSearchParams({ max_results: "100", "chat_message_event.fields": "id,sender_id,created_at,encoded_event" });
    if (cursor) params.set("pagination_token", cursor);
    const page = await chatRequest<{ data?: { sender_id?: string; created_at?: string; encoded_event?: string }[]; meta?: { next_token?: string } }>(connection, `chat/conversations/${participantId}/events?${params}`);
    const events = page.data || [];
    if (events.some(event => event.sender_id === participantId && !!event.encoded_event && Date.parse(event.created_at || "") >= cutoff)) return remember(true);
    if (events.length && events.every(event => Date.parse(event.created_at || "") < cutoff)) return remember(false);
    cursor = page.meta?.next_token;
    if (cursor && seen.has(cursor)) return false;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return remember(false);
}

export async function chatConversations(connection: SocialConnection, cursor?: string | null) {
  type Profile = { id: string; name?: string; username?: string };
  type Conversation = { id: string; updated_at?: string };
  const params = new URLSearchParams({ max_results: "10", "chat_conversation.fields": "id,updated_at,type", expansions: "participant_ids", "user.fields": "name,username" });
  if (cursor) params.set("pagination_token", cursor);
  const response = await chatRequest<{ data?: Conversation[]; includes?: { users?: Profile[] }; meta?: { next_token?: string } }>(connection, `chat/conversations?${params}`, undefined, true);
  const candidates = (response.data || []).flatMap(item => {
    try { return [{ ...item, participantId: participantForConversation(item.id, connection.platformAccountId) }]; }
    catch { return []; }
  });
  const direct: typeof candidates = [];
  // Bound concurrency; keep list pagination even when a page has no matches.
  for (let offset = 0; offset < candidates.length; offset += 2) {
    const batch = candidates.slice(offset, offset + 2);
    const eligible = await Promise.all(batch.map(async item => {
      if (item.updated_at && Date.parse(item.updated_at) < connection.connectedAt.getTime()) return false;
      return hasRecentXInbound(connection, item.participantId);
    }));
    direct.push(...batch.filter((_, index) => eligible[index]));
  }
  const profiles = new Map((response.includes?.users || []).map(user => [user.id, user]));
  const missing = [...new Set(direct.map(item => item.participantId))].filter(id => !profiles.get(id)?.username);
  if (missing.length) {
    try {
      const users = await chatRequest<{ data?: Profile[] }>(connection, `users?${new URLSearchParams({ ids: missing.join(","), "user.fields": "name,username" })}`, undefined, true);
      for (const user of users.data || []) profiles.set(user.id, user);
    } catch { /* Profile access must not prevent opening encrypted history. */ }
  }
  return {
    data: direct.map(item => ({ ...item, name: profiles.get(item.participantId)?.name || null, username: profiles.get(item.participantId)?.username || null })),
    meta: response.meta,
  };
}
