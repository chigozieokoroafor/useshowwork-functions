import { db } from "@/lib/db";
import { createPlan, initializeSubscription, updatePrivatePlanPrice, verifyTransaction } from "@/lib/paystack";
import { extractPaystackPlanCode } from "@/lib/paystackPlan";
import { tierFromPlanCode, type PaidTier, type BillingCycle } from "@/lib/subscriptionTiers";
import { contentWorkspacePlanFromPaystackPlanCode, type ContentWorkspacePlan } from "@/lib/contentWorkspaceEntitlements";
import { addCalendarMonths, chooseOffer, discountedPrice, discountCycles, priceForProduct, type BillingProduct } from "@/lib/billingOfferRules";

export async function eligibleOffers(creatorId: string) {
  return db.billingOffer.findMany({
    where: { revokedAt: null, OR: [{ availableUntil: null }, { availableUntil: { gt: new Date() } }],
      AND: [{ OR: [{ audience: "ALL" }, { audience: "SELECTED", recipients: { some: { creatorId, revokedAt: null } } }] }] },
    orderBy: { createdAt: "desc" },
  });
}

export async function offerQuote(creatorId: string, product: BillingProduct, plan: string, cycle: BillingCycle) {
  const offers = await eligibleOffers(creatorId);
  const redemptions = await db.billingOfferRedemption.findMany({ where: { creatorId, product } });
  const now = new Date();
  const usable = offers.filter(offer => {
    const used = redemptions.find(r => r.offerId === offer.id);
    return !used || (used.billingCycle === cycle && used.paidCycles < used.maxCycles && used.discountEndsAt > now);
  });
  const offer = chooseOffer(usable, product, plan, cycle, now);
  const standardPriceNgn = priceForProduct(product, plan, cycle);
  const used = offer ? redemptions.find(r => r.offerId === offer.id) : null;
  return { offer, standardPriceNgn, discountedPriceNgn: offer ? discountedPrice(standardPriceNgn, offer.percent) : standardPriceNgn,
    remainingCycles: offer ? (used ? used.maxCycles - used.paidCycles : discountCycles(offer.durationMonths, cycle)) : 0,
    discountEndsAt: used?.discountEndsAt ?? null };
}

/** All checkout paths use the same server-side eligibility and price snapshot. */
export async function initializeOfferSubscription(params: Parameters<typeof initializeSubscription>[0] & { expectedQuote?: { amountNgn: number; offerId: string | null } }) {
  const creatorId = params.metadata?.creatorId;
  const delivery = tierFromPlanCode(params.planCode);
  const workspace = contentWorkspacePlanFromPaystackPlanCode(params.planCode);
  if (typeof creatorId !== "string" || (!delivery && !workspace)) throw new Error("Missing product checkout identity");
  const product: BillingProduct = delivery ? "DELIVERY" : "CONTENT_WORKSPACE";
  const plan = delivery?.tier ?? workspace!.plan;
  const cycle = delivery?.cycle ?? workspace!.cycle;
  const quote = await offerQuote(creatorId, product, plan, cycle);
  if (params.expectedQuote && (params.expectedQuote.amountNgn !== quote.discountedPriceNgn || params.expectedQuote.offerId !== (quote.offer?.id ?? null))) {
    throw new Error("BILLING_QUOTE_CHANGED");
  }
  if (!quote.offer) return initializeSubscription(params);

  const privatePlan = await createPlan({
    name: `Showwork ${product} ${plan} ${cycle} · ${quote.offer.percent}% · ${params.reference}`,
    amountNgn: quote.discountedPriceNgn, interval: cycle === "ANNUAL" ? "annually" : "monthly",
  });
  if (!privatePlan.status || !privatePlan.data?.plan_code) throw new Error("Offer plan creation failed");
  const snapshot = await db.billingOfferSubscription.create({ data: {
    offerId: quote.offer.id, creatorId, product, plan, billingCycle: cycle,
    title: quote.offer.title, percent: quote.offer.percent, durationMonths: quote.offer.durationMonths,
    standardPriceNgn: quote.standardPriceNgn, discountedPriceNgn: quote.discountedPriceNgn,
    paystackPlanCode: privatePlan.data.plan_code, checkoutReference: params.reference,
  } });
  try {
    return await initializeSubscription({ ...params, planCode: privatePlan.data.plan_code,
      amount: quote.discountedPriceNgn * 100,
      metadata: { ...params.metadata, billingOfferSubscriptionId: snapshot.id } });
  } catch (error) {
    await db.billingOfferSubscription.update({ where: { id: snapshot.id }, data: { status: "FAILED" } });
    throw error;
  }
}

export async function resolveDeliveryPlan(planCode: string, creatorId?: string): Promise<{ tier: PaidTier; cycle: BillingCycle } | null> {
  const standard = tierFromPlanCode(planCode);
  if (standard) return standard;
  const offer = await db.billingOfferSubscription.findUnique({ where: { paystackPlanCode: planCode } });
  return offer?.product === "DELIVERY" && (!creatorId || offer.creatorId === creatorId)
    ? { tier: offer.plan as PaidTier, cycle: offer.billingCycle } : null;
}
export async function resolveWorkspacePlan(planCode: string, creatorId?: string): Promise<{ plan: ContentWorkspacePlan; cycle: BillingCycle } | null> {
  const standard = contentWorkspacePlanFromPaystackPlanCode(planCode);
  if (standard) return standard;
  const offer = await db.billingOfferSubscription.findUnique({ where: { paystackPlanCode: planCode } });
  return offer?.product === "CONTENT_WORKSPACE" && (!creatorId || offer.creatorId === creatorId)
    ? { plan: offer.plan as ContentWorkspacePlan, cycle: offer.billingCycle } : null;
}

/** Price is restored immediately after the final discounted charge, for the next renewal. */
export async function restoreOfferPrice(id: string): Promise<void> {
  const snapshot = await db.billingOfferSubscription.findUnique({ where: { id } });
  if (!snapshot?.paystackPlanCode || snapshot.restoredAt) return;
  try {
    await updatePrivatePlanPrice(snapshot.paystackPlanCode, snapshot.standardPriceNgn);
    await db.billingOfferSubscription.update({ where: { id }, data: { status: "STANDARD", restoredAt: new Date(), lastError: null } });
  } catch (error) {
    await db.billingOfferSubscription.update({ where: { id }, data: { status: "RESTORE_PENDING", lastError: "Standard-price restoration failed; retry required." } });
    throw error;
  }
}

/** Called only after a successful provider verification; references count exactly once. */
export async function recordOfferPayment(reference: string, verified?: any): Promise<void> {
  const verification = verified ?? await verifyTransaction(reference);
  const data = verification?.data;
  if (!verification?.status || data?.status !== "success" || data.reference !== reference || data.currency !== "NGN" || !["live", "test"].includes(data.domain)) return;
  const planCode = extractPaystackPlanCode(data);
  const snapshot = await db.billingOfferSubscription.findFirst({ where: { OR: [
    { checkoutReference: reference }, ...(planCode ? [{ paystackPlanCode: planCode }] : []),
  ] }, include: { creator: { select: { email: true } } } });
  if (!snapshot?.offerId || snapshot.status === "COMPLIMENTARY") return;
  if (String(data.customer?.email ?? "").trim().toLowerCase() !== snapshot.creator.email.toLowerCase()) throw new Error("Offer payment owner mismatch");
  if (data.amount !== snapshot.discountedPriceNgn * 100 && data.amount !== snapshot.standardPriceNgn * 100) throw new Error("Offer payment amount mismatch");
  const paidAt = new Date(data.paid_at ?? data.paidAt);
  if (!Number.isFinite(paidAt.getTime())) throw new Error("Offer payment has no valid paid date");

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await db.$transaction(async tx => {
        const receipt = await tx.billingOfferCharge.findUnique({ where: { reference } });
        if (receipt) return;
        let redemption = await tx.billingOfferRedemption.findUnique({ where: { offerId_creatorId_product: {
          offerId: snapshot.offerId!, creatorId: snapshot.creatorId, product: snapshot.product,
        } } });
        if (!redemption) redemption = await tx.billingOfferRedemption.create({ data: {
          offerId: snapshot.offerId!, creatorId: snapshot.creatorId, product: snapshot.product,
          billingCycle: snapshot.billingCycle, activatedAt: paidAt,
          discountEndsAt: addCalendarMonths(paidAt, snapshot.durationMonths),
          maxCycles: discountCycles(snapshot.durationMonths, snapshot.billingCycle),
        } });
        if (paidAt < redemption.activatedAt) {
          redemption = await tx.billingOfferRedemption.update({ where: { id: redemption.id }, data: {
            activatedAt: paidAt, discountEndsAt: addCalendarMonths(paidAt, snapshot.durationMonths),
          } });
          await tx.billingOfferSubscription.updateMany({ where: {
            offerId: snapshot.offerId, creatorId: snapshot.creatorId, product: snapshot.product,
          }, data: { discountEndsAt: redemption.discountEndsAt } });
        }
        await tx.billingOfferCharge.create({ data: { subscriptionId: snapshot.id, reference, paidAt, amountNgn: data.amount / 100 } });
        if (data.amount === snapshot.discountedPriceNgn * 100) {
          redemption = await tx.billingOfferRedemption.update({ where: { id: redemption.id }, data: { paidCycles: { increment: 1 } } });
        }
        await tx.billingOfferSubscription.update({ where: { id: snapshot.id }, data: {
          activatedAt: snapshot.activatedAt ?? paidAt, discountEndsAt: redemption.discountEndsAt,
          subscriptionCode: data.subscription?.subscription_code ?? snapshot.subscriptionCode,
          paidCycles: { increment: data.amount === snapshot.discountedPriceNgn * 100 ? 1 : 0 },
          ...(!snapshot.restoredAt ? { status: "ACTIVE" } : {}),
        } });
        if (redemption.paidCycles >= redemption.maxCycles || redemption.discountEndsAt <= new Date()) {
          await tx.billingOfferSubscription.updateMany({ where: {
            offerId: snapshot.offerId, creatorId: snapshot.creatorId, product: snapshot.product, restoredAt: null,
            paystackPlanCode: { not: null },
          }, data: { status: "RESTORE_PENDING" } });
        }
      }, { isolationLevel: "Serializable" });
      break;
    } catch (error) {
      if (["P2034", "P2002"].includes((error as { code?: string }).code ?? "") && attempt < 3) continue;
      throw error;
    }
  }
  const pending = await db.billingOfferSubscription.findMany({ where: {
    offerId: snapshot.offerId, creatorId: snapshot.creatorId, product: snapshot.product, status: "RESTORE_PENDING",
  } });
  for (const item of pending) await restoreOfferPrice(item.id);
}

export async function reconcileOfferExpirations() {
  const pending = await db.billingOfferSubscription.findMany({ where: { paystackPlanCode: { not: null }, restoredAt: null,
    OR: [{ status: "RESTORE_PENDING" }, { status: "ACTIVE", discountEndsAt: { lte: new Date() } }] }, take: 100, orderBy: { createdAt: "asc" } });
  let restored = 0;
  for (const item of pending) { try { await restoreOfferPrice(item.id); restored++; } catch { /* Persisted for the next retry and admin visibility. */ } }
  return { processed: pending.length, restored, failed: pending.length - restored };
}

export async function offerSubscriptionId(planCode: string, creatorId: string) {
  const snapshot = await db.billingOfferSubscription.findUnique({ where: { paystackPlanCode: planCode } });
  return snapshot?.creatorId === creatorId ? snapshot.id : null;
}

export async function billingPriceQuotes(creatorId: string) {
  const [offers, redemptions] = await Promise.all([eligibleOffers(creatorId), db.billingOfferRedemption.findMany({ where: { creatorId } })]);
  const quotes: Record<string, { title: string; percent: number; months: number; standardPriceNgn: number; priceNgn: number; remainingCycles: number }> = {};
  for (const product of ["DELIVERY", "CONTENT_WORKSPACE"] as const) {
    for (const plan of product === "DELIVERY" ? ["STARTER", "GROWTH", "UNLIMITED"] : ["CREATOR", "STUDIO", "UNLIMITED"]) {
      for (const cycle of ["MONTHLY", "ANNUAL"] as const) {
        const usable = offers.filter(o => {
          const used = redemptions.find(r => r.offerId === o.id && r.product === product);
          return !used || (used.billingCycle === cycle && used.paidCycles < used.maxCycles && used.discountEndsAt > new Date());
        });
        const offer = chooseOffer(usable, product, plan, cycle);
        if (!offer) continue;
        const used = redemptions.find(r => r.offerId === offer.id && r.product === product);
        const standardPriceNgn = priceForProduct(product, plan, cycle);
        quotes[`${product}:${plan}:${cycle}`] = { title: offer.title, percent: offer.percent, months: offer.durationMonths,
          standardPriceNgn, priceNgn: discountedPrice(standardPriceNgn, offer.percent),
          remainingCycles: used ? used.maxCycles - used.paidCycles : discountCycles(offer.durationMonths, cycle) };
      }
    }
  }
  return quotes;
}
