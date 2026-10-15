import { sendTikTokMessage } from "./tiktok";
import { tikTokMessagingConfigured } from "@/lib/tiktokMessaging";
import { sendLinkedInMessage } from "./linkedin";
import { linkedInMessagingConfigured } from "@/lib/linkedin/messagingAccess";
import type { SocialConnection } from "@prisma/client";
import { freshConnection, requireScopes } from "@/lib/socialTokens";
import { providerJson } from "@/lib/publishing/http";
import { sendMetaInboxMessage } from "./meta";
import { sendWhatsAppMessage, whatsappConfigured } from "./whatsapp";

export function supportsMessaging(platform: string) { return ["FACEBOOK", "INSTAGRAM", "X"].includes(platform) || (platform === "WHATSAPP" && whatsappConfigured()) || (platform === "TIKTOK" && tikTokMessagingConfigured()) || (platform === "LINKEDIN" && linkedInMessagingConfigured()); }
export async function sendSocialInboxMessage(input: { connection: SocialConnection; instagramPageId?: string | null; recipientId: string; conversationId?: string; text: string }) {
  if (input.connection.status !== "CONNECTED") throw new Error("Reconnect this account before replying.");
  if (input.connection.platform === "WHATSAPP") return sendWhatsAppMessage(input);
  if (["FACEBOOK", "INSTAGRAM"].includes(input.connection.platform)) return sendMetaInboxMessage(input);
  if (input.connection.platform === "TIKTOK") return sendTikTokMessage(input);
  if (input.connection.platform === "LINKEDIN") return sendLinkedInMessage(input);
  if (input.connection.platform !== "X") throw new Error("Messaging requires additional platform approval and an enabled adapter for this channel.");
  const connection = await freshConnection(input.connection);
  requireScopes(connection, ["dm.write"]);
  const response = await providerJson<{ data?: { dm_event_id?: string } }>(`https://api.x.com/2/dm_conversations/with/${encodeURIComponent(input.recipientId)}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: input.text }),
  });
  if (!response.data?.dm_event_id) throw new Error("X did not confirm the sent message. Check the conversation before trying again.");
  return response.data.dm_event_id;
}
