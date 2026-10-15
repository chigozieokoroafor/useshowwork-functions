import { after } from "next/server";
import type { Prisma, BillingOffer } from "@prisma/client";
import { db } from "@/lib/db";
import { sendBillingBenefitEmail, type BillingBenefitEmail } from "@/lib/resend";
import { addCalendarMonths } from "@/lib/billingOfferRules";

type Recipient = { id: string; email: string; name: string | null };
function payload(offer: BillingOffer, recipient: Recipient, event: "GRANTED" | "STOPPED"): BillingBenefitEmail {
  return { to: recipient.email, name: recipient.name, title: offer.title, event, product: offer.product,
    deliveryTier: offer.deliveryTier, workspacePlan: offer.workspacePlan, percent: offer.percent,
    durationMonths: offer.durationMonths, billingCycle: offer.billingCycle ?? (offer.durationMonths % 12 ? "MONTHLY" : null),
    availableUntil: offer.availableUntil?.toISOString() ?? null,
    endsAt: offer.percent === 100 ? addCalendarMonths(offer.createdAt, offer.durationMonths).toISOString() : null };
}
/** Save notifications in the same transaction as the benefit, before any SMTP work. */
export async function queueOfferEmails(tx: Prisma.TransactionClient, offer: BillingOffer, event: "GRANTED" | "STOPPED", creatorIds?: string[]) {
  let cursor: string | undefined;
  let queued = 0;
  while (true) {
    const users = await tx.creator.findMany({ where: { isDeactivated: false,
      ...(creatorIds ? { id: { in: creatorIds } } : offer.audience === "SELECTED" ? { billingOfferRecipients: { some: { offerId: offer.id } } } : {}) },
      select: { id: true, email: true, name: true }, orderBy: { id: "asc" }, take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!users.length) break;
    const result = await tx.billingBenefitNotification.createMany({ data: users.map(user => ({
      id: `${offer.id}:${user.id}:${event}`, offerId: offer.id, creatorId: user.id, event,
      payload: payload(offer, user, event) as unknown as Prisma.InputJsonValue,
    })), skipDuplicates: true });
    queued += result.count;
    if (users.length < 500) break;
    cursor = users[users.length - 1].id;
  }
  return queued;
}
/** New users receive currently available global offers after email verification. */
export async function queueGlobalBenefitsForNewUser(tx: Prisma.TransactionClient, user: Recipient) {
  const offers = await tx.billingOffer.findMany({ where: { audience: "ALL", revokedAt: null,
    OR: [{ availableUntil: null }, { availableUntil: { gt: new Date() } }] } });
  if (!offers.length) return;
  await tx.billingBenefitNotification.createMany({ data: offers.map(offer => ({
    id: `${offer.id}:${user.id}:GRANTED`, offerId: offer.id, creatorId: user.id, event: "GRANTED",
    payload: payload(offer, user, "GRANTED") as unknown as Prisma.InputJsonValue,
  })), skipDuplicates: true });
}
export async function deliverBenefitEmails({ offerId, limit = 25, budgetMs = 40000 }: { offerId?: string; limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const now = new Date();
  const expiredLease = new Date(now.getTime() - 120000);
  const jobs = await db.billingBenefitNotification.findMany({ where: {
    ...(offerId ? { offerId } : {}), OR: [
      { status: "PENDING", nextAttemptAt: { lte: now } }, { status: "SENDING", claimedAt: { lte: expiredLease } },
    ],
  }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit });
  let sent = 0, failed = 0;
  for (const job of jobs) {
    if (Date.now() - started > budgetMs) break;
    const claim = await db.billingBenefitNotification.updateMany({ where: { id: job.id, OR: [
      { status: "PENDING", nextAttemptAt: { lte: now } }, { status: "SENDING", claimedAt: { lte: expiredLease } },
    ] }, data: { status: "SENDING", claimedAt: new Date(), attempts: { increment: 1 } } });
    if (!claim.count) continue;
    try {
      const message = job.payload as unknown as BillingBenefitEmail;
      if (job.event === "GRANTED" && message.percent === 100 && message.endsAt && new Date(message.endsAt) <= new Date()) {
        await db.billingBenefitNotification.update({ where: { id: job.id }, data: { status: "CANCELLED", claimedAt: null } });
        continue;
      }
      if (job.event === "GRANTED" && job.offerId) {
        const offer = await db.billingOffer.findUnique({ where: { id: job.offerId }, select: { revokedAt: true, availableUntil: true, audience: true } });
        const recipient = offer?.audience === "SELECTED" ? await db.billingOfferRecipient.findUnique({ where: { offerId_creatorId: { offerId: job.offerId, creatorId: job.creatorId } }, select: { revokedAt: true } }) : null;
        if (!offer || offer.revokedAt || (message.percent < 100 && offer.availableUntil && offer.availableUntil <= new Date()) || (offer.audience === "SELECTED" && (!recipient || recipient.revokedAt))) {
          await db.billingBenefitNotification.update({ where: { id: job.id }, data: { status: "CANCELLED", claimedAt: null } });
          continue;
        }
      }
      // A stable provider key protects retries if acknowledgement is lost.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let providerId: string | null;
      try {
        providerId = await Promise.race([
          sendBillingBenefitEmail(job.payload as unknown as BillingBenefitEmail, `billing-benefit/${job.id}`),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Email provider timed out")), 15000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      await db.billingBenefitNotification.update({ where: { id: job.id }, data: { status: "SENT", sentAt: new Date(), providerId, claimedAt: null, lastError: null } });
      sent++;
    } catch {
      const attempts = job.attempts + 1;
      await db.billingBenefitNotification.update({ where: { id: job.id }, data: {
        status: attempts >= 8 ? "FAILED" : "PENDING", claimedAt: null,
        nextAttemptAt: new Date(Date.now() + Math.min(60 * 2 ** attempts, 3600) * 1000),
        lastError: "Email delivery failed. Queued for retry or admin review.",
      } });
      failed++;
    }
    // Stay under the provider's normal request rate; failures remain durable.
    if (Date.now() - started < budgetMs && sent + failed < jobs.length) await new Promise(resolve => setTimeout(resolve, 600));
  }
  return { sent, failed };
}
export function scheduleBenefitEmailDelivery(offerId?: string) {
  after(async () => {
    try { await deliverBenefitEmails({ offerId }); }
    catch { console.error("Billing benefit email worker failed; saved messages remain queued."); }
  });
}

export async function queuePartnerWelcomeBenefit(tx: Prisma.TransactionClient, user: Recipient, endsAt: Date) {
  const message: BillingBenefitEmail = { to: user.email, name: user.name, title: "Partner welcome complimentary access", event: "GRANTED",
    product: "CONTENT_WORKSPACE", deliveryTier: null, workspacePlan: "STUDIO", percent: 100, durationMonths: 1,
    billingCycle: null, availableUntil: null, endsAt: endsAt.toISOString() };
  await tx.billingBenefitNotification.createMany({ data: [{ id: `partner-welcome:${user.id}`, creatorId: user.id, event: "GRANTED", payload: message as unknown as Prisma.InputJsonValue }], skipDuplicates: true });
}
