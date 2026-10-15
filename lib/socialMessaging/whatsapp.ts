import { createHmac, timingSafeEqual } from "node:crypto";
import type { SocialConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { canAccessCalendarById } from "@/lib/calendarPermissions";
import { providerJson } from "@/lib/publishing/http";
import { ingestSocialMessage, type IncomingMessage } from "./ingest";
import { dispatchSocialInboxAutoReply } from "./dispatchAutoReply";

export const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60_000;
export function whatsappConfigured() {
  return Boolean(process.env.WHATSAPP_APP_ID && process.env.WHATSAPP_APP_SECRET && process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
}
type Access = Pick<SocialConnection, "status" | "whatsappBusinessAccountId" | "messagingWebhookSubscribedAt" | "messagingWebhookError"> & { accessTokenExpiresAt?: Date | null };
export function whatsappMessagingAccess(connection: Access) {
  if (!whatsappConfigured()) return { available: false, reason: "WhatsApp app and webhook setup is required." };
  if (connection.status !== "CONNECTED") return { available: false, reason: "Reconnect WhatsApp to reply." };
  if (connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() <= Date.now()) return { available: false, reason: "WhatsApp authorization expired. Update the access token in Channels." };
  if (!connection.whatsappBusinessAccountId || !connection.messagingWebhookSubscribedAt || connection.messagingWebhookError) {
    return { available: false, reason: connection.messagingWebhookError || "Connect WhatsApp Business to enable messaging." };
  }
  return { available: true, reason: "WhatsApp messaging, lead capture and opt-in AI replies enabled. Replies require a customer message within 24 hours." };
}
export function verifyWhatsAppSignature(raw: string, signature: string | null, secret = process.env.WHATSAPP_APP_SECRET) {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export function whatsappRequest<T>(path: string, token: string, body?: unknown) {
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  if (!/^v\d+\.0$/.test(version)) throw new Error("Invalid Meta Graph API version.");
  return providerJson<T>(`https://graph.facebook.com/${version}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
}
/** Validate app ownership, permissions and WABA membership before saving a token. */
export async function validateWhatsAppConnection(input: { businessAccountId: string; phoneNumberId: string; accessToken: string }) {
  if (!whatsappConfigured()) throw new Error("WhatsApp app and webhook setup is required on the server.");
  if (!validId(input.businessAccountId) || !validId(input.phoneNumberId) || !input.accessToken || input.accessToken.length > 4096
    || /\s/.test(input.accessToken)) throw new Error("Enter valid WhatsApp Business IDs and an access token.");
  const inspected = await whatsappRequest<{ data?: { is_valid?: boolean; app_id?: string; scopes?: string[]; expires_at?: number } }>(
    `debug_token?input_token=${encodeURIComponent(input.accessToken)}`, `${process.env.WHATSAPP_APP_ID}|${process.env.WHATSAPP_APP_SECRET}`);
  const token = inspected.data;
  if (!token?.is_valid || token.app_id !== process.env.WHATSAPP_APP_ID
    || !["whatsapp_business_management", "whatsapp_business_messaging"].every(scope => token.scopes?.includes(scope))
    || (token.expires_at && token.expires_at * 1000 <= Date.now() + 60_000)) throw new Error("Use a valid token from this WhatsApp app with business management and messaging permissions.");
  let member = false;
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const phones: { data?: Array<{ id: string }>; paging?: { next?: string; cursors?: { after?: string } } } = await whatsappRequest(
      `${input.businessAccountId}/phone_numbers?fields=id&limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`, input.accessToken);
    if (!Array.isArray(phones.data)) throw new Error("WhatsApp did not confirm the business account's phone numbers.");
    if (phones.data.some(phone => phone.id === input.phoneNumberId)) { member = true; break; }
    cursor = phones.paging?.next ? phones.paging.cursors?.after : undefined;
    if (!cursor) break;
  }
  if (!member) throw new Error("This phone number does not belong to the selected WhatsApp Business Account.");
  const phone = await whatsappRequest<{ id?: string; display_phone_number?: string; verified_name?: string; status?: string }>(
    `${input.phoneNumberId}?fields=id,display_phone_number,verified_name,status`, input.accessToken);
  if (phone.id !== input.phoneNumberId || !phone.display_phone_number || phone.status !== "CONNECTED") throw new Error("Register this business phone number with WhatsApp Cloud API before connecting it.");
  return { accountName: phone.verified_name || phone.display_phone_number, username: phone.display_phone_number,
    tokenScopes: token.scopes!.join(" "), accessTokenExpiresAt: token.expires_at ? new Date(token.expires_at * 1000) : null };
}
const validId = (value: unknown): value is string => typeof value === "string" && /^\d{5,30}$/.test(value);
export type WhatsAppMessage = {
  id?: string; from?: string; timestamp?: string; type?: string;
  text?: { body?: string }; button?: { text?: string };
  interactive?: { type?: string; button_reply?: { title?: string }; list_reply?: { title?: string } };
};
export function normalizeWhatsAppMessage(message: WhatsAppMessage, name?: string, now = Date.now()): IncomingMessage | null {
  if (!message || typeof message !== "object") throw new Error("Invalid WhatsApp message.");
  // Reactions and system notifications do not create leads or reopen a reply window.
  if (["reaction", "system"].includes(message.type || "")) return null;
  const createdAt = new Date(Number(message.timestamp) * 1000);
  if (!validId(message.from) || typeof message.id !== "string" || !message.id || message.id.length > 512
    || !/^\d{1,12}$/.test(message.timestamp || "") || !Number.isFinite(createdAt.getTime())
    || createdAt.getTime() > now + 300_000 || !/^[a-z_]{1,40}$/.test(message.type || "")) throw new Error("Invalid WhatsApp message identity or timestamp.");
  const text = message.type === "text" ? message.text?.body
    : message.type === "button" ? message.button?.text
    : message.type === "interactive" ? message.interactive?.button_reply?.title || message.interactive?.list_reply?.title
    : `[WhatsApp ${message.type} message — view in WhatsApp]`;
  if (typeof text !== "string" || !text.trim() || text.length > 20_000) throw new Error("Invalid WhatsApp message content.");
  return { conversationId: message.from, participantId: message.from, messageId: message.id, text, createdAt, outbound: false,
    username: `+${message.from}`, ...(typeof name === "string" && name.trim() && name.length <= 500 ? { name } : {}),
    autoReplyEligible: ["text", "button", "interactive"].includes(message.type!) && now - createdAt.getTime() < 600_000 && now >= createdAt.getTime() };
}

type WebhookValue = {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: WhatsAppMessage[];
  statuses?: Array<{ id?: string; recipient_id?: string; status?: string; errors?: Array<{ code?: number; title?: string; message?: string }> }>;
};
export async function receiveWhatsAppNotification(payload: unknown) {
  const event = payload as { object?: string; entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: WebhookValue }> }> };
  if (!event || event.object !== "whatsapp_business_account" || !Array.isArray(event.entry)) throw new Error("Invalid WhatsApp notification.");
  let imported = 0;
  for (const entry of event.entry) {
    if (!validId(entry.id) || !Array.isArray(entry.changes)) throw new Error("Invalid WhatsApp business account.");
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!value || !validId(value.metadata?.phone_number_id)) throw new Error("Invalid WhatsApp phone number.");
      if ((value.messages && !Array.isArray(value.messages)) || (value.statuses && !Array.isArray(value.statuses))
        || (value.contacts && !Array.isArray(value.contacts))) throw new Error("Invalid WhatsApp events.");
      const connections = await db.socialConnection.findMany({ where: { platform: "WHATSAPP", status: "CONNECTED",
        platformAccountId: value.metadata.phone_number_id, whatsappBusinessAccountId: entry.id } });
      for (const connection of connections) {
        if (!whatsappMessagingAccess(connection).available || !(await canAccessCalendarById(connection.calendarId))) continue;
        for (const item of value.messages || []) {
          const message = normalizeWhatsAppMessage(item, value.contacts?.find(contact => contact.wa_id === item.from)?.profile?.name);
          if (!message || message.createdAt < connection.connectedAt) continue;
          // Only messages received while AI is enabled enter the AI queue.
          const settings = await db.socialInboxSettings.findUnique({ where: { calendarId: connection.calendarId }, select: { aiAutoReplyEnabled: true } });
          message.autoReplyEligible = !!message.autoReplyEligible && !!settings?.aiAutoReplyEnabled;
          if (await ingestSocialMessage(connection, message)) imported++;
          // Dispatch duplicates too: this recovers a failed dispatch after a committed ingest.
          const stored = message.autoReplyEligible ? await db.socialLeadMessage.findFirst({ where: { providerMessageId: message.messageId,
            autoReplyEligible: true, autoReplyHandledAt: null, conversation: { socialConnectionId: connection.id } }, select: { id: true } }) : null;
          if (stored) await dispatchSocialInboxAutoReply(stored.id);
        }
        for (const status of value.statuses || []) {
          if (typeof status.id !== "string" || !validId(status.recipient_id)) continue;
          const next = status.status === "read" ? "READ" : status.status === "delivered" ? "DELIVERED" : status.status === "failed" ? "FAILED" : null;
          if (!next) continue;
          await db.socialLeadMessage.updateMany({ where: { providerMessageId: status.id, direction: "OUTBOUND",
            status: { in: next === "READ" ? ["SENT", "DELIVERED"] : ["SENT"] },
            conversation: { socialConnectionId: connection.id, participantPlatformId: status.recipient_id } },
            data: { status: next, ...(next === "FAILED" ? { sendError: `WhatsApp could not deliver this reply (${status.errors?.[0]?.code ?? "unknown"}). Check the business inbox before retrying.` } : {}) } });
        }
      }
    }
  }
  return { imported };
}

export async function sendWhatsAppMessage(input: { connection: SocialConnection; conversationId?: string; recipientId: string; text: string }) {
  const access = whatsappMessagingAccess(input.connection);
  if (!access.available) throw new Error(access.reason);
  if (!validId(input.recipientId) || !input.conversationId || !input.text.trim() || input.text.length > 2000) throw new Error("Select a WhatsApp conversation and enter a reply of 1–2,000 characters.");
  if (!(await canAccessCalendarById(input.connection.calendarId))) throw new Error("This workspace is not active.");
  const conversation = await db.socialLeadConversation.findFirst({ where: { calendarId: input.connection.calendarId,
    socialConnectionId: input.connection.id, platform: "WHATSAPP", providerConversationId: input.conversationId, participantPlatformId: input.recipientId },
    include: { messages: { where: { direction: "INBOUND" }, orderBy: { platformCreatedAt: "desc" }, take: 1 } } });
  const inbound = conversation?.messages[0];
  if (!inbound) throw new Error("Reply to an existing inbound WhatsApp conversation.");
  const age = Date.now() - inbound.platformCreatedAt.getTime();
  if (age < 0 || age >= WHATSAPP_REPLY_WINDOW_MS) throw new Error("WhatsApp's 24-hour reply window has closed. Wait for a new customer message.");
  // Re-read credentials so a disconnect or token replacement immediately takes effect.
  const connection = await db.socialConnection.findUniqueOrThrow({ where: { id: input.connection.id } });
  if (!whatsappMessagingAccess(connection).available || !connection.accessToken) throw new Error("Reconnect WhatsApp before replying.");
  if (connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() <= Date.now()) throw new Error("WhatsApp authorization expired. Update the access token in Channels.");
  try {
    const result = await whatsappRequest<{ messages?: Array<{ id?: string }> }>(`${connection.platformAccountId}/messages`, connection.accessToken,
      { messaging_product: "whatsapp", recipient_type: "individual", to: input.recipientId, type: "text", text: { preview_url: false, body: input.text.trim() } });
    const id = result.messages?.[0]?.id;
    if (!id || typeof id !== "string") throw new Error("WhatsApp did not confirm the reply. Check the business inbox before retrying.");
    return id;
  } catch (error) {
    const failure = error as { status?: number; providerCode?: number };
    if (failure.status === 401 || failure.providerCode === 190) await db.socialConnection.updateMany({ where: { id: connection.id, accessToken: connection.accessToken, status: "CONNECTED" }, data: { status: "NEEDS_REAUTH", messagingWebhookError: "WhatsApp authorization expired. Update the access token in Channels." } });
    throw error;
  }
}

export async function whatsappAutoReplyHandoff(message: { id: string; conversationId: string; platformCreatedAt: Date }) {
  if (Date.now() - message.platformCreatedAt.getTime() >= WHATSAPP_REPLY_WINDOW_MS) return "WhatsApp's reply window closed before an automatic reply could be sent.";
  const latest = await db.socialLeadMessage.findFirst({ where: { conversationId: message.conversationId,
    OR: [{ direction: "INBOUND" }, { direction: "OUTBOUND", status: { in: ["PENDING", "SENT", "DELIVERED", "READ"] } }] },
    orderBy: [{ platformCreatedAt: "desc" }, { createdAt: "desc" }], select: { id: true, direction: true } });
  if (latest?.id !== message.id) return latest?.direction === "OUTBOUND"
    ? "This WhatsApp conversation already received a reply."
    : "A newer WhatsApp message superseded this automatic reply.";
  return null;
}
