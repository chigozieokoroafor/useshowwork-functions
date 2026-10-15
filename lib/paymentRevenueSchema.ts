import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/** Detect rollout readiness without querying a relation that may not exist yet. */
export async function paymentRevenueSchema() {
  return (
    await db.$queryRaw<
      { receipts: boolean; state: boolean; issues: boolean }[]
    >(Prisma.sql`
    SELECT to_regclass('"PaymentRevenueReceipt"') IS NOT NULL AS receipts,
           to_regclass('"PaymentRevenueSyncState"') IS NOT NULL AS state,
           to_regclass('"PaymentRevenueSyncIssue"') IS NOT NULL AS issues
  `)
  )[0];
}
