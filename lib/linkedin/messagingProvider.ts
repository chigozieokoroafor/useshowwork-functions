import type { SocialConnection } from "@prisma/client";
import type { IncomingMessage } from "@/lib/socialMessaging/ingest";

/** Showwork's internal contract, NOT LinkedIn's wire format. Implement only
 * from the approved Page Messaging partner specification and recorded fixtures.
 * The implementation must never log tokens or message bodies. */
export interface LinkedInMessagingProvider {
  requiredScopes: readonly string[];
  decodeNotification(payload: unknown): Promise<Array<{ pageUrn: string; message: IncomingMessage }>>;
  subscribe(connection: SocialConnection, callbackUrl: string): Promise<void>;
  send(connection: SocialConnection, input: { conversationId: string; recipientId: string; text: string }): Promise<{ messageId: string }>;
}
// No public Page Messaging wire specification is available for this app yet.
// A production implementation must replace this binding after partner approval.
export const linkedInMessagingProvider: LinkedInMessagingProvider | null = null;
