import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed, nativePolicyExecutionAllowed, nativePolicyExecutionRoot } from "@/lib/publishing/applicationBoundary";
import { db } from "@/lib/db";
import { fetchCustomerSubscriptions } from "@/lib/paystack";

// Recover missing or stale renewal dates from the account's exact subscription.
export async function syncContentWorkspaceRenewal(creatorId: string): Promise<Date | null> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { if (!nativePolicyExecutionAllowed("lib/syncContentWorkspaceRenewal.ts#syncContentWorkspaceRenewal@5") || nativePolicyExecutionRoot()==="app/dashboard/billing/page.tsx#BillingPage@23") { return await invokePublishingEntrypoint<Date|null>("lib/syncContentWorkspaceRenewal.ts#syncContentWorkspaceRenewal@5",[creatorId]); } } /* end-canonical-integration-boundary */

  const account = await db.creator.findUnique({
    where: { id: creatorId },
    select: {
      contentWorkspaceBillingStatus: true,
      contentWorkspacePaystackCustomerCode: true,
      contentWorkspacePaystackSubscriptionCode: true,
      contentWorkspaceSubscriptionRenewsAt: true,
    },
  });
  if (!account) return null;
  const stored = account.contentWorkspaceSubscriptionRenewsAt;
  if (account.contentWorkspaceBillingStatus !== "ACTIVE" || !account.contentWorkspacePaystackCustomerCode || !account.contentWorkspacePaystackSubscriptionCode) return stored;
  try {
    const result = await fetchCustomerSubscriptions(account.contentWorkspacePaystackCustomerCode);
    const subscription = result.data?.find((item: { subscription_code: string }) => item.subscription_code === account.contentWorkspacePaystackSubscriptionCode);
    const nextDate = subscription?.next_payment_date ? new Date(subscription.next_payment_date) : null;
    if (nextDate && Number.isFinite(nextDate.getTime())) {
      if (stored?.getTime() !== nextDate.getTime()) {
        await db.creator.update({ where: { id: creatorId }, data: { contentWorkspaceSubscriptionRenewsAt: nextDate } });
      }
      return nextDate;
    }
  } catch (error) {
    console.error("Could not refresh Content Workspace renewal date", error);
  }
  return stored;
}
