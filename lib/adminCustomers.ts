import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { paymentRevenueSchema } from "@/lib/paymentRevenueSchema";
import type { CustomerFilters } from "@/lib/adminCustomerFilters";
export type CustomerRow = {
  key: string;
  creatorId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  accountType: string | null;
  joinedAt: Date | null;
  deactivated: boolean;
  product: string;
  status: string;
  plan: string | null;
  cycle: string | null;
  nextBillingAt: Date | null;
  firstPaidAt: Date | null;
  lastPaidAt: Date | null;
  lifetimePayments: number;
  lifetimeRevenue: number;
  periodPayments: number;
  periodRevenue: number;
  subscriptionPayments: number;
  oneTimePayments: number;
  portfolioActiveCount: number;
  portfolioExpiredCount: number;
  recentPayments: {
    reference: string;
    amountNgn: number;
    paidAt: string;
    type: string;
  }[];
};
const legacyPayments = Prisma.sql`SELECT p."creatorId",p."paystackReference" AS reference,p."amountNgn"::numeric AS amount,p."createdAt" AS at,p.type::text AS type,
 CASE WHEN p.type::text LIKE 'PORTFOLIO_%' THEN 'portfolio' WHEN p.type::text LIKE 'AI_ASSISTANT_%' THEN 'ai' WHEN p.type::text LIKE 'CALENDAR_%' OR p.type::text LIKE 'CONTENT_WORKSPACE_%' THEN 'workspace' ELSE 'delivery' END AS product
 FROM "PaymentRecord" p WHERE p."revenueStatus"='LIVE' AND p."paystackReference" IS NOT NULL AND p."paystackReference" NOT LIKE 'RECONCILED-%'`;
export async function customerCte(f: CustomerFilters, now = new Date()) {
  const schema = await paymentRevenueSchema();
  const payments = schema.receipts
    ? Prisma.sql`
 SELECT r."creatorId",r.reference,r."amountKobo"::numeric/100 AS amount,r."paidAt" AS at,
 coalesce(p.type::text,CASE WHEN r.reference LIKE 'showwork_sub_%' THEN 'SUBSCRIPTION_INITIAL' WHEN r.reference LIKE 'spotlite_%' THEN 'PROJECT_ONE_TIME' WHEN r.reference LIKE 'showwork_portfolio_setup_%' THEN 'PORTFOLIO_ONE_TIME' ELSE 'UNATTRIBUTED' END) AS type,r.tool AS product
 FROM "PaymentRevenueReceipt" r LEFT JOIN "PaymentRecord" p ON p."paystackReference"=r.reference WHERE r.currency='NGN'
 UNION ALL SELECT * FROM (${legacyPayments}) p WHERE NOT EXISTS(SELECT 1 FROM "PaymentRevenueReceipt" r WHERE r.reference=p.reference)`
    : legacyPayments;
  const search = f.q.replace(/[\\%_]/g, "\\$&");
  return Prisma.sql`WITH payments AS (${payments}), keyed AS (
 SELECT *,coalesce("creatorId",'receipt:'||reference) AS key FROM payments), rollup AS (
 SELECT key,product,max("creatorId") AS "creatorId",min(at) AS "firstPaidAt",max(at) AS "lastPaidAt",count(*)::int AS "lifetimePayments",sum(amount)::float AS "lifetimeRevenue",
 count(*) FILTER(WHERE (${f.from}::timestamptz IS NULL OR at>=${f.from}) AND (${f.to}::timestamptz IS NULL OR at<${f.to}))::int AS "periodPayments",
 coalesce(sum(amount) FILTER(WHERE (${f.from}::timestamptz IS NULL OR at>=${f.from}) AND (${f.to}::timestamptz IS NULL OR at<${f.to})),0)::float AS "periodRevenue",
 count(*) FILTER(WHERE type LIKE '%SUBSCRIPTION%')::int AS "subscriptionPayments",count(*) FILTER(WHERE type IN ('PROJECT_ONE_TIME','PORTFOLIO_ONE_TIME'))::int AS "oneTimePayments"
 FROM keyed GROUP BY key,product), portfolios AS (
 SELECT "creatorId",bool_or("billingStatus"='ACTIVE') AS active,bool_or("billingStatus"='OFFLINE') AS expired,count(*) FILTER(WHERE "billingStatus"='ACTIVE')::int AS "activeCount",count(*) FILTER(WHERE "billingStatus"='OFFLINE')::int AS "expiredCount",min("subscriptionRenewsAt") FILTER(WHERE "billingStatus"='ACTIVE') AS renewal
 FROM "Portfolio" po WHERE "paystackSubscriptionCode" IS NOT NULL OR "subscriptionRenewsAt" IS NOT NULL OR ("billingStatus"='ACTIVE' AND EXISTS(SELECT 1 FROM payments p WHERE p.reference=po."pendingSubscriptionRef" AND p.type LIKE '%SUBSCRIPTION%')) GROUP BY "creatorId"), memberships AS (
 SELECT c.id AS key,'delivery' AS product FROM "Creator" c WHERE c."subscriptionActive" OR c."subscriptionTier"::text<>'FREE' OR c."deliveryCompedTier" IS NOT NULL
 UNION SELECT c.id,'workspace' FROM "Creator" c WHERE c."contentWorkspaceBillingStatus" IN ('ACTIVE','OFFLINE','TRIAL') OR c."calendarBillingStatus" IN ('ACTIVE','OFFLINE','TRIAL') OR c."isComped" OR c."workspaceCompedPlan" IS NOT NULL
 UNION SELECT c.id,'ai' FROM "Creator" c WHERE c."aiAssistantBillingStatus"::text<>'PENDING_SETUP'
 UNION SELECT "creatorId",'portfolio' FROM portfolios), keys AS (SELECT key,product FROM rollup UNION SELECT key,product FROM memberships), base AS (
 SELECT k.key,c.id AS "creatorId",c.name,c.email,c.phone,c."companyName",c."accountType"::text AS "accountType",c."createdAt" AS "joinedAt",coalesce(c."isDeactivated",false) AS deactivated,k.product,
 CASE WHEN c.id IS NULL THEN 'archived'
 WHEN k.product='delivery' AND c."subscriptionActive" THEN 'active'
 WHEN k.product='delivery' AND c."deliveryCompedTier" IS NOT NULL AND c."deliveryCompedUntil">${now} THEN 'complimentary'
 WHEN k.product='workspace' AND (c."contentWorkspaceBillingStatus"='ACTIVE' OR c."calendarBillingStatus"='ACTIVE') THEN 'active'
 WHEN k.product='workspace' AND ((c."isComped" AND (c."compedUntil" IS NULL OR c."compedUntil">${now})) OR (c."workspaceCompedPlan" IS NOT NULL AND c."workspaceCompedUntil">${now})) THEN 'complimentary'
 WHEN k.product='workspace' AND (c."contentWorkspaceTrialEndsAt">${now} AND c."contentWorkspaceBillingStatus"='TRIAL' OR c."calendarTrialEndsAt">${now} AND c."calendarBillingStatus"='TRIAL') THEN 'trial'
 WHEN k.product='ai' AND c."aiAssistantBillingStatus"='ACTIVE' THEN 'active'
 WHEN k.product='ai' AND c."aiAssistantBillingStatus"='TRIAL' AND c."aiAssistantTrialEndsAt">${now} THEN 'trial'
 WHEN k.product='portfolio' AND po.active AND po.expired THEN 'mixed'
 WHEN k.product='portfolio' AND po.active THEN 'active'
 WHEN coalesce(r."subscriptionPayments",0)>0 OR (k.product='delivery' AND (c."subscriptionTier"::text<>'FREE' OR c."deliveryCompedTier" IS NOT NULL)) OR (k.product='workspace' AND (c."contentWorkspaceBillingStatus"='OFFLINE' OR c."calendarBillingStatus"='OFFLINE' OR c."contentWorkspaceBillingStatus"='TRIAL' OR c."calendarBillingStatus"='TRIAL' OR c."isComped" OR c."workspaceCompedPlan" IS NOT NULL)) OR (k.product='portfolio' AND po.expired) OR (k.product='ai' AND c."aiAssistantBillingStatus" IN ('OFFLINE','TRIAL')) THEN 'expired'
 WHEN coalesce(r."oneTimePayments",0)>0 THEN 'one_time' ELSE 'pending' END AS status,
 CASE k.product WHEN 'delivery' THEN CASE WHEN c."subscriptionActive" THEN c."subscriptionTier"::text ELSE coalesce(c."deliveryCompedTier"::text,nullif(c."subscriptionTier"::text,'FREE')) END WHEN 'workspace' THEN coalesce(c."contentWorkspacePlan"::text,c."workspaceCompedPlan"::text,c."calendarAccountType"::text,CASE WHEN c."isComped" THEN 'STUDIO' END) WHEN 'portfolio' THEN CASE WHEN po.active OR po.expired THEN 'Additional portfolio' END WHEN 'ai' THEN 'Premium add-on' END AS plan,
 CASE k.product WHEN 'delivery' THEN c."subscriptionCycle"::text WHEN 'workspace' THEN c."contentWorkspaceBillingCycle"::text WHEN 'portfolio' THEN NULL::text WHEN 'ai' THEN 'MONTHLY' END AS cycle,
 CASE k.product WHEN 'delivery' THEN CASE WHEN c."subscriptionActive" THEN c."subscriptionRenewsAt" WHEN c."deliveryCompedTier" IS NOT NULL THEN c."deliveryCompedUntil" ELSE c."subscriptionRenewsAt" END WHEN 'workspace' THEN CASE WHEN c."contentWorkspaceBillingStatus"='ACTIVE' OR c."calendarBillingStatus"='ACTIVE' THEN coalesce(c."contentWorkspaceSubscriptionRenewsAt",c."calendarSubscriptionRenewsAt") WHEN c."workspaceCompedPlan" IS NOT NULL AND c."workspaceCompedUntil">${now} THEN c."workspaceCompedUntil" WHEN c."isComped" AND (c."compedUntil" IS NULL OR c."compedUntil">${now}) THEN c."compedUntil" WHEN c."contentWorkspaceBillingStatus"='TRIAL' OR c."calendarBillingStatus"='TRIAL' THEN coalesce(c."contentWorkspaceTrialEndsAt",c."calendarTrialEndsAt") ELSE coalesce(c."contentWorkspaceSubscriptionRenewsAt",c."calendarSubscriptionRenewsAt") END WHEN 'ai' THEN CASE WHEN c."aiAssistantBillingStatus"='TRIAL' THEN c."aiAssistantTrialEndsAt" ELSE c."aiAssistantSubscriptionRenewsAt" END WHEN 'portfolio' THEN po.renewal END AS "nextBillingAt",
 coalesce(po."activeCount",0)::int AS "portfolioActiveCount",coalesce(po."expiredCount",0)::int AS "portfolioExpiredCount",r."firstPaidAt",r."lastPaidAt",coalesce(r."lifetimePayments",0)::int AS "lifetimePayments",coalesce(r."lifetimeRevenue",0)::float AS "lifetimeRevenue",coalesce(r."periodPayments",0)::int AS "periodPayments",coalesce(r."periodRevenue",0)::float AS "periodRevenue",coalesce(r."subscriptionPayments",0)::int AS "subscriptionPayments",coalesce(r."oneTimePayments",0)::int AS "oneTimePayments"
 FROM keys k LEFT JOIN "Creator" c ON c.id=k.key LEFT JOIN rollup r ON r.key=k.key AND r.product=k.product LEFT JOIN portfolios po ON po."creatorId"=c.id), filtered AS (
 SELECT * FROM base b WHERE (${f.product}='all' OR product=${f.product}) AND (${f.status}='all' OR status=${f.status} OR (status='mixed' AND ${f.status} IN ('active','expired')))
 AND (${f.q}='' OR coalesce(name,'') ILIKE ${`%${search}%`} OR coalesce(email,'') ILIKE ${`%${search}%`} OR coalesce("companyName",'') ILIKE ${`%${search}%`} OR coalesce(phone,'') ILIKE ${`%${search}%`} OR key ILIKE ${`%${search}%`})
 AND ((${f.from}::timestamptz IS NULL AND ${f.to}::timestamptz IS NULL) OR (${f.dateBasis}='any' AND "periodPayments">0) OR (${f.dateBasis}='last' AND (${f.from}::timestamptz IS NULL OR "lastPaidAt">=${f.from}) AND (${f.to}::timestamptz IS NULL OR "lastPaidAt"<${f.to}))))`;
}
export async function customerRows(
  cte: Prisma.Sql,
  sort: string,
  limit: number,
  offset: number,
) {
  const order =
    sort === "spend"
      ? Prisma.sql`b."lifetimeRevenue" DESC`
      : sort === "payments"
        ? Prisma.sql`b."lifetimePayments" DESC`
        : sort === "name"
          ? Prisma.sql`lower(coalesce(b.name,b.email,'Archived customer')) ASC`
          : Prisma.sql`b."lastPaidAt" DESC NULLS LAST`;
  return db.$queryRaw<
    CustomerRow[]
  >(Prisma.sql`${cte} SELECT b.*,coalesce(history.rows,'[]'::json) AS "recentPayments" FROM filtered b LEFT JOIN LATERAL (
 SELECT json_agg(x ORDER BY x."paidAt" DESC) AS rows FROM (SELECT reference,amount::float AS "amountNgn",at AT TIME ZONE 'UTC' AS "paidAt",type FROM keyed WHERE key=b.key AND product=b.product ORDER BY at DESC,reference DESC LIMIT 5) x) history ON true ORDER BY ${order},b.key,b.product LIMIT ${limit} OFFSET ${offset}`);
}
export async function getCustomers(f: CustomerFilters) {
  const cte = await customerCte(f);
  const summary = (
    await db.$queryRaw<
      {
        customers: number;
        rows: number;
        active: number;
        expired: number;
        payments: number;
        revenue: number;
      }[]
    >(
      Prisma.sql`${cte} SELECT count(DISTINCT key)::int AS customers,count(*)::int AS rows,count(*) FILTER(WHERE status IN ('active','mixed'))::int AS active,count(*) FILTER(WHERE status IN ('expired','mixed'))::int AS expired,coalesce(sum("periodPayments"),0)::int AS payments,coalesce(sum("periodRevenue"),0)::float AS revenue FROM filtered`,
    )
  )[0];
  const pages = Math.max(1, Math.ceil(summary.rows / 25)),
    page = Math.min(f.page, pages);
  const rows = await customerRows(cte, f.sort, 25, (page - 1) * 25);
  return { rows, summary, page, pages };
}
