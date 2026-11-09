export const TEAM_OFFER = "Would you like a member of our team to join this conversation?";
export const TEAM_OFFER_TEXT = `${TEAM_OFFER}\nReply “Yes, connect me” or “No, keep helping”.`;
export const TEAM_ACKNOWLEDGEMENT = "Thanks. I’ve notified our team. A team member will reply here when available.";
const DAY = 24 * 60 * 60_000;
export function handoffChoice(text: string, input: { offeredAt?: Date | null; offerMessageId?: string | null; latestOutboundId?: string; now?: number }): "yes" | "no" | null {
  if (!input.offeredAt || !input.offerMessageId || input.latestOutboundId !== input.offerMessageId || (input.now ?? Date.now()) - input.offeredAt.getTime() > DAY) return null;
  const answer = text.trim().toLowerCase().replace(/[.!?,“”"']/g, "").replace(/\s+/g," ");
  if (/^(?:yes|yes please|yes connect me|yes please connect me|sure|sure please|please do|connect me)$/.test(answer)) return "yes";
  if (/^(?:no|no thanks|no thank you|no keep helping|not now|keep helping|continue helping)$/.test(answer)) return "no";
  return null;
}
export function shouldOfferTeam(input: { offeredAt?: Date | null; declinedAt?: Date | null; aiReplyCount: number; needsHelp: boolean; now?: number }) {
  const now = input.now ?? Date.now();
  if (input.declinedAt && now - input.declinedAt.getTime() < DAY) return false;
  if (input.offeredAt && now - input.offeredAt.getTime() < DAY) return false;
  return input.needsHelp || input.aiReplyCount >= 3;
}
export function withTeamOffer(text: string) {
  return `${text.trim()}${text.trim() ? "\n\n" : ""}${TEAM_OFFER_TEXT}`;
}

