import type { SocialConnection } from "@prisma/client";
import { linkedInMessagingProvider } from "./messagingProvider";
export function linkedInMessagingConfigured() {
  return process.env.LINKEDIN_MESSAGING_ENABLED === "true" && !!linkedInMessagingProvider;
}
export function linkedInMessagingAccess(connection: Pick<SocialConnection, "platformAccountId" | "status" | "tokenScopes" | "messagingWebhookSubscribedAt" | "messagingWebhookError">) {
  if (!linkedInMessagingConfigured()) return { available: false, reason: "LinkedIn Page Messaging is awaiting partner approval and the approved API adapter." };
  if (connection.status !== "CONNECTED") return { available: false, reason: "Reconnect LinkedIn to enable messaging." };
  if (!/^urn:li:organization:\d+$/.test(connection.platformAccountId)) return { available: false, reason: "Select a company Page for LinkedIn messaging. Personal inboxes are not supported." };
  const scopes = new Set((connection.tokenScopes || "").split(/[\s,]+/));
  if (linkedInMessagingProvider!.requiredScopes.some(scope => !scopes.has(scope))) return { available: false, reason: "Reconnect LinkedIn and grant the approved Page Messaging permissions." };
  if (!connection.messagingWebhookSubscribedAt || connection.messagingWebhookError) return { available: false, reason: "Set up the LinkedIn Page messaging subscription in Channels." };
  return { available: true, reason: "LinkedIn Page messaging and automatic inbound lead capture are enabled." };
}
