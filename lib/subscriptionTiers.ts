export type Tier = "FREE" | "STARTER" | "GROWTH" | "UNLIMITED";
export type PaidTier = Exclude<Tier, "FREE">;
export type BillingCycle = "MONTHLY" | "ANNUAL";

export const FREE_TIER_LIMIT = 1;

// Annual pricing is 5% off what a full year of monthly billing would
// cost (12 × monthly price). Each cycle needs its own Paystack plan —
// Paystack bills a fixed amount at a fixed interval per plan, so
// "the same plan, just yearly" isn't a single toggle on their side,
// it's a genuinely separate plan with its own plan_code.
export const TIERS: Record<
  PaidTier,
  {
    name: string;
    priceNgnMonthly: number;
    priceNgnAnnual: number;
    limit: number;
    planCodeEnv: { MONTHLY: string; ANNUAL: string };
  }
> = {
  STARTER: {
    name: "Starter",
    priceNgnMonthly: 5900,
    priceNgnAnnual: 67260,
    limit: 5,
    planCodeEnv: {
      MONTHLY: "PAYSTACK_PLAN_CODE_STARTER_MONTHLY",
      ANNUAL: "PAYSTACK_PLAN_CODE_STARTER_ANNUAL",
    },
  },
  GROWTH: {
    name: "Growth",
    priceNgnMonthly: 12500,
    priceNgnAnnual: 142500,
    limit: 20,
    planCodeEnv: {
      MONTHLY: "PAYSTACK_PLAN_CODE_GROWTH_MONTHLY",
      ANNUAL: "PAYSTACK_PLAN_CODE_GROWTH_ANNUAL",
    },
  },
  UNLIMITED: {
    name: "Unlimited",
    priceNgnMonthly: 22500,
    priceNgnAnnual: 256500,
    limit: Infinity,
    planCodeEnv: {
      MONTHLY: "PAYSTACK_PLAN_CODE_UNLIMITED_MONTHLY",
      ANNUAL: "PAYSTACK_PLAN_CODE_UNLIMITED_ANNUAL",
    },
  },
};

export const PAID_TIER_ORDER: PaidTier[] = ["STARTER", "GROWTH", "UNLIMITED"];

export function tierLimit(tier: Tier): number {
  if (tier === "FREE") return FREE_TIER_LIMIT;
  return TIERS[tier].limit;
}

export function priceForTier(tier: PaidTier, cycle: BillingCycle): number {
  return cycle === "ANNUAL" ? TIERS[tier].priceNgnAnnual : TIERS[tier].priceNgnMonthly;
}

export function planCodeForTier(tier: PaidTier, cycle: BillingCycle): string {
  const envVar = TIERS[tier].planCodeEnv[cycle];
  const code = process.env[envVar];
  if (!code) throw new Error(`Missing environment variable ${envVar}`);
  return code;
}

/**
 * Matches a Paystack plan_code back to which tier AND which billing
 * cycle it belongs to — a renewal or subscription.create event could
 * now be on either a monthly or an annual plan, so the old
 * tier-only lookup isn't enough anymore.
 */
export function tierFromPlanCode(planCode: string): { tier: PaidTier; cycle: BillingCycle } | null {
  for (const tier of PAID_TIER_ORDER) {
    if ([process.env[TIERS[tier].planCodeEnv.MONTHLY], process.env[`${TIERS[tier].planCodeEnv.MONTHLY}_LEGACY`]].includes(planCode)) return { tier, cycle: "MONTHLY" };
    if ([process.env[TIERS[tier].planCodeEnv.ANNUAL], process.env[`${TIERS[tier].planCodeEnv.ANNUAL}_LEGACY`]].includes(planCode)) return { tier, cycle: "ANNUAL" };
  }
  return null;
}

// What each tier is called for display — Free isn't in TIERS since it
// has no plan/price, so it gets its own entry here.
export const PLAN_DISPLAY_NAME: Record<Tier, string> = {
  FREE: "Free",
  STARTER: TIERS.STARTER.name,
  GROWTH: TIERS.GROWTH.name,
  UNLIMITED: TIERS.UNLIMITED.name,
};

// The next tier up from wherever someone currently is — lets an upgrade
// prompt name a specific target instead of a generic "upgrade" link.
export const NEXT_TIER: Record<Tier, PaidTier | null> = {
  FREE: "STARTER",
  STARTER: "GROWTH",
  GROWTH: "UNLIMITED",
  UNLIMITED: null,
};