import { db } from "@/lib/db";
import type { Prisma, BillingOfferSubscription } from "@prisma/client";
import type { PaidTier } from "@/lib/subscriptionTiers";
import type { ContentWorkspacePlan } from "@/lib/contentWorkspaceEntitlements";
function grantProjection(grants: BillingOfferSubscription[]) {
  function highest(product: string, order: string[]) {
    return grants.filter(g => g.product === product).sort((a,b) =>
      order.indexOf(b.plan) - order.indexOf(a.plan) || b.discountEndsAt!.getTime() - a.discountEndsAt!.getTime()
    )[0];
  }
  const delivery = highest("DELIVERY", ["STARTER", "GROWTH", "UNLIMITED"]);
  const workspace = highest("CONTENT_WORKSPACE", ["CREATOR", "STUDIO", "UNLIMITED"]);
  return {
    billingComplimentaryGrants: grants.map(g => ({ product: g.product, plan: g.plan, startsAt: g.activatedAt!.toISOString(), endsAt: g.discountEndsAt!.toISOString() })),
    deliveryCompedTier: delivery?.plan as PaidTier ?? null,
    deliveryCompedUntil: delivery?.discountEndsAt ?? null,
    workspaceCompedPlan: workspace?.plan as ContentWorkspacePlan ?? null,
    workspaceCompedUntil: workspace?.discountEndsAt ?? null,
  };
}
/** Store all overlaps so a lower grant takes over immediately when a higher one expires. */
export async function refreshComplimentaryGrantsForAccounts(tx: Prisma.TransactionClient, creatorIds: string[]) {
  const grants = await tx.billingOfferSubscription.findMany({ where: {
    creatorId: { in: creatorIds }, status: "COMPLIMENTARY", discountEndsAt: { gt: new Date() }, offer: { revokedAt: null },
  }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const groups = new Map<string, { creatorIds: string[]; data: ReturnType<typeof grantProjection> }>();
  for (const creatorId of creatorIds) {
    const data = grantProjection(grants.filter(g => g.creatorId === creatorId));
    const key = JSON.stringify(data);
    const group = groups.get(key);
    if (group) group.creatorIds.push(creatorId); else groups.set(key, { creatorIds: [creatorId], data });
  }
  for (const group of groups.values()) await tx.creator.updateMany({ where: { id: { in: group.creatorIds } }, data: group.data });
}
export async function refreshComplimentaryGrants(tx: Prisma.TransactionClient, creatorId: string) {
  return refreshComplimentaryGrantsForAccounts(tx, [creatorId]);
}
export async function refreshExpiredComplimentaryGrants() {
  const accounts = await db.creator.findMany({ where: { OR: [
    { deliveryCompedUntil: { lte: new Date() } }, { workspaceCompedUntil: { lte: new Date() } },
  ] }, select: { id: true }, take: 100 });
  if (accounts.length) await db.$transaction(tx => refreshComplimentaryGrantsForAccounts(tx, accounts.map(a => a.id)));
  return accounts.length;
}
