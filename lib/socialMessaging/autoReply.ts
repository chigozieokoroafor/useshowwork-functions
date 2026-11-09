import { handoffChoice, shouldOfferTeam, withTeamOffer, TEAM_ACKNOWLEDGEMENT } from "./handoffConsent";
import { sendDurableInboxReply, reconcileStaleInboxSends, findInboxSend } from "./outbound";
import { maskSensitiveText } from "./safety";
import { getBusinessKnowledgeContext } from "../knowledge/context";
import { requiredHandoffReason, handoffSocialConversation } from "./handoff";
import { deliverHandoffNotifications } from "./handoffNotifications";
import { consumeCalendarAiGeneration } from "../contentWorkspaceUsage";
import { canUseCalendarFeature } from "../calendarPermissions";
import { normalizeReplyProfile } from "./replyProfile";
import { db } from "../db";
import { generateSocialInboxAutoReply } from "../openai";
import { sendSocialInboxMessage, supportsMessaging } from "./registry";
import { whatsappAutoReplyHandoff } from "./whatsapp";

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

async function processSocialInboxAutoRepliesInternal(messageIds?: string[]) {
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
    await reconcileStaleInboxSends(calendarId);
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
      const processingStartedAt = Date.now();
      const queueWaitMs = inbound.createdAt ? Math.max(0, processingStartedAt - inbound.createdAt.getTime()) : null;
      let generationMs = 0;
      let deliveryMs = 0;
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
      let controlVersion: number | undefined;
      const retire = async (reason: string) => {
        await db.socialLeadMessage.update({ where: { id: inbound.id }, data: { autoReplyHandledAt: new Date(), autoReplyClaimedAt: null, autoReplyHandoffReason: reason } });
      };
      const handoff = async (reason: string) => {
        // Pause first: a persistence failure must never leave automation running.
        await handoffSocialConversation(inbound.conversationId, reason, controlVersion);
        await retire(reason);
      };
      try {
        const priorSend = await findInboxSend(inbound.conversationId, `ai:${inbound.id}`);
        if (priorSend) {
          if (priorSend.state === "SENT") await retire("Automatic reply was already sent.");
          else await handoff("An earlier reply is already tracked. Check its delivery status before replying again.");
          summary.handedOff++;
          continue;
        }
        const control = await db.socialLeadConversation.findUniqueOrThrow({ where: { id: inbound.conversationId }, select: { aiPausedAt: true, aiControlVersion: true, aiHandoffOfferedAt: true, aiHandoffOfferMessageId: true, aiHandoffDeclinedAt: true } });
        controlVersion = control.aiControlVersion;
        if (control.aiPausedAt) {
          await retire("AI is paused while a team member handles this conversation.");
          summary.handedOff++;
          continue;
        }
        const detectedHandoff = requiredHandoffReason(inbound.text);
        if (inbound.conversation.platform === "WHATSAPP") {
          const reason = await whatsappAutoReplyHandoff(inbound);
          if (reason) {
            if (reason.includes("reply window closed")) await handoff(reason);
            else await retire(reason);
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
        const latestOutbound = inbound.conversation.messages.find(message => message.direction === "OUTBOUND" && ["SENT", "DELIVERED", "READ"].includes(message.status));
        const choice = handoffChoice(inbound.text, {offeredAt:control.aiHandoffOfferedAt, offerMessageId:control.aiHandoffOfferMessageId, latestOutboundId:latestOutbound?.id});
        if (detectedHandoff || choice === "yes") {
          const reason = detectedHandoff || "The customer accepted an offer to speak with the team.";
          await handoff(reason);
          if (inbound.conversation.connection && supportsMessaging(inbound.conversation.platform)) {
            const acknowledgement = TEAM_ACKNOWLEDGEMENT;
            const operation = await sendDurableInboxReply({
              conversationId: inbound.conversationId, operationKey: `ai:${inbound.id}`, text: acknowledgement, isAiGenerated: false,
              beforeSend: async () => {
                const latest = await db.socialLeadConversation.findUniqueOrThrow({ where: { id: inbound.conversationId }, select: { aiControlVersion: true, aiPausedAt: true } });
                const settings = await db.socialInboxSettings.findUnique({ where: { calendarId }, select: { aiAutoReplyEnabled: true } });
                return !!settings?.aiAutoReplyEnabled && !!latest.aiPausedAt && latest.aiControlVersion === control.aiControlVersion + 1 && await canUseCalendarFeature(calendarId, "aiAutoReplies");
              },
              send: () => sendSocialInboxMessage({ connection: inbound.conversation.connection!, conversationId: inbound.conversation.providerConversationId, instagramPageId: inbound.conversation.calendar.instagramPageId, recipientId: inbound.conversation.participantPlatformId, text: acknowledgement }),
            });
            if (operation.state === "UNCONFIRMED") summary.failed++;
          }
          summary.handedOff++;
          continue;
        }
        if (choice === "no") {
          await db.socialLeadConversation.updateMany({where:{id:inbound.conversationId,aiControlVersion:control.aiControlVersion,aiPausedAt:null},data:{aiHandoffOfferedAt:null,aiHandoffOfferMessageId:null,aiHandoffDeclinedAt:new Date()}});
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
        const generationStartedAt = Date.now();
        const generated = await generateSocialInboxAutoReply({
          clientName: inbound.conversation.calendar.clientName,
          businessSummary: await getBusinessKnowledgeContext(calendarId, maskSensitiveText(recent.map(m => m.text).join("\n") + "\n" + inbound.text), "reply"),
          instructions: replySettings?.aiAutoReplyInstructions ?? null,
          profile: normalizeReplyProfile(replySettings?.aiReplyProfile),
          platform: inbound.conversation.platform,
          participantName: inbound.conversation.participantName,
          conversation: recent,
          latestInbound: inbound.text.slice(0, 3000),
          teamOfferPending: !!control.aiHandoffOfferedAt && choice !== "no",
          teamOfferDeclined: choice === "no" || !!(control.aiHandoffDeclinedAt && Date.now() - control.aiHandoffDeclinedAt.getTime() < 24 * 60 * 60_000),
        });
        generationMs = Date.now() - generationStartedAt;
        if (!inbound.conversation.connection || !supportsMessaging(inbound.conversation.platform)) {
          await retire("This channel cannot currently deliver a reply. Check its connection.");
          continue;
        }
        const offerHandoff = shouldOfferTeam({offeredAt:control.aiHandoffOfferedAt,declinedAt:choice === "no" ? new Date() : control.aiHandoffDeclinedAt,aiReplyCount:inbound.conversation.messages.filter(message => message.direction === "OUTBOUND" && message.isAiGenerated && ["SENT","DELIVERED","READ"].includes(message.status)).length + 1,needsHelp:generated.handoffNeeded || !generated.shouldReply || !generated.replyText});
        const helpfulText = generated.shouldReply && generated.replyText ? generated.replyText : "I can’t complete this request here. A member of our team needs to handle the next step and can respond in this conversation when available.";
        const replyText = offerHandoff ? withTeamOffer(helpfulText) : helpfulText;
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
            if (reason.includes("reply window closed")) await handoff(reason);
            else await retire(reason);
            summary.handedOff++;
            continue;
          }
        }
        // Re-read after generation: staff takeover/resume invalidates an in-flight draft.
        const beforeSend = await db.socialLeadConversation.findUniqueOrThrow({ where: { id: inbound.conversationId }, select: { aiPausedAt: true, aiControlVersion: true } });
        const newerMessage = await db.socialLeadMessage.findFirst({ where: { conversationId: inbound.conversationId, id: { not: inbound.id }, createdAt: { gt: inbound.createdAt }, OR: [{ direction: "INBOUND" }, { direction: "OUTBOUND", status: { in: ["PENDING", "SENT", "DELIVERED", "READ"] } }] }, select: { id: true } });
        if (beforeSend.aiPausedAt || beforeSend.aiControlVersion !== control.aiControlVersion || newerMessage) {
          await retire("Conversation changed while the reply was being prepared; this draft was cancelled.");
          summary.handedOff++;
          continue;
        }
        sendAttempted = true;
        const deliveryStartedAt = Date.now();
        const operation = await sendDurableInboxReply({
          conversationId: inbound.conversationId, operationKey: `ai:${inbound.id}`, text: replyText, isAiGenerated: true, handoffOffer: offerHandoff, expectedControlVersion: control.aiControlVersion,
          beforeSend: async () => {
            const latest = await db.socialLeadConversation.findUniqueOrThrow({ where: { id: inbound.conversationId }, select: { aiPausedAt: true, aiControlVersion: true } });
            const settings = await db.socialInboxSettings.findUnique({ where: { calendarId }, select: { aiAutoReplyEnabled: true } });
            const newer = await db.socialLeadMessage.findFirst({ where: { conversationId: inbound.conversationId, id: { not: inbound.id }, createdAt: { gt: inbound.createdAt }, OR: [{ direction: "INBOUND" }, { direction: "OUTBOUND", isAiGenerated: false, status: { in: ["SENT", "DELIVERED", "READ"] } }] }, select: { id: true } });
            return !latest.aiPausedAt && latest.aiControlVersion === control.aiControlVersion && !newer && !!settings?.aiAutoReplyEnabled && await canUseCalendarFeature(calendarId, "aiAutoReplies");
          },
          send: () => sendSocialInboxMessage({ connection: inbound.conversation.connection!, conversationId: inbound.conversation.providerConversationId, instagramPageId: inbound.conversation.calendar.instagramPageId, recipientId: inbound.conversation.participantPlatformId, text: replyText, offerHandoff }),
        });
        if (operation.state !== "SENT") {
          if (operation.state === "UNCONFIRMED") { summary.failed++; await handoff("Reply delivery is unconfirmed. Check the platform inbox before replying again."); }
          else await retire("This reply is already being tracked or was cancelled. Check the conversation delivery status.");
          summary.handedOff++;
          continue;
        }
        deliveryMs = Date.now() - deliveryStartedAt;
        await retire("Automatic reply sent.");
        summary.sent++;
        // Aggregate timings only; no customer text, credentials, or account IDs.
        console.info("Social inbox AI reply timing", {
          platform: inbound.conversation.platform,
          queueWaitMs,
          generationMs, deliveryMs,
          processingMs: Date.now() - processingStartedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Automatic reply could not be sent.";
        const isLastAttempt = sendAttempted || inbound.autoReplyAttemptCount + 1 >= 3;
        if (isLastAttempt) await handoffSocialConversation(inbound.conversationId, sendAttempted
          ? "Reply delivery could not be confirmed. Check the platform inbox before replying again."
          : "Automatic replies failed repeatedly. A team member needs to take over.", controlVersion);
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

export async function processSocialInboxAutoReplies(messageIds?: string[]) {
  try { return await processSocialInboxAutoRepliesInternal(messageIds); }
  finally { await deliverHandoffNotifications().catch(() => console.error("Inbox handoff email queue could not run; scheduled worker will retry.")); }
}
