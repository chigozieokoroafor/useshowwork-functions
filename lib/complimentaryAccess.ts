import type { PaidTier } from "@/lib/subscriptionTiers";
import type { ContentWorkspacePlan } from "@/lib/contentWorkspaceEntitlements";
export type ComplimentaryAccount = {
  billingComplimentaryGrants?: unknown;
  isComped?: boolean; compedUntil?: Date | null;
  deliveryCompedTier?: string | null; deliveryCompedUntil?: Date | null;
  workspaceCompedPlan?: ContentWorkspacePlan | null; workspaceCompedUntil?: Date | null;
};
function projectedPlan(account: ComplimentaryAccount, product: string, order: string[], now: Date): string | null {
  if (!Array.isArray(account.billingComplimentaryGrants)) return null;
  const grants = account.billingComplimentaryGrants.filter((grant: any) =>
    grant && grant.product === product && order.includes(grant.plan) && new Date(grant.endsAt) > now
  ).sort((a: any, b: any) => order.indexOf(b.plan) - order.indexOf(a.plan));
  return grants[0]?.plan ?? null;
}
export function deliveryComplimentaryTier(account: ComplimentaryAccount, now = new Date()): PaidTier | null {
  const projected = projectedPlan(account, "DELIVERY", ["STARTER", "GROWTH", "UNLIMITED"], now);
  if (projected) return projected as PaidTier;
  return account.deliveryCompedUntil && account.deliveryCompedUntil > now &&
    ["STARTER", "GROWTH", "UNLIMITED"].includes(account.deliveryCompedTier ?? "")
    ? account.deliveryCompedTier as PaidTier : null;
}
export function workspaceComplimentaryPlan(account: ComplimentaryAccount, now = new Date()): ContentWorkspacePlan | null {
  const projected = projectedPlan(account, "CONTENT_WORKSPACE", ["CREATOR", "STUDIO", "UNLIMITED"], now);
  const cached = account.workspaceCompedPlan && account.workspaceCompedUntil && account.workspaceCompedUntil > now ? account.workspaceCompedPlan : null;
  const legacy = account.isComped && (!account.compedUntil || account.compedUntil > now) ? "STUDIO" : null;
  const order = ["CREATOR", "STUDIO", "UNLIMITED"];
  return [projected, cached, legacy].filter((p): p is ContentWorkspacePlan => !!p).sort((a,b) => order.indexOf(b) - order.indexOf(a))[0] ?? null;
}
export function workspaceComplimentaryEndsAt(account: ComplimentaryAccount, now = new Date()): Date | null {
  const plan = workspaceComplimentaryPlan(account, now);
  if (!plan) return null;
  if (plan === "STUDIO" && account.isComped && !account.compedUntil) return null;
  const dates: Date[] = [];
  if (plan === "STUDIO" && account.isComped && account.compedUntil && account.compedUntil > now) dates.push(account.compedUntil);
  if (account.workspaceCompedPlan === plan && account.workspaceCompedUntil && account.workspaceCompedUntil > now) dates.push(account.workspaceCompedUntil);
  if (Array.isArray(account.billingComplimentaryGrants)) for (const grant of account.billingComplimentaryGrants) {
    if (grant.product === "CONTENT_WORKSPACE" && grant.plan === plan && new Date(grant.endsAt) > now) dates.push(new Date(grant.endsAt));
  }
  return dates.sort((a,b) => b.getTime() - a.getTime())[0] ?? null;
}

export function hasDeliveryPaidAccess(account: ComplimentaryAccount & { subscriptionActive: boolean }): boolean {
  return account.subscriptionActive || !!deliveryComplimentaryTier(account);
}

export const complimentaryAccessSelect = {
  billingComplimentaryGrants: true, deliveryCompedTier: true, deliveryCompedUntil: true,
  workspaceCompedPlan: true, workspaceCompedUntil: true,
} as const;

export function deliveryComplimentaryCycleStart(account: ComplimentaryAccount, now = new Date()): Date {
  const plan = deliveryComplimentaryTier(account, now);
  const grants = Array.isArray(account.billingComplimentaryGrants) ? account.billingComplimentaryGrants : [];
  const applicable = grants.filter((g: any) => g.product === "DELIVERY" && g.plan === plan && new Date(g.endsAt) > now && Number.isFinite(new Date(g.startsAt).getTime()));
  applicable.sort((a: any, b: any) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  if (!applicable[0]) return new Date(now.getTime() - 30 * 86400000);
  const start = new Date(applicable[0].startsAt);
  let month = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
  function anniversary(months: number) {
    const value = new Date(start); const day = value.getUTCDate(); value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() + months);
    const last = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate(); value.setUTCDate(Math.min(day, last)); return value;
  }
  if (anniversary(month) > now) month--;
  return anniversary(Math.max(0, month));
}
