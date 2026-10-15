import { canUseCalendarFeature } from "@/lib/calendarPermissions";
import type { SocialConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { canAccessCalendarById } from "@/lib/calendarPermissions";
import { freshConnection, requireScopes } from "@/lib/socialTokens";
import { providerJson } from "@/lib/publishing/http";
import { ingestSocialMessage } from "./ingest";

export type XMessageEvent = {
  id: string;
  text?: string;
  created_at: string;
  sender_id: string;
  participant_ids?: string[];
  dm_conversation_id: string;
  event_type?: string;
  attachments?: { media_keys?: string[] };
};
type XEventsResponse = {
  data?: XMessageEvent[];
  includes?: { users?: { id: string; name?: string; username?: string }[] };
  meta?: { next_token?: string; result_count?: number };
  errors?: { detail?: string; title?: string }[];
};
export type XInboxSyncOptions = {
  /** Manual recovery ignores an older watermark that may have skipped messages. */
  fullHistory?: boolean;
  participantUsername?: string;
  maxPages?: number;
  pageSize?: number;
};
export type XInboxSyncResult = {
  received: number;
  imported: number;
  skipped: number;
  complete: boolean;
  warning: string | null;
};

/** MessageCreate does not guarantee participant_ids. For a one-to-one
 * conversation use its pair ID, even when participant_ids is empty. Keep
 * sender + recipient IDs as strings: X IDs exceed JS integer precision. */
export function xMessageParticipant(event: XMessageEvent, accountId: string): string | null {
  if (event.event_type && event.event_type !== "MessageCreate") return null;
  if (!event.sender_id || !event.dm_conversation_id) return null;
  const listed = (event.participant_ids ?? []).filter(Boolean);
  if (new Set(listed).size > 2) return null;
  const pair = event.dm_conversation_id.split("-");
  const candidates = pair.length === 2 && pair.every(Boolean)
    ? [...new Set(pair)]
    : [...new Set([...listed, event.sender_id])];
  if (candidates.length !== 2 || !candidates.includes(accountId) || !candidates.includes(event.sender_id)) return null;
  // Do not accept a conflicting participant list as a one-to-one thread.
  if (listed.some(id => !candidates.includes(id))) return null;
  return candidates.find(id => id !== accountId) ?? null;
}

export async function syncXInbox(stored: SocialConnection, options: XInboxSyncOptions = {}): Promise<XInboxSyncResult> {
  if (!(await canAccessCalendarById(stored.calendarId))) throw new Error("This workspace is not active.");
  if (!(await canUseCalendarFeature(stored.calendarId, "socialInbox"))) throw new Error("Upgrade to Studio to use Social Inbox. Your existing data is preserved.");
  const connection = await freshConnection(stored);
  requireScopes(connection, ["dm.read", "tweet.read", "users.read"]);
  const username = options.participantUsername?.trim().replace(/^@/, "");
  let participant: { id: string; username?: string; name?: string } | undefined;
  if (username) {
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error("Enter a valid X sender username.");
    const lookup = await providerJson<{ data?: typeof participant }>(`https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`, {
      headers: { Authorization: `Bearer ${connection.accessToken}` }, signal: AbortSignal.timeout(10_000),
    });
    participant = lookup.data;
    if (!participant?.id) throw new Error(`X could not find @${username}.`);
    if (participant.id === connection.platformAccountId) throw new Error("Enter the other person's username, not the connected account.");
  }
  const eventsUrl = participant
    ? `https://api.x.com/2/dm_conversations/with/${encodeURIComponent(participant.id)}/dm_events`
    : "https://api.x.com/2/dm_events";
  const settings = await db.socialInboxSettings.findUnique({ where: { calendarId: connection.calendarId } });
  const startedAt = new Date();
  const result: XInboxSyncResult = { received: 0, imported: 0, skipped: 0, complete: false, warning: null };
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 10, 10));
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 100, 100));
  const warnings: string[] = [];
  let partialResponse = false;
  let next: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({
      max_results: String(pageSize),
      "dm_event.fields": "id,text,event_type,created_at,sender_id,participant_ids,dm_conversation_id,attachments",
      event_types: "MessageCreate",
      expansions: "sender_id,participant_ids",
      "user.fields": "name,username",
      ...(next ? { pagination_token: next } : {}),
    });
    const response = await providerJson<XEventsResponse>(`${eventsUrl}?${query}`, {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.data !== undefined && !Array.isArray(response.data)) throw new Error("X returned an invalid message list. The last successful sync was preserved.");
    if (!response.data && response.meta?.result_count !== 0) {
      throw new Error("X returned an unexpected response without a message list or zero result count. Sync was not marked successful.");
    }
    const events = response.data ?? [];
    if (!events.length && response.errors?.length) {
      throw new Error("X returned no messages with an API error: " + (response.errors[0].detail || response.errors[0].title || "Unknown provider error"));
    }
    result.received += events.length;
    if (response.errors?.length) {
      partialResponse = true;
      warnings.push("X returned partial results; some messages or profiles may be unavailable.");
    }
    // Sort within each page before ingestion. The ingest layer independently
    // guards the preview timestamp across older pages and overlapping syncs.
    for (const event of [...events].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
      const createdAt = new Date(event.created_at);
      const participantId = xMessageParticipant(event, connection.platformAccountId);
      if (participant && participantId !== participant.id) { result.skipped++; continue; }
      if (!event.id || !participantId || !Number.isFinite(createdAt.getTime())) { result.skipped++; continue; }
      if (createdAt < connection.connectedAt) { result.skipped++; continue; }
      const text = event.text?.trim() || (event.attachments?.media_keys?.length ? "[Media attachment]" : "");
      if (!text) { result.skipped++; continue; }
      const profile = response.includes?.users?.find(user => user.id === participantId) ?? participant;
      const age = startedAt.getTime() - createdAt.getTime();
      const inserted = await ingestSocialMessage(connection, {
        conversationId: event.dm_conversation_id,
        messageId: event.id,
        participantId,
        name: profile?.name,
        username: profile?.username,
        text,
        createdAt,
        outbound: event.sender_id === connection.platformAccountId,
        // Manual recovery and initial history imports must never send replies.
        autoReplyEligible: !options.fullHistory && !participant && !!settings?.aiAutoReplyEnabled && !!stored.messagingLastSyncAt
          && createdAt > stored.messagingLastSyncAt && age >= 0 && age < 10 * 60_000 && !!event.text?.trim(),
      });
      if (inserted) result.imported++;
    }
    next = response.meta?.next_token;
    // Compare every page's timestamps, not just one out-of-order old event.
    // Keep a small overlap so delayed provider delivery isn't lost.
    const watermark = stored.messagingLastSyncAt?.getTime();
    const passedWatermark = !options.fullHistory && !participant && watermark && events.length > 0
      && events.every(event => Date.parse(event.created_at) < watermark - 5 * 60_000);
    if (!next || passedWatermark) { result.complete = true; break; }
  }
  if (options.fullHistory && result.received === 0) {
    // Verify the token's actual owner, rather than trusting the saved card label.
    const identity = await providerJson<{ data?: { id: string; username?: string } }>("https://api.x.com/2/users/me", {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!identity.data?.id) throw new Error("X did not confirm the account associated with this token. Refresh permissions in Channels.");
    if (identity.data.id !== connection.platformAccountId) throw new Error("The X token belongs to a different account than this connection. Reconnect the intended account in Channels.");
    warnings.push(`X confirmed ${identity.data.username ? "@" + identity.data.username : "the connected account"}, but ${participant ? "the conversation endpoint for @" + username : "its DM endpoint"} returned zero events. A recent message is not reaching this API; the history window alone does not explain missing recent DMs.`);
  }
  if (!result.complete) warnings.push(`Checked the newest ${result.received} events. More history remains; the scheduled sync can fetch a larger batch.`);
  if (result.skipped) warnings.push(`${result.skipped} group, incomplete, or unsupported events were skipped.`);
  result.warning = [...new Set(warnings)].join(" ") || null;
  // Partial or truncated results must not hide unfetched history behind a newer
  // watermark. A manual recovery may repair a previously empty inbox.
  await db.socialConnection.updateMany({
    where: { id: connection.id, status: "CONNECTED" },
    data: {
      ...(result.complete && !partialResponse && !participant ? { messagingLastSyncAt: startedAt } : {}),
      messagingSyncError: result.warning,
    },
  });
  return result;
}


export async function syncSocialInboxes(calendarId?: string, options: XInboxSyncOptions = {}) {
  const connections = await db.socialConnection.findMany({
    // Missing scopes are an actionable error, not an invisible skipped account.
    where: { platform: "X", status: "CONNECTED", ...(calendarId ? { calendarId } : {}) },
    orderBy: { updatedAt: "asc" }, take: 20,
  });
  const summary = { checked: connections.length, synced: 0, received: 0, imported: 0, skipped: 0, warnings: [] as string[], errors: [] as string[] };
  for (const connection of connections) {
    try {
      const result = await syncXInbox(connection, options);
      summary.synced++;
      summary.received += result.received;
      summary.imported += result.imported;
      summary.skipped += result.skipped;
      if (result.warning) summary.warnings.push(result.warning);
    } catch (error) {
      const message = xInboxErrorMessage(error);
      summary.errors.push(message);
      await db.socialConnection.updateMany({ where: { id: connection.id, status: "CONNECTED" }, data: { messagingSyncError: message } });
    }
  }
  return summary;
}

export function xInboxErrorMessage(error: unknown): string {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  if (status === 401) return "X rejected the access token. Refresh permissions in Channels to reconnect the account.";
  if (status === 402) return "X API credits or billing are required to read DMs. Check the app's X developer account.";
  if (status === 403) return "X denied DM access. Check the app's DM API access, then reconnect with dm.read, tweet.read and users.read permissions.";
  if (status === 429) return "X rate-limited message retrieval. Wait before syncing again; saved messages are unchanged.";
  return error instanceof Error ? error.message : "X inbox sync failed.";
}
