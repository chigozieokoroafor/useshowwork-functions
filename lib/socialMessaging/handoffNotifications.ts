import { db } from "../../lib/db";
import { handoffRecipientIds } from "./handoff";

/** Durable email outbox: retries keep the same provider idempotency key. */
export async function deliverHandoffNotifications() {
  const now = new Date();
  const pending = await (db as any).inboxHandoffNotification.findMany({
    where: { sentAt: null, nextAttemptAt: { lte: now }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 5 * 60_000) } }] },
    orderBy: { createdAt: "asc" }, take: 25,
  });
  for (const notification of pending) {
    const claim = await (db as any).inboxHandoffNotification.updateMany({ where: { id: notification.id, sentAt: null, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 5 * 60_000) } }] }, data: { claimedAt: now, attempts: { increment: 1 } } });
    if (!claim.count) continue;
    try {
      const thread = await db.socialLeadConversation.findUniqueOrThrow({ where: { id: notification.conversationId }, select: { calendarId: true, calendar: { select: { managerId: true, collaborators: { select: { creatorId: true, role: true, permissions: true, customPermissions: true } } } } } });
      // Recheck current responsibility before delivery; removed members get no email.
      if (handoffRecipientIds(thread.calendar.managerId, thread.calendar.collaborators).includes(notification.recipientId)) {
        const recipient = await db.creator.findUnique({ where: { id: notification.recipientId }, select: { email: true } });
        if (recipient?.email) {
          const { sendInboxHandoffEmail } = await import("../../lib/resend");
          await sendInboxHandoffEmail({ to: recipient.email, calendarId: thread.calendarId, conversationId: notification.conversationId, notificationId: notification.id });
        }
      }
      await (db as any).inboxHandoffNotification.update({ where: { id: notification.id }, data: { sentAt: new Date(), claimedAt: null, lastError: null } });
    } catch {
      // Do not persist provider errors that might contain addresses or message data.
      await (db as any).inboxHandoffNotification.update({ where: { id: notification.id }, data: { claimedAt: null, nextAttemptAt: new Date(Date.now() + Math.min(60, 2 ** Math.min(notification.attempts, 6)) * 60_000), lastError: "Email delivery failed; scheduled for retry." } });
      console.error("Inbox handoff notification delivery failed; queued for retry.");
    }
  }
}

