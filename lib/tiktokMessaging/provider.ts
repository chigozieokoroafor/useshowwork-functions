import type { SocialConnection } from "@prisma/client";
import type { IncomingMessage } from "@/lib/socialMessaging/ingest";
import { db } from "@/lib/db";
import { tikTokMessagingAccess, normalizeTikTokMessage, sendTikTokMessage } from "@/lib/socialMessaging/tiktok";
import { verifyTikTokMessagingSignature } from "@/lib/tiktokMessaging";

/** Compatibility facade for the native, separately authorized Business API. */
export interface TikTokMessagingProvider {
  access(connection: SocialConnection): Promise<{ available: boolean; reason: string }>;
  verifyNotification(rawBody: string, headers: Headers): Promise<boolean>;
  decodeNotification(payload: unknown): Promise<Array<{ businessAccountId: string; message: IncomingMessage }>>;
  connectionsForAccount(businessAccountId: string): Promise<SocialConnection[]>;
  send(connection: SocialConnection, input: { conversationId: string; recipientId: string; text: string }): Promise<{ messageId: string }>;
}
export const tikTokMessagingProvider: TikTokMessagingProvider = {
  async access(connection) { return tikTokMessagingAccess(connection); },
  async verifyNotification(raw, headers) { return verifyTikTokMessagingSignature(raw, headers.get("tiktok-signature")); },
  async decodeNotification(payload) {
    const event = payload as { client_key?: string; event?: string; user_openid?: string; content?: string };
    if (!event || event.client_key !== process.env.TIKTOK_BUSINESS_CLIENT_ID) throw new Error("Invalid TikTok Business app.");
    if (!["im_receive_msg", "im_send_msg"].includes(event.event || "")) return [];
    if (!event.user_openid || typeof event.content !== "string") throw new Error("Invalid TikTok notification.");
    const message = normalizeTikTokMessage(JSON.parse(event.content), event.user_openid);
    if (message.outbound !== (event.event === "im_send_msg")) throw new Error("Invalid TikTok notification direction.");
    return [{ businessAccountId: event.user_openid, message }];
  },
  async connectionsForAccount(businessAccountId) { return db.socialConnection.findMany({ where: { platform: "TIKTOK", status: "CONNECTED", tikTokMessagingBusinessId: businessAccountId } }); },
  async send(connection, input) { return { messageId: await sendTikTokMessage({ connection, ...input }) }; },
};
