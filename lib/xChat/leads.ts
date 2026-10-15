import type { SocialConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { socialStatusToPipeline } from "@/lib/calendarLeads";
import { participantForConversation } from "./provider";

/** Persist public contact metadata only, never decrypted history or keys. */
export async function syncXChatLeads(connection: SocialConnection, conversations: { id: string; name: string | null; username: string | null; updated_at?: string }[]) {
  const result = [];
  for (const item of conversations) {
    const participantId = participantForConversation(item.id, connection.platformAccountId);
    const pair = [connection.platformAccountId, participantId].sort().join("-");
    const profile = { ...(item.name ? { participantName: item.name } : {}), ...(item.username ? { participantUsername: item.username } : {}) };
    const saved = await db.$transaction(async tx => {
      const conversation = await tx.socialLeadConversation.upsert({
        where: { socialConnectionId_providerConversationId: { socialConnectionId: connection.id, providerConversationId: `xchat:${pair}` } },
        create: { calendarId: connection.calendarId, socialConnectionId: connection.id, platform: "X", providerConversationId: `xchat:${pair}`, participantPlatformId: participantId, ...profile, lastMessagePreview: "Encrypted X conversation — unlock to read" },
        update: profile,
      });
      await tx.calendarLead.upsert({
        where: { socialConversationId: conversation.id },
        create: { calendarId: connection.calendarId, socialConversationId: conversation.id, name: item.name || item.username || "X contact", username: item.username, source: "SOCIAL", status: socialStatusToPipeline(conversation.leadStatus) },
        update: { ...(item.name ? { name: item.name } : {}), ...(item.username ? { username: item.username } : {}) },
      });
      return conversation;
    });
    result.push({ ...item, crmConversationId: saved.id, leadStatus: saved.leadStatus });
  }
  return result;
}
