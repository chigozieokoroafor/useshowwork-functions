import type { ChatWithJuicebox, Event, SendPayload } from "@xdevplatform/chat-xdk";

/** Backup auth tokens are short-lived realm credentials, never the X OAuth token. */
export function realmToken(config: Record<string, unknown>, realm: string): string {
  const tokens = config.tokens as Record<string, unknown> | undefined;
  if (tokens && typeof tokens[realm] === "string") return tokens[realm] as string;
  const entries = config.token_map;
  if (Array.isArray(entries)) {
    const entry = entries.find(item => item?.key === realm);
    if (typeof entry?.value?.token === "string") return entry.value.token;
  }
  throw new Error("X did not provide authorization for this key-backup realm. Check access again.");
}
export function sendPayload(payload: SendPayload) {
  return { message_id: payload.messageId, encoded_message_create_event: payload.encryptedContent, encoded_message_event_signature: payload.encodedEventSignature };
}
export type DisplayMessage = { id: string; senderId: string; text: string; time: number };
export function verifiedMessages(events: Event[], accountId: string, participantId: string, connectedAt?: string): DisplayMessage[] {
  const cutoff = connectedAt === undefined ? 0 : Date.parse(connectedAt);
  return events.filter(event => Number.isFinite(cutoff) && (event.createdAtMsec || 0) >= cutoff && event.type === "message" && event.verified === true
    && event.id && event.senderId && [accountId, participantId].includes(event.senderId)
    && event.conversationId?.split(/[:-]/).length === 2
    && [accountId, participantId].every(id => event.conversationId!.split(/[:-]/).includes(id))
    && (event.content?.contentType ?? event.content?.content_type) === "text" && typeof event.content?.text === "string")
    .map(event => ({ id: event.id!, senderId: event.senderId!, text: event.content!.text!, time: event.createdAtMsec || 0 }));
}
export function releaseChat(chat: ChatWithJuicebox | null) {
  if (chat) { try { chat.lock(); } finally { chat.free(); } }
}

// Juicebox uses a global WASM auth callback. Do not recover two identities
// concurrently, including when multiple X accounts share one workspace.
let unlocking = false;
export async function withExclusiveUnlock<T>(operation: () => Promise<T>): Promise<T> {
  if (unlocking) throw new Error("Another X Chat account is unlocking. Wait before trying again.");
  unlocking = true;
  try { return await operation(); } finally { unlocking = false; }
}
