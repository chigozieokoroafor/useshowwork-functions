import type { SocialConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { canAccessCalendarById } from "@/lib/calendarPermissions";
import { freshConnection } from "@/lib/socialTokens";
import { linkedInMessagingProvider } from "@/lib/linkedin/messagingProvider";
import { linkedInMessagingAccess, linkedInMessagingConfigured } from "@/lib/linkedin/messagingAccess";
import { ingestSocialMessage, type IncomingMessage } from "./ingest";

export function validateLinkedInMessage(event: IncomingMessage) {
  const bounded = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
  if (!event || !bounded(event.conversationId, 512) || !bounded(event.messageId, 512) || !bounded(event.participantId, 512)
    || !bounded(event.text, 20_000) || typeof event.outbound !== "boolean"
    || !(event.createdAt instanceof Date) || !Number.isFinite(event.createdAt.getTime())
    || event.createdAt.getTime() > Date.now() + 5 * 60_000
    || (event.name !== undefined && !bounded(event.name, 500)) || (event.username !== undefined && !bounded(event.username, 500))) throw new Error("Invalid normalized LinkedIn message.");
}
export async function receiveLinkedInMessages(payload: unknown) {
  if (!linkedInMessagingConfigured()) throw new Error("LinkedIn messaging adapter is not enabled.");
  const events = await linkedInMessagingProvider!.decodeNotification(payload);
  if (!Array.isArray(events) || events.length > 100) throw new Error("Invalid LinkedIn event batch.");
  // Validate the whole batch before writes; on transient DB failure, provider
  // retries are safe because ingest deduplicates stable provider message IDs.
  for (const event of events) {
    if (!/^urn:li:organization:\d+$/.test(event.pageUrn)) throw new Error("Invalid LinkedIn Page identifier.");
    validateLinkedInMessage(event.message);
    if (event.message.participantId === event.pageUrn) throw new Error("LinkedIn message participant must be another user.");
  }
  let imported = 0;
  for (const { pageUrn, message } of events) {
    const connections = await db.socialConnection.findMany({ where: { platform: "LINKEDIN", platformAccountId: pageUrn, status: "CONNECTED" } });
    for (const connection of connections) {
      if (!linkedInMessagingAccess(connection).available || !(await canAccessCalendarById(connection.calendarId)) || message.createdAt < connection.connectedAt) continue;
      if (message.outbound && !(await db.socialLeadConversation.findUnique({ where: { socialConnectionId_providerConversationId: { socialConnectionId: connection.id, providerConversationId: message.conversationId } }, select: { id: true } }))) continue;
      if (await ingestSocialMessage(connection, { ...message, autoReplyEligible: false })) imported++;
    }
  }
  return { imported };
}
export async function sendLinkedInMessage(input: { connection: SocialConnection; conversationId?: string; recipientId: string; text: string }) {
  const access = linkedInMessagingAccess(input.connection);
  if (!access.available) throw new Error(access.reason);
  if (!input.conversationId || !input.text.trim() || input.text.length > 2000) throw new Error("Select a LinkedIn conversation and enter a reply of 1–2,000 characters.");
  if (!(await canAccessCalendarById(input.connection.calendarId))) throw new Error("This workspace is not active.");
  const conversation = await db.socialLeadConversation.findFirst({ where: { socialConnectionId: input.connection.id, calendarId: input.connection.calendarId, platform: "LINKEDIN", providerConversationId: input.conversationId, participantPlatformId: input.recipientId } });
  if (!conversation) throw new Error("LinkedIn conversation does not belong to this Page connection.");
  const connection = await freshConnection(input.connection);
  if (!linkedInMessagingAccess(connection).available) throw new Error("LinkedIn messaging permissions changed. Reconnect this Page.");
  const result = await linkedInMessagingProvider!.send(connection, { conversationId: input.conversationId, recipientId: input.recipientId, text: input.text.trim() });
  if (typeof result?.messageId !== "string" || !result.messageId.trim() || result.messageId.length > 512) throw new Error("LinkedIn did not confirm delivery. Check the Page inbox before retrying.");
  return result.messageId;
}
