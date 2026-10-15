import { canUseCalendarFeature } from "@/lib/calendarPermissions";
import type { SocialConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { canAccessCalendarById } from "@/lib/calendarPermissions";
import { ingestSocialMessage, type IncomingMessage } from "./ingest";
import { dispatchSocialInboxAutoReply } from "./dispatchAutoReply";
import { tikTokBusinessRequest, tikTokMessagingConfigured, tikTokMessagingTokens, TIKTOK_MESSAGING_SCOPES } from "@/lib/tiktokMessaging";

type MessagingAccess = Pick<SocialConnection, "status" | "tikTokMessagingBusinessId" | "tikTokMessagingScopes" | "tikTokMessagingConnectedAt" | "messagingWebhookSubscribedAt" | "messagingWebhookError">;
export function tikTokMessagingAccess(connection: MessagingAccess) {
  if (!tikTokMessagingConfigured()) return { available: false, reason: "TikTok Business Messaging app setup is required." };
  if (connection.status !== "CONNECTED") return { available: false, reason: "Reconnect TikTok before enabling messaging." };
  if (!connection.tikTokMessagingBusinessId || !connection.tikTokMessagingConnectedAt) return { available: false, reason: "Connect TikTok Business Messaging to enable DMs, DM leads and opt-in AI replies." };
  if (!TIKTOK_MESSAGING_SCOPES.every(scope => connection.tikTokMessagingScopes?.split(/[\s,]+/).includes(scope))) return { available: false, reason: "Reconnect Business Messaging and authorize all messaging permissions." };
  if (connection.messagingWebhookError || !connection.messagingWebhookSubscribedAt) return { available: false, reason: connection.messagingWebhookError || "Reconnect Business Messaging to enable incoming messages." };
  return { available: true, reason: "TikTok Business DMs, automatic DM lead capture and opt-in AI replies are enabled." };
}
export async function freshTikTokMessagingConnection(connection: SocialConnection) {
  const access = tikTokMessagingAccess(connection);
  if (!access.available) throw new Error(access.reason);
  if (!connection.tikTokMessagingAccessToken) throw new Error("Reconnect TikTok Business Messaging.");
  if (connection.tikTokMessagingTokenExpiresAt && connection.tikTokMessagingTokenExpiresAt.getTime() > Date.now() + 60_000) return connection;
  if (!connection.tikTokMessagingRefreshToken || !connection.tikTokMessagingRefreshExpiresAt || connection.tikTokMessagingRefreshExpiresAt.getTime() <= Date.now()) throw new Error("TikTok Business Messaging authorization expired. Reconnect messaging.");
  const tokens = await tikTokMessagingTokens({ refreshToken: connection.tikTokMessagingRefreshToken });
  if (tokens.open_id !== connection.tikTokMessagingBusinessId) throw new Error("TikTok Business Messaging account changed. Reconnect messaging.");
  await db.socialConnection.updateMany({ where: { id: connection.id, status: "CONNECTED", tikTokMessagingRefreshToken: connection.tikTokMessagingRefreshToken }, data: {
    tikTokMessagingAccessToken: tokens.access_token, tikTokMessagingRefreshToken: tokens.refresh_token,
    tikTokMessagingTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    tikTokMessagingRefreshExpiresAt: new Date(Date.now() + tokens.refresh_token_expires_in * 1000), tikTokMessagingScopes: tokens.scope,
  } });
  const updated = await db.socialConnection.findUniqueOrThrow({ where: { id: connection.id } });
  if (!tikTokMessagingAccess(updated).available || !updated.tikTokMessagingAccessToken) throw new Error("TikTok messaging was disconnected.");
  return updated;
}

type User = { id?: string; role?: string };
export type TikTokMessage = { conversation_id?: string; message_id?: string; timestamp?: number; message_type?: string; type?: string; text?: { body?: string }; from_user?: User; to_user?: User; sender?: string; recipient?: string; from?: string; to?: string; auto_message_type?: string; message_tag?: { source?: string } };
const bounded = (value: unknown, max = 512): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
export function normalizeTikTokMessage(message: TikTokMessage, businessId: string): IncomingMessage {
  if (!message || typeof message !== "object") throw new Error("Invalid TikTok message.");
  const sender = message.from_user;
  const receiver = message.to_user;
  const outbound = sender?.role?.toUpperCase() === "BUSINESS_ACCOUNT" && sender.id === businessId;
  const inbound = receiver?.role?.toUpperCase() === "BUSINESS_ACCOUNT" && receiver.id === businessId;
  const participant = outbound ? receiver : sender;
  const createdAt = new Date(message.timestamp ?? NaN);
  const type = (message.message_type || message.type || "").toUpperCase();
  if (outbound === inbound || participant?.role?.toUpperCase() !== "PERSONAL_ACCOUNT" || !bounded(participant.id)
    || !bounded(message.conversation_id) || !bounded(message.message_id) || !Number.isSafeInteger(message.timestamp)
    || !Number.isFinite(createdAt.getTime()) || createdAt.getTime() > Date.now() + 300_000 || !type) throw new Error("Invalid TikTok message identity or timestamp.");
  const text = type === "TEXT" ? message.text?.body : `[TikTok ${type.toLowerCase().replaceAll("_", " ")} message]`;
  if (!bounded(text, 20_000)) throw new Error("Invalid TikTok message content.");
  const username = outbound ? message.recipient || message.to : message.sender || message.from;
  return { conversationId: message.conversation_id, messageId: message.message_id, participantId: participant.id, text, createdAt, outbound,
    ...(bounded(username, 500) ? { username } : {}),
    autoReplyEligible: inbound && type === "TEXT" && !message.auto_message_type && !["API", "OTHERS"].includes(message.message_tag?.source || "") && Date.now() >= createdAt.getTime() && Date.now() - createdAt.getTime() < 600_000,
  };
}
export async function receiveTikTokMessage(payload: unknown) {
  const event = payload as { client_key?: string; event?: string; user_openid?: string; content?: string };
  if (!event || event.client_key !== process.env.TIKTOK_BUSINESS_CLIENT_ID) throw new Error("Invalid TikTok Business app.");
  if (!["im_receive_msg", "im_send_msg"].includes(event.event || "")) return { imported: 0 };
  if (!bounded(event.user_openid) || typeof event.content !== "string" || event.content.length > 100_000) throw new Error("Invalid TikTok notification.");
  const content = JSON.parse(event.content);
  if (content?.type === "reaction") return { imported: 0 };
  const message = normalizeTikTokMessage(content, event.user_openid);
  if (message.outbound !== (event.event === "im_send_msg")) throw new Error("Invalid TikTok notification direction.");
  const connections = await db.socialConnection.findMany({ where: { platform: "TIKTOK", status: "CONNECTED", tikTokMessagingBusinessId: event.user_openid } });
  let imported = 0;
  for (const connection of connections) {
    if (!tikTokMessagingAccess(connection).available || !connection.tikTokMessagingConnectedAt || message.createdAt < connection.tikTokMessagingConnectedAt || !(await canAccessCalendarById(connection.calendarId))) continue;
    // Outbound echoes may update existing history, but never create leads.
    if (message.outbound && !(await db.socialLeadConversation.findUnique({ where: { socialConnectionId_providerConversationId: { socialConnectionId: connection.id, providerConversationId: message.conversationId } }, select: { id: true } }))) continue;
    if (await ingestSocialMessage(connection, message)) {
      imported++;
      if (message.autoReplyEligible && (await db.socialInboxSettings.findUnique({ where: { calendarId: connection.calendarId }, select: { aiAutoReplyEnabled: true } }))?.aiAutoReplyEnabled) {
        const stored = await db.socialLeadMessage.findFirst({ where: { providerMessageId: message.messageId, conversation: { socialConnectionId: connection.id, providerConversationId: message.conversationId } }, select: { id: true } });
        if (stored) await dispatchSocialInboxAutoReply(stored.id);
      }
    }
  }
  return { imported };
}
export async function sendTikTokMessage(input: { connection: SocialConnection; conversationId?: string; recipientId: string; text: string }) {
  if (!(await canUseCalendarFeature(input.connection.calendarId, "socialInbox"))) throw new Error("Upgrade to Studio to use Social Inbox. Your existing data is preserved.");
  if (!tikTokMessagingConfigured()) throw new Error("TikTok Business Messaging requires approval and app credentials.");
  if (!input.conversationId || !input.text.trim() || input.text.length > 2000) throw new Error("Select a TikTok conversation and enter a reply of 1–2,000 characters.");
  if (!(await canAccessCalendarById(input.connection.calendarId))) throw new Error("This workspace is not active.");
  const conversation = await db.socialLeadConversation.findFirst({ where: { calendarId: input.connection.calendarId, socialConnectionId: input.connection.id, platform: "TIKTOK", providerConversationId: input.conversationId, participantPlatformId: input.recipientId }, include: { messages: { where: { direction: "INBOUND" }, orderBy: { platformCreatedAt: "desc" }, take: 1 } } });
  if (!conversation?.messages[0]) throw new Error("Reply to an existing inbound TikTok conversation.");
  if (Date.now() - conversation.messages[0].platformCreatedAt.getTime() >= 48 * 60 * 60_000) throw new Error("TikTok's 48-hour reply window has closed. Wait for another message from this user.");
  const connection = await freshTikTokMessagingConnection(input.connection);
  // TikTok enforces its ten-message quota on every send, including messages
  // sent from other clients. Never retry an ambiguous delivery automatically.
  const result = await tikTokBusinessRequest<{ message?: { message_id?: string } }>("/business/message/send/", { token: connection.tikTokMessagingAccessToken!, body: {
    business_id: connection.tikTokMessagingBusinessId, recipient_type: "CONVERSATION", recipient: input.conversationId, message_type: "TEXT", text: { body: input.text.trim() },
  } });
  if (!bounded(result.message?.message_id)) throw new Error("TikTok did not confirm delivery. Check the TikTok inbox before retrying.");
  return result.message.message_id;
}

/** Historical recovery is bounded by TikTok's 20-message API limit and never
 * enables AI replies. Live notifications deliver subsequent messages. */
export async function syncTikTokInbox(input: SocialConnection) {
  if (!(await canUseCalendarFeature(input.calendarId, "socialInbox"))) throw new Error("Upgrade to Studio to use Social Inbox. Your existing data is preserved.");
  if (!(await canAccessCalendarById(input.calendarId))) throw new Error("This workspace is not active.");
  const connection = await freshTikTokMessagingConnection(input);
  const started = Date.now();
  let imported = 0;
  let conversations = 0;
  const warnings: string[] = [];
  for (const type of ["STRANGER", "SINGLE"]) {
    const page = await tikTokBusinessRequest<{ conversations: { conversation_id: string }[]; has_more: boolean }>("/business/message/conversation/list/", {
      token: connection.tikTokMessagingAccessToken!, query: { business_id: connection.tikTokMessagingBusinessId!, conversation_type: type, limit: "10", cursor: "0" },
    });
    if (!Array.isArray(page.conversations) || page.conversations.length > 10) throw new Error("TikTok returned an invalid conversation list.");
    if (page.has_more) warnings.push(`More ${type.toLowerCase()} conversations are available in TikTok. Recovery imports the ten most recent.`);
    for (const item of page.conversations) {
      if (Date.now() - started > 30_000) { warnings.push("TikTok history recovery reached its time limit. Try syncing again."); break; }
      if (!bounded(item.conversation_id)) throw new Error("TikTok returned an invalid conversation ID.");
      const history = await tikTokBusinessRequest<{ messages: TikTokMessage[]; participants?: { id: string; display_name?: string }[] }>("/business/message/content/list/", {
        token: connection.tikTokMessagingAccessToken!, query: { business_id: connection.tikTokMessagingBusinessId!, conversation_id: item.conversation_id },
      });
      if (!Array.isArray(history.messages) || history.messages.length > 20) throw new Error("TikTok returned invalid message history.");
      const messages = history.messages.map(message => normalizeTikTokMessage(message, connection.tikTokMessagingBusinessId!)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (messages.some(message => message.conversationId !== item.conversation_id)) throw new Error("TikTok returned messages for a different conversation.");
      const inbound = messages.find(message => !message.outbound);
      if (!inbound) continue;
      conversations++;
      for (const message of messages) {
        const name = history.participants?.find(participant => participant.id === message.participantId)?.display_name;
        if (await ingestSocialMessage(connection, { ...message, ...(bounded(name, 500) ? { name } : {}), autoReplyEligible: false })) imported++;
      }
    }
  }
  await db.socialConnection.updateMany({ where: { id: connection.id, status: "CONNECTED", tikTokMessagingAccessToken: connection.tikTokMessagingAccessToken }, data: { messagingLastSyncAt: new Date(), messagingSyncError: warnings.join(" ") || null } });
  return { imported, conversations, warnings };
}
