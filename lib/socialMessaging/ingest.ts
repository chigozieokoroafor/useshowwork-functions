import type { SocialConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { socialStatusToPipeline } from "@/lib/calendarLeads";

export type IncomingMessage = { conversationId: string; messageId: string; participantId: string; name?: string; username?: string; text: string; createdAt: Date; outbound: boolean; autoReplyEligible?: boolean };
/** A duplicate provider delivery never increments unread counts or creates
 * another lead. Message + inbox + CRM writes commit together. */
export async function ingestSocialMessage(connection: SocialConnection, event: IncomingMessage) {
  return db.$transaction(async tx => {
    const conversation = await tx.socialLeadConversation.upsert({
      where: { socialConnectionId_providerConversationId: { socialConnectionId: connection.id, providerConversationId: event.conversationId } },
      create: { calendarId: connection.calendarId, socialConnectionId: connection.id, platform: connection.platform, providerConversationId: event.conversationId, participantPlatformId: event.participantId, participantName: event.name, participantUsername: event.username }, update: {},
    });
    const inserted = await tx.socialLeadMessage.createMany({ data: [{ conversationId: conversation.id, providerMessageId: event.messageId, direction: event.outbound ? "OUTBOUND" : "INBOUND", status: event.outbound ? "SENT" : "RECEIVED", text: event.text, platformCreatedAt: event.createdAt, autoReplyEligible: !event.outbound && !!event.autoReplyEligible }], skipDuplicates: true });
    if (!inserted.count) return false;
    if (!event.outbound) await tx.socialLeadConversation.update({ where: { id: conversation.id }, data: { unreadCount: { increment: 1 } } });
    await tx.socialLeadConversation.updateMany({ where: { id: conversation.id, OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: event.createdAt } }] }, data: { lastMessageAt: event.createdAt, lastMessagePreview: event.text.slice(0, 500), ...(event.name ? { participantName: event.name } : {}), ...(event.username ? { participantUsername: event.username } : {}) } });
    const phone = connection.platform === "WHATSAPP" ? `+${event.participantId}` : undefined;
    if (!event.outbound) await tx.calendarLead.upsert({ where: { socialConversationId: conversation.id }, create: { calendarId: connection.calendarId, socialConversationId: conversation.id, name: event.name || event.username || `${connection.platform} contact`, username: event.username, phone, status: socialStatusToPipeline(conversation.leadStatus), source: "SOCIAL" }, update: { ...(event.name ? { name: event.name } : {}), ...(event.username ? { username: event.username } : {}), ...(phone ? { phone } : {}) } });
    return true;
  });
}
