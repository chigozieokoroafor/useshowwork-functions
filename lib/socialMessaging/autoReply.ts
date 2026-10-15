import { consumeCalendarAiGeneration } from "@/lib/contentWorkspaceUsage";
import { canUseCalendarFeature } from "@/lib/calendarPermissions";
import { normalizeReplyProfile } from "@/lib/socialMessaging/replyProfile";
import { db } from "@/lib/db";
import { generateSocialInboxAutoReply } from "@/lib/openai";
import { sendSocialInboxMessage, supportsMessaging } from "@/lib/socialMessaging/registry";
import { whatsappAutoReplyHandoff } from "@/lib/socialMessaging/whatsapp";

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

export async function processSocialInboxAutoReplies(messageIds?: string[]) {
  let targetCalendarIds: string[] | undefined;
  if (messageIds) {
    const pending = await db.socialLeadMessage.findMany({
      where: { id: { in: messageIds }, direction: "INBOUND", autoReplyEligible: true, autoReplyHandledAt: null },
      select: { conversation: { select: { calendarId: true } } },
    });
    targetCalendarIds = [...new Set(pending.map((message) => message.conversation.calendarId))];
    if (!targetCalendarIds.length) return { workspaces: 0, analyzed: 0, sent: 0, handedOff: 0, failed: 0 };
  }
  const settings = await db.socialInboxSettings.findMany({
    where: { aiAutoReplyEnabled: true, ...(targetCalendarIds ? { calendarId: { in: targetCalendarIds } } : {}) },
    select: { calendarId: true },
  });
  const summary = { workspaces: settings.length, analyzed: 0, sent: 0, handedOff: 0, failed: 0 };
  for (const { calendarId } of settings) {
    // Re-evaluate the owner at execution time; never discard queued trial data.
    if (!(await canUseCalendarFeature(calendarId, "aiAutoReplies"))) continue;
    const queue = await db.socialLeadMessage.findMany({
      where: {
        direction: "INBOUND",
        ...(messageIds ? { id: { in: messageIds } } : {}),
        autoReplyEligible: true,
        autoReplyHandledAt: null,
        autoReplyAttemptCount: { lt: 3 },
        conversation: { calendarId },
      },
      orderBy: { platformCreatedAt: "asc" },
      take: 10,
      include: {
        conversation: {
          include: {
            connection: true,
            calendar: { select: { clientName: true, aiBusinessSummary: true, instagramPageId: true } },
            messages: { orderBy: [{ platformCreatedAt: "desc" }, { createdAt: "desc" }], take: 20 },
          },
        },
      },
    });
    for (const inbound of queue) {
      const now = new Date();
      const claimed = await db.socialLeadMessage.updateMany({
        where: {
          id: inbound.id,
          autoReplyHandledAt: null,
          autoReplyAttemptCount: { lt: 3 },
          OR: [{ autoReplyClaimedAt: null }, { autoReplyClaimedAt: { lt: new Date(now.getTime() - CLAIM_TIMEOUT_MS) } }],
        },
        data: { autoReplyClaimedAt: now, autoReplyAttemptCount: { increment: 1 }, sendError: null },
      });
      if (!claimed.count) continue;
      summary.analyzed++;
      let sendAttempted = false;
      try {
        if (inbound.conversation.platform === "WHATSAPP") {
          const reason = await whatsappAutoReplyHandoff(inbound);
          if (reason) {
            await db.socialLeadMessage.update({ where: { id: inbound.id }, data: { autoReplyHandledAt: new Date(), autoReplyClaimedAt: null, autoReplyHandoffReason: reason } });
            summary.handedOff++;
            continue;
          }
        }
        // Do not answer an older message after the customer has moved on or
        // the team has already responded. The latest message includes the
        // earlier customer messages in its conversation context.
        const targetIndex = inbound.conversation.messages.findIndex(message => message.id === inbound.id);
        const supersedingMessage = inbound.conversation.messages.find((message, index) =>
          message.id !== inbound.id && (message.platformCreatedAt > inbound.platformCreatedAt || (message.platformCreatedAt.getTime() === inbound.platformCreatedAt.getTime() && (targetIndex === -1 || index < targetIndex))) &&
          (message.direction === "INBOUND" || ["PENDING", "SENT", "DELIVERED", "READ"].includes(message.status)));
        if (supersedingMessage) {
          await db.socialLeadMessage.update({ where: { id: inbound.id }, data: { autoReplyHandledAt: new Date(), autoReplyClaimedAt: null, autoReplyHandoffReason: supersedingMessage.direction === "OUTBOUND" ? "This conversation already received a reply." : "A newer customer message superseded this reply." } });
          summary.handedOff++;
          continue;
        }
        const recent = [...inbound.conversation.messages].reverse().map((message) => ({
          direction: message.direction,
          text: message.text.slice(0, 2000),
          createdAt: message.platformCreatedAt.toISOString(),
        }));
        const replySettings = await db.socialInboxSettings.findUnique({ where: { calendarId }, select: { aiAutoReplyInstructions: true, aiReplyProfile: true } });
        const quota = await consumeCalendarAiGeneration(calendarId);
        if (!quota.allowed) {
          // Exhaustion pauses the queue without retiring messages or consuming retry attempts.
          await db.socialLeadMessage.update({ where: { id: inbound.id }, data: {
            autoReplyClaimedAt: null, autoReplyAttemptCount: { decrement: 1 },
          } });
          continue;
        }
        const generated = await generateSocialInboxAutoReply({
          clientName: inbound.conversation.calendar.clientName,
          businessSummary: inbound.conversation.calendar.aiBusinessSummary,
          instructions: replySettings?.aiAutoReplyInstructions ?? null,
          profile: normalizeReplyProfile(replySettings?.aiReplyProfile),
          platform: inbound.conversation.platform,
          participantName: inbound.conversation.participantName,
          conversation: recent,
          latestInbound: inbound.text.slice(0, 3000),
        });
        if (!generated.shouldReply || !generated.replyText || !inbound.conversation.connection || !supportsMessaging(inbound.conversation.platform)) {
          await db.socialLeadMessage.update({ where: { id: inbound.id }, data: { autoReplyHandledAt: new Date(), autoReplyClaimedAt: null, autoReplyHandoffReason: generated.handoffReason || "This message needs a human response." } });
          summary.handedOff++;
          continue;
        }
        const latestSettings = await db.socialInboxSettings.findUnique({ where: { calendarId }, select: { aiAutoReplyEnabled: true } });
        if (!(await canUseCalendarFeature(calendarId, "aiAutoReplies"))) {
          await db.socialLeadMessage.update({ where: { id: inbound.id }, data: { autoReplyClaimedAt: null } });
          continue;
        }
        if (!latestSettings?.aiAutoReplyEnabled) {
          await db.socialLeadMessage.update({ where: { id: inbound.id }, data: { autoReplyHandledAt: new Date(), autoReplyClaimedAt: null, autoReplyHandoffReason: "Automatic replies were disabled before the reply was sent." } });
          summary.handedOff++;
          continue;
        }
        if (inbound.conversation.platform === "WHATSAPP") {
          const reason = await whatsappAutoReplyHandoff(inbound);
          if (reason) {
            await db.socialLeadMessage.update({ where: { id: inbound.id }, data: { autoReplyHandledAt: new Date(), autoReplyClaimedAt: null, autoReplyHandoffReason: reason } });
            summary.handedOff++;
            continue;
          }
        }
        sendAttempted = true;
        const providerMessageId = await sendSocialInboxMessage({
          connection: inbound.conversation.connection,
          conversationId: inbound.conversation.providerConversationId,
          instagramPageId: inbound.conversation.calendar.instagramPageId,
          recipientId: inbound.conversation.participantPlatformId,
          text: generated.replyText,
        });
        const sentAt = new Date();
        await db.$transaction(async (tx) => {
          if (providerMessageId) {
            await tx.socialLeadMessage.createMany({
              data: [{ conversationId: inbound.conversationId, providerMessageId, direction: "OUTBOUND", status: "SENT", text: generated.replyText, platformCreatedAt: sentAt, isAiGenerated: true }],
              skipDuplicates: true,
            });
          } else {
            await tx.socialLeadMessage.create({ data: { conversationId: inbound.conversationId, direction: "OUTBOUND", status: "SENT", text: generated.replyText, platformCreatedAt: sentAt, isAiGenerated: true } });
          }
          await tx.socialLeadMessage.update({ where: { id: inbound.id }, data: { autoReplyHandledAt: sentAt, autoReplyClaimedAt: null, autoReplyHandoffReason: null } });
          await tx.socialLeadConversation.update({ where: { id: inbound.conversationId }, data: { lastMessageAt: sentAt, lastMessagePreview: generated.replyText.slice(0, 500) } });
        });
        summary.sent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Automatic reply could not be sent.";
        const isLastAttempt = sendAttempted || inbound.autoReplyAttemptCount + 1 >= 3;
        await db.socialLeadMessage.update({
          where: { id: inbound.id },
          data: {
            autoReplyClaimedAt: null,
            ...(isLastAttempt ? { autoReplyHandledAt: new Date(), autoReplyHandoffReason: sendAttempted ? "Reply delivery could not be recorded or confirmed. Check the platform inbox before replying again." : "Automatic reply failed repeatedly; a human needs to take over." } : {}),
            sendError: message.slice(0, 1500),
          },
        });
        summary.failed++;
        console.error(`Social inbox auto-reply failed for message ${inbound.id}:`, error);
      }
    }
  }
  return summary;
}

export async function processSocialInboxAutoReply(messageId: string) {
  return processSocialInboxAutoReplies([messageId]);
}
