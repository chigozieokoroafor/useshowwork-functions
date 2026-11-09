import { db } from "../../lib/db";
import { effectiveTeamPermissions, normalizeTeamRole } from "../../lib/calendarTeamPolicy";

type Member = { creatorId: string; role: string; permissions: string[]; customPermissions: boolean };
export function handoffRecipientIds(ownerId: string, members: Member[]): string[] {
  const responsible = members.filter(member => effectiveTeamPermissions(member.role, member.permissions, member.customPermissions).includes("inbox.reply"));
  const recipients = responsible.length ? responsible : members.filter(member => normalizeTeamRole(member.role) === "SOCIAL_MEDIA_MANAGER");
  return [...new Set([ownerId, ...recipients.map(member => member.creatorId)])];
}

/** Only the first transition opens an alert; follow-up messages never resume AI. */
export async function handoffSocialConversation(conversationId: string, reason: string, expectedVersion?: number) {
  return db.$transaction(async tx => {
    const changed = await tx.socialLeadConversation.updateMany({
      where: { id: conversationId, aiPausedAt: null, ...(expectedVersion === undefined ? {} : { aiControlVersion: expectedVersion }) },
      data: { aiPausedAt: new Date(), aiHandoffOfferedAt: null, aiHandoffOfferMessageId: null, aiHandoffReason: reason.slice(0, 1000), aiHandoffAcknowledgedAt: null, aiControlVersion: { increment: 1 } },
    });
    if (!changed.count) return changed;
    const thread = await tx.socialLeadConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { aiControlVersion: true, calendar: { select: { managerId: true, collaborators: { select: { creatorId: true, role: true, permissions: true, customPermissions: true } } } } } });
    await (tx as any).inboxHandoffNotification.createMany({ data: handoffRecipientIds(thread.calendar.managerId, thread.calendar.collaborators).map(recipientId => ({ conversationId, eventVersion: thread.aiControlVersion, recipientId })), skipDuplicates: true });
    return changed;
  });
}

/** Explicit requests bypass generation, so even a model failure cannot ignore them. */
export function explicitHumanRequest(text: string): boolean {
  return /\b(?:speak|talk|chat|connect|transfer)\s+(?:me\s+)?(?:to|with)\s+(?:a\s+|an\s+|your\s+|the\s+)?(?:real\s+|human\s+)?(?:human|person|agent|representative|manager|owner|someone)\b/i.test(text)
    || /\b(?:want|need|prefer|like)\s+(?:to\s+(?:speak|talk|chat)\s+(?:to|with)\s+)?(?:a\s+|your\s+|a member of (?:your|the)\s+)?(?:human|person|sales rep(?:resentative)?|team member|team)\b/i.test(text)
    || /^\s*(?:human|real person|human agent|agent|representative)(?:\s+please)?[.!?\s]*$/i.test(text)
    || /\b(?:stop|don['’]?t|do not)\s+(?:using\s+)?(?:the\s+)?(?:bot|ai|automated replies)\b/i.test(text);
}

export function requiredHandoffReason(text: string): string | null {
  if (explicitHumanRequest(text)) return "The customer asked to speak to a person.";
  return null;
}

