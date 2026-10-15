export type UnifiedInboxMessage = { id: string; direction: "INBOUND" | "OUTBOUND"; status: string; text: string; platformCreatedAt: string; isAiGenerated: boolean; sendError?: string | null; autoReplyHandoffReason?: string | null };
export type UnifiedInboxConversation = {
  id: string; platform: string; participantPlatformId: string; participantName: string | null; participantUsername: string | null;
  leadStatus: string; unreadCount: number; lastMessageAt: string | null; lastMessagePreview: string | null;
  connection: { id?: string; accountName: string | null; username: string | null; status: string } | null;
  messages: UnifiedInboxMessage[];
  replyWindowExpiresAt?: string | null;
  encrypted?: { connectionId: string; conversationId: string };
};
export function mergeInboxConversations(saved: UnifiedInboxConversation[], encrypted: UnifiedInboxConversation[], filters: { platform: string; status: string; search: string; unreadOnly: boolean }) {
  const query = filters.search.trim().toLowerCase();
  const savedById = new Map(saved.map(item => [item.id, item]));
  const encryptedIds = new Set(encrypted.map(item => item.id));
  const combined = [...saved.filter(item => !encryptedIds.has(item.id)), ...encrypted.map(item => ({ ...item, leadStatus: savedById.get(item.id)?.leadStatus || item.leadStatus }))];
  return combined.filter(item =>
    (!filters.platform || item.platform === filters.platform)
    && (!filters.status || item.leadStatus === filters.status)
    && (!filters.unreadOnly || item.unreadCount > 0)
    && (!query || [item.participantName, item.participantUsername, item.lastMessagePreview, ...item.messages.map(message => message.text)].some(value => value?.toLowerCase().includes(query))))
    .sort((a, b) => (Date.parse(b.lastMessageAt || "") || 0) - (Date.parse(a.lastMessageAt || "") || 0));
}

/** Keep a saved thread open while filters change, but never retain an unlocked X thread after it disappears. */
export function resolveSelectedInboxConversation(conversations: UnifiedInboxConversation[], selectedId: string, previous: UnifiedInboxConversation | null) {
  return conversations.find(item => item.id === selectedId)
    ?? (previous?.id === selectedId && !previous.encrypted ? previous : null);
}
