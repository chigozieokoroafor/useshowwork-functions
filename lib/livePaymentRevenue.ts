import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { paymentRevenueSchema } from "@/lib/paymentRevenueSchema";

export const legacyLivePaymentsSql = Prisma.sql`
 SELECT p."creatorId",p."amountNgn"::numeric,p."createdAt",
 CASE WHEN p.type::text LIKE 'PORTFOLIO_%' THEN 'portfolio'
 WHEN p.type::text LIKE 'AI_ASSISTANT_%' THEN 'ai'
 WHEN p.type::text LIKE 'CALENDAR_%' OR p.type::text LIKE 'CONTENT_WORKSPACE_%' THEN 'workspace'
 ELSE 'delivery' END AS tool
 FROM "PaymentRecord" p WHERE p."revenueStatus"='LIVE'
 AND p."paystackReference" IS NOT NULL AND p."paystackReference" NOT LIKE 'RECONCILED-%'`;

// Real provider receipts are authoritative. Legacy verified records remain visible until backfilled.
// A reference present in both sources is counted once, and deleted accounts retain their revenue.
export const livePaymentsSql = Prisma.sql`
 SELECT "creatorId", "amountKobo"::numeric / 100 AS "amountNgn", "paidAt" AS "createdAt", tool
 FROM "PaymentRevenueReceipt" WHERE currency='NGN'
 UNION ALL
 SELECT p."creatorId",p."amountNgn"::numeric,p."createdAt",
 CASE WHEN p.type::text LIKE 'PORTFOLIO_%' THEN 'portfolio'
 WHEN p.type::text LIKE 'AI_ASSISTANT_%' THEN 'ai'
 WHEN p.type::text LIKE 'CALENDAR_%' OR p.type::text LIKE 'CONTENT_WORKSPACE_%' THEN 'workspace'
 ELSE 'delivery' END AS tool
 FROM "PaymentRecord" p WHERE p."revenueStatus"='LIVE'
 AND p."paystackReference" IS NOT NULL AND p."paystackReference" NOT LIKE 'RECONCILED-%'
 AND NOT EXISTS(SELECT 1 FROM "PaymentRevenueReceipt" r WHERE r.reference=p."paystackReference")`;
export async function getLivePaymentsSql() {
  return (await paymentRevenueSchema()).receipts
    ? livePaymentsSql
    : legacyLivePaymentsSql;
}
export async function getLiveRevenueTotals({
  from,
  to,
  tool,
  creatorId,
}: { from?: Date; to?: Date; tool?: string; creatorId?: string } = {}) {
  const payments = await getLivePaymentsSql();
  const filters = [
    Prisma.sql`true`,
    ...(from ? [Prisma.sql`"createdAt">=${from}`] : []),
    ...(to ? [Prisma.sql`"createdAt"<${to}`] : []),
    ...(tool ? [Prisma.sql`tool=${tool}`] : []),
    ...(creatorId ? [Prisma.sql`"creatorId"=${creatorId}`] : []),
  ];
  return (
    await db.$queryRaw<{ amountNgn: number; count: number; payers: number }[]>(
      Prisma.sql`WITH payments AS (${payments}) SELECT coalesce(sum("amountNgn"),0)::float AS "amountNgn",count(*)::int AS count,count(DISTINCT "creatorId")::int AS payers FROM payments WHERE ${Prisma.join(filters, " AND ")}`,
    )
  )[0];
}
