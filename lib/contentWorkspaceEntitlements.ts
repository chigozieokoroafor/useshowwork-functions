/**
 * Content Workspace subscription entitlements.
 *
 * IMPORTANT:
 * - This is ONLY for the Content Workspace / Calendar product.
 * - Portfolio billing uses lib/subscriptionTiers.ts and is completely separate.
 * - AI is included in these plans; there is no separate AI subscription.
 *
 * Keep all Content Workspace limits here so plan changes can be made
 * without rewriting billing or feature-enforcement logic.
 */

export type ContentWorkspacePlan = "CREATOR" | "STUDIO" | "UNLIMITED";

export type ContentWorkspaceBillingCycle = "MONTHLY" | "ANNUAL";

export interface ContentWorkspaceEntitlements {
  /**
   * Maximum number of active client workspaces the account can have.
   */
  activeWorkspaces: number;

  /**
   * Maximum number of collaborators across the account.
   *
   * The workspace owner/manager is not counted as a collaborator.
   */
  collaborators: number;

  /**
   * Total storage allowance in bytes.
   */
  storageBytes: number;

  /**
   * Maximum AI content generations during one billing cycle.
   */
  aiGenerations: number;

  /**
   * Maximum AI regenerations during one monthly cycle. Regenerations also count toward the shared generation allowance.
   */
  aiRegenerations: number;
}

export type ContentWorkspaceFeature =
  | "advancedAnalytics" | "performanceRecommendations" | "socialInbox"
  | "leadManagement" | "advancedTeamPermissions" | "aiInboxReplies"
  | "aiAutoReplies" | "prioritySupport";

export const CONTENT_WORKSPACE_FEATURES: Record<ContentWorkspaceFeature, { name: string; minimumPlan: ContentWorkspacePlan }> = {
  advancedAnalytics: { name: "Advanced analytics", minimumPlan: "STUDIO" },
  performanceRecommendations: { name: "AI performance recommendations / performance-informed planning", minimumPlan: "STUDIO" },
  socialInbox: { name: "Social Inbox", minimumPlan: "STUDIO" },
  leadManagement: { name: "Lead management", minimumPlan: "STUDIO" },
  advancedTeamPermissions: { name: "Advanced team permissions", minimumPlan: "STUDIO" },
  aiInboxReplies: { name: "AI inbox reply drafting", minimumPlan: "STUDIO" },
  aiAutoReplies: { name: "AI automatic inbox replies (opt-in)", minimumPlan: "UNLIMITED" },
  prioritySupport: { name: "Priority support", minimumPlan: "UNLIMITED" },
};

export function planIncludesWorkspaceFeature(plan: ContentWorkspacePlan | null, feature: ContentWorkspaceFeature): boolean {
  return !!plan && CONTENT_WORKSPACE_PLAN_ORDER.indexOf(plan) >= CONTENT_WORKSPACE_PLAN_ORDER.indexOf(CONTENT_WORKSPACE_FEATURES[feature].minimumPlan);
}

export function workspaceFeatureUpgradeMessage(feature: ContentWorkspaceFeature): string {
  const config = CONTENT_WORKSPACE_FEATURES[feature];
  return `Upgrade to ${CONTENT_WORKSPACE_PLANS[config.minimumPlan].name} to use ${config.name}. Your existing data is preserved.`;
}

export function getContentWorkspaceFeatureList(plan: ContentWorkspacePlan): string[] {
  return ["Content planning & calendar", "AI content generation", "Client approvals", "Social publishing", "Basic analytics",
    ...Object.entries(CONTENT_WORKSPACE_FEATURES).filter(([feature]) => planIncludesWorkspaceFeature(plan, feature as ContentWorkspaceFeature)).map(([, config]) => config.name)];
}

export interface ContentWorkspacePlanConfig
  extends ContentWorkspaceEntitlements {
  name: string;
  priceNgnMonthly: number;
  priceNgnAnnual: number;
  planCodeEnv: {
    MONTHLY: string;
    ANNUAL: string;
  };
}

/**
 * Storage is expressed in decimal GB for customer-facing plan
 * allowances:
 *
 * 5 GB  = 5,000,000,000 bytes
 * 50 GB = 50,000,000,000 bytes
 *
 * Using bytes internally gives us accurate enforcement against
 * actual uploaded media rather than relying on rounded GB values.
 */
export const STORAGE_GB = {
  CREATOR: 5,
  STUDIO: 50,
  UNLIMITED: 200,
} as const;

const GB = 1_000_000_000;

export const CONTENT_WORKSPACE_PLANS: Record<
  ContentWorkspacePlan,
  ContentWorkspacePlanConfig
> = {
  CREATOR: {
    name: "Creator",

    priceNgnMonthly: 4_900,
    priceNgnAnnual: 55_860,

    activeWorkspaces: 5,
    collaborators: 3,
    storageBytes: STORAGE_GB.CREATOR * GB,
    aiGenerations: 100,
    aiRegenerations: 100,

    planCodeEnv: {
      MONTHLY: "PAYSTACK_CONTENT_WORKSPACE_CREATOR_MONTHLY_PLAN_CODE",
      ANNUAL: "PAYSTACK_CONTENT_WORKSPACE_CREATOR_ANNUAL_PLAN_CODE",
    },
  },

  STUDIO: {
    name: "Studio",

    priceNgnMonthly: 29_900,
    priceNgnAnnual: 340_860,

    activeWorkspaces: 15,
    collaborators: 15,
    storageBytes: STORAGE_GB.STUDIO * GB,
    aiGenerations: 500,
    aiRegenerations: 500,

    planCodeEnv: {
      MONTHLY: "PAYSTACK_CONTENT_WORKSPACE_STUDIO_MONTHLY_PLAN_CODE",
      ANNUAL: "PAYSTACK_CONTENT_WORKSPACE_STUDIO_ANNUAL_PLAN_CODE",
    },
  },
  UNLIMITED: {
    name: "Agency",
    priceNgnMonthly: 59_900,
    priceNgnAnnual: 682_860,
    // Finite sentinel preserves numeric limits through JSON serialization.
    activeWorkspaces: Number.MAX_SAFE_INTEGER,
    collaborators: Number.MAX_SAFE_INTEGER,
    storageBytes: STORAGE_GB.UNLIMITED * GB,
    aiGenerations: 2_000,
    aiRegenerations: 2_000,
    planCodeEnv: {
      MONTHLY: "PAYSTACK_CONTENT_WORKSPACE_UNLIMITED_MONTHLY_PLAN_CODE",
      ANNUAL: "PAYSTACK_CONTENT_WORKSPACE_UNLIMITED_ANNUAL_PLAN_CODE",
    },
  },
};

export function formatWorkspaceLimit(limit: number): string {
  return limit === Number.MAX_SAFE_INTEGER ? "Unlimited" : String(limit);
}

export const CONTENT_WORKSPACE_PLAN_ORDER: ContentWorkspacePlan[] = [
  "CREATOR",
  "STUDIO",
  "UNLIMITED",
];

export const CONTENT_WORKSPACE_PLAN_DISPLAY_NAME: Record<
  ContentWorkspacePlan,
  string
> = {
  CREATOR: "Creator",
  STUDIO: "Studio",
  UNLIMITED: "Agency",
};

/**
 * The Content Workspace trial is intentionally short.
 *
 * No payment method is required to start the trial.
 */
export const CONTENT_WORKSPACE_TRIAL_DAYS = 7;

/**
 * Returns the configured entitlements for a plan.
 */
export function getContentWorkspaceEntitlements(
  plan: ContentWorkspacePlan
): ContentWorkspaceEntitlements {
  const config = CONTENT_WORKSPACE_PLANS[plan];

  return {
    activeWorkspaces: config.activeWorkspaces,
    collaborators: config.collaborators,
    storageBytes: config.storageBytes,
    aiGenerations: config.aiGenerations,
    aiRegenerations: config.aiRegenerations,
  };
}

/**
 * Returns the monthly price for a plan.
 */
export function getContentWorkspaceMonthlyPrice(
  plan: ContentWorkspacePlan
): number {
  return CONTENT_WORKSPACE_PLANS[plan].priceNgnMonthly;
}

/**
 * Returns the annual price for a plan.
 */
export function getContentWorkspaceAnnualPrice(
  plan: ContentWorkspacePlan
): number {
  return CONTENT_WORKSPACE_PLANS[plan].priceNgnAnnual;
}

/**
 * Returns the Paystack plan-code environment variable name.
 *
 * The actual environment variable is intentionally resolved only when
 * checkout is started, so missing billing configuration cannot break
 * unrelated application code.
 */
export function getContentWorkspacePlanCodeEnv(
  plan: ContentWorkspacePlan,
  cycle: ContentWorkspaceBillingCycle
): string {
  return CONTENT_WORKSPACE_PLANS[plan].planCodeEnv[cycle];
}

/**
 * Returns the Paystack plan code configured for a plan/cycle.
 */
export function getContentWorkspacePlanCode(
  plan: ContentWorkspacePlan,
  cycle: ContentWorkspaceBillingCycle
): string {
  const envVar = getContentWorkspacePlanCodeEnv(plan, cycle);
  const planCode = process.env[envVar];

  if (!planCode) {
    throw new Error(`Missing environment variable ${envVar}`);
  }

  return planCode;
}

/**
 * Converts a Paystack plan code back into the Content Workspace plan
 * and billing cycle.
 *
 * Useful for webhook processing.
 */
export function contentWorkspacePlanFromPaystackPlanCode(
  planCode: string
): {
  plan: ContentWorkspacePlan;
  cycle: ContentWorkspaceBillingCycle;
} | null {
  for (const plan of CONTENT_WORKSPACE_PLAN_ORDER) {
    const config = CONTENT_WORKSPACE_PLANS[plan];

    if ([process.env[config.planCodeEnv.MONTHLY], process.env[`${config.planCodeEnv.MONTHLY}_LEGACY`]].includes(planCode)) {
      return {
        plan,
        cycle: "MONTHLY",
      };
    }

    if ([process.env[config.planCodeEnv.ANNUAL], process.env[`${config.planCodeEnv.ANNUAL}_LEGACY`]].includes(planCode)) {
      return {
        plan,
        cycle: "ANNUAL",
      };
    }
  }

  return null;
}

/**
 * Returns the next available paid plan.
 *
 * Creator → Studio → Agency
 * Agency → null
 */
export function getNextContentWorkspacePlan(
  plan: ContentWorkspacePlan
): ContentWorkspacePlan | null {
  const index = CONTENT_WORKSPACE_PLAN_ORDER.indexOf(plan);

  if (index === -1 || index === CONTENT_WORKSPACE_PLAN_ORDER.length - 1) {
    return null;
  }

  return CONTENT_WORKSPACE_PLAN_ORDER[index + 1];
}

/**
 * Returns whether a plan is higher than another plan.
 */
export function isHigherContentWorkspacePlan(
  candidate: ContentWorkspacePlan,
  current: ContentWorkspacePlan
): boolean {
  return (
    CONTENT_WORKSPACE_PLAN_ORDER.indexOf(candidate) >
    CONTENT_WORKSPACE_PLAN_ORDER.indexOf(current)
  );
}