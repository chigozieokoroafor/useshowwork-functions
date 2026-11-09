import { createHash } from "node:crypto";
import { db } from "../../lib/db";

export const UNCONFIRMED_REPLY = "Unconfirmed—check the platform inbox before retrying. This reply will not be sent again automatically.";
export class InboxSendConflict extends Error {}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function findInboxSend(conversationId: string, operationKey: string) {
  return (db as any).socialInboxOutbound.findUnique({ where: { id: digest(JSON.stringify([conversationId, operationKey])) } });
}

/** A crashed/expired send is ambiguous, never a retryable failed send. */
export async function reconcileStaleInboxSends(calendarId: string) {
  const cutoff = new Date(Date.now() - 2 * 60_000);
  const convs = await (db as any).socialLeadConversation.findMany({
    where: { calendarId },
    select: { id: true },
  });
  if (!convs || convs.length === 0) return;
  const conversationIds = convs.map((c: any) => c.id);
  const stale = await (db as any).socialInboxOutbound.findMany({
    where: {
      conversationId: { in: conversationIds },
      OR: [
        { state: "SENDING", startedAt: { lt: cutoff } },
        { state: "PENDING", createdAt: { lt: cutoff } },
      ],
    },
    take: 100,
  });
  for (const operation of stale) await db.$transaction(async tx => {
    const claimed = await (tx as any).socialInboxOutbound.updateMany({ where: { id: operation.id, state: operation.state }, data: { state: operation.state === "PENDING" ? "CANCELLED" : "UNCONFIRMED" } });
    if (claimed.count) await tx.socialLeadMessage.updateMany({ where: { id: operation.messageId, status: "PENDING" }, data: { status: "FAILED", sendError: operation.state === "PENDING" ? "Reply cancelled before any provider send attempt. You can write a new reply." : UNCONFIRMED_REPLY } });
  });
}

/** Persist before external IO. Provider IO is NEVER inside a retried transaction. */
export async function sendDurableInboxReply(input: {
  conversationId: string; operationKey: string; text: string; actorId?: string;
  isAiGenerated?: boolean; takeover?: boolean; handoffOffer?: boolean; expectedControlVersion?: number;
  beforeSend?: () => Promise<boolean>;
  send: () => Promise<string | null | undefined>;
}) {
  if (!input.operationKey || input.operationKey.length > 200) throw new InboxSendConflict("A valid send operation ID is required.");
  const id = digest(JSON.stringify([input.conversationId, input.operationKey]));
  const requestHash = digest(JSON.stringify([input.text, input.actorId || null, !!input.isAiGenerated, !!input.handoffOffer]));
  const messageId = `inbox-${id}`;
  let operation;
  // Serializable admission prevents a second intent slipping past an unresolved send.
  for (let attempt = 0; ; attempt++) {
    try {
      operation = await db.$transaction(async tx => {
        const existing = await (tx as any).socialInboxOutbound.findUnique({ where: { id } });
        if (existing) {
          if (existing.requestHash !== requestHash) throw new InboxSendConflict("This operation ID was already used for a different reply.");
          return existing;
        }
        const unresolved = await (tx as any).socialInboxOutbound.findFirst({ where: { conversationId: input.conversationId, OR: [{ state: { in: ["PENDING", "SENDING"] } }, { state: "UNCONFIRMED", reviewedAt: null }] } });
        if (unresolved) throw new InboxSendConflict(unresolved.state === "UNCONFIRMED" ? UNCONFIRMED_REPLY : "A reply is already being sent. Wait for its delivery status before sending another.");
        const now = new Date();
        const created = await (tx as any).socialInboxOutbound.create({ data: { id, conversationId: input.conversationId, messageId, requestHash, handoffOffer: !!input.handoffOffer } });
        await tx.socialLeadMessage.create({ data: { id: messageId, conversationId: input.conversationId, direction: "OUTBOUND", status: "PENDING", text: input.text, platformCreatedAt: now, sentByCreatorId: input.actorId, isAiGenerated: !!input.isAiGenerated } });
        if (input.takeover) await tx.socialLeadConversation.update({ where: { id: input.conversationId }, data: { aiPausedAt: now, aiHandoffOfferedAt: null, aiHandoffOfferMessageId: null, aiHandoffReason: "A team member replied. AI stays paused until explicitly resumed.", aiHandoffAcknowledgedAt: now, aiControlVersion: { increment: 1 } } });
        return created;
      }, { isolationLevel: "Serializable" });
      break;
    } catch (error) {
      if (attempt < 2 && ["P2034", "P2002"].includes((error as {code?: string}).code || "")) continue;
      throw error;
    }
  }
  if (operation.state !== "PENDING") return operation;
  const claim = await (db as any).socialInboxOutbound.updateMany({ where: { id, state: "PENDING" }, data: { state: "SENDING", startedAt: new Date() } });
  if (!claim.count) return (db as any).socialInboxOutbound.findUniqueOrThrow({ where: { id } });
  let attempted = false;
  try {
    if (input.beforeSend && !await input.beforeSend()) {
      await db.$transaction(async tx => {
        await (tx as any).socialInboxOutbound.update({ where: { id }, data: { state: "CANCELLED", completedAt: new Date() } });
        await tx.socialLeadMessage.update({ where: { id: messageId }, data: { status: "FAILED", sendError: "Reply cancelled because this conversation changed before delivery." } });
      });
      return (db as any).socialInboxOutbound.findUniqueOrThrow({ where: { id } });
    }
    attempted = true;
    const providerMessageId = await input.send();
    if (!providerMessageId) throw Error("Provider did not confirm a message ID.");
    await db.$transaction(async tx => {
      // An echo may arrive before this transaction. Keep its provider identity once.
      const echo = await tx.socialLeadMessage.findFirst({ where: { conversationId: input.conversationId, providerMessageId } });
      const savedId = echo && echo.id !== messageId ? echo.id : messageId;
      if (savedId !== messageId) await tx.socialLeadMessage.deleteMany({ where: { id: messageId, status: { in: ["PENDING", "FAILED"] } } });
      await tx.socialLeadMessage.update({ where: { id: savedId }, data: { providerMessageId, status: echo && ["DELIVERED", "READ"].includes(echo.status) ? echo.status : "SENT", sentByCreatorId: input.actorId, isAiGenerated: !!input.isAiGenerated, sendError: null } });
      await (tx as any).socialInboxOutbound.update({ where: { id }, data: { state: "SENT", providerMessageId, messageId: savedId, completedAt: new Date() } });
      if (input.handoffOffer) await tx.socialLeadConversation.updateMany({ where: { id: input.conversationId, aiPausedAt: null, ...(input.expectedControlVersion === undefined ? {} : {aiControlVersion:input.expectedControlVersion}) }, data: { aiHandoffOfferedAt: new Date(), aiHandoffOfferMessageId: savedId } });
      // Do not erase a newer inbound preview or unread count that arrived mid-send.
      await tx.socialLeadConversation.updateMany({ where: { id: input.conversationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: operation.createdAt } }] }, data: { lastMessageAt: operation.createdAt, lastMessagePreview: input.text.slice(0, 500) } });
      if (input.takeover) await tx.socialLeadConversation.updateMany({ where: { id: input.conversationId, leadStatus: "NEW" }, data: { leadStatus: "CONTACTED" } });
    });
  } catch {
    // Includes provider acceptance followed by local persistence failure.
    await db.$transaction(async tx => {
      const changed = await (tx as any).socialInboxOutbound.updateMany({ where: { id, state: "SENDING" }, data: { state: attempted ? "UNCONFIRMED" : "CANCELLED" } });
      if (changed.count) await tx.socialLeadMessage.updateMany({ where: { id: messageId }, data: { status: "FAILED", sendError: attempted ? UNCONFIRMED_REPLY : "Reply cancelled before provider delivery." } });
    });
  }
  return (db as any).socialInboxOutbound.findUniqueOrThrow({ where: { id } });
}

