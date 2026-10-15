import { TIERS, type PaidTier, type BillingCycle } from "@/lib/subscriptionTiers";
import { CONTENT_WORKSPACE_PLANS, type ContentWorkspacePlan } from "@/lib/contentWorkspaceEntitlements";

export type BillingProduct = "DELIVERY" | "CONTENT_WORKSPACE";
export type OfferRule = {
  id: string; title: string; product: string; deliveryTier: string | null;
  workspacePlan: string | null; billingCycle: string | null;
  percent: number; durationMonths: number; audience: string;
  availableUntil: Date | null; revokedAt: Date | null; createdAt: Date;
};
export function addCalendarMonths(date: Date, months: number): Date {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}
export function priceForProduct(product: BillingProduct, plan: string, cycle: BillingCycle): number {
  const config = product === "DELIVERY" ? TIERS[plan as PaidTier] : CONTENT_WORKSPACE_PLANS[plan as ContentWorkspacePlan];
  if (!config) throw new Error("Invalid product plan");
  return cycle === "ANNUAL" ? config.priceNgnAnnual : config.priceNgnMonthly;
}
export function offerMatches(offer: OfferRule, product: BillingProduct, plan: string, cycle: BillingCycle, now = new Date()): boolean {
  const selectedPlan = product === "DELIVERY" ? offer.deliveryTier : offer.workspacePlan;
  return !offer.revokedAt && (!offer.availableUntil || offer.availableUntil > now) &&
    (offer.product === "BOTH" || offer.product === product) &&
    (!selectedPlan || selectedPlan === plan) && (!offer.billingCycle || offer.billingCycle === cycle) &&
    // Annual commitments must fit whole years. No silent rounding of a three-month offer to a year.
    (cycle === "MONTHLY" || offer.durationMonths % 12 === 0);
}
export function chooseOffer(offers: OfferRule[], product: BillingProduct, plan: string, cycle: BillingCycle, now = new Date()): OfferRule | null {
  const specificity = (o: OfferRule) => (o.audience === "SELECTED" ? 8 : 0) +
    ((product === "DELIVERY" ? o.deliveryTier : o.workspacePlan) ? 4 : 0) +
    (o.billingCycle ? 2 : 0) + (o.product === product ? 1 : 0);
  return offers.filter(o => o.percent < 100 && offerMatches(o, product, plan, cycle, now)).sort((a, b) =>
    specificity(b) - specificity(a) || b.percent - a.percent || b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)
  )[0] ?? null;
}
export function discountedPrice(standardNgn: number, percent: number): number {
  return Math.round(standardNgn * (100 - percent) / 100);
}
export function discountCycles(months: number, cycle: BillingCycle): number {
  if (!Number.isInteger(months) || months < 1 || months > 36 || (cycle === "ANNUAL" && months % 12 !== 0)) throw new Error("Invalid discount duration for billing cycle");
  return cycle === "ANNUAL" ? months / 12 : months;
}
