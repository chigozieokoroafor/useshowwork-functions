import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
export type AdminPaymentRecord = {
  id: string;
  creatorId: string;
  amountNgn: number;
  type: string;
  tier: string | null;
  cycle: string | null;
  portfolioId: string | null;
  calendarId: string | null;
  paystackReference: string | null;
  createdAt: Date;
};
/** Admin history must remain readable during enum migrations and development hot reloads. */
export async function getAdminPaymentHistory({
  creatorId,
  limit = 500,
}: { creatorId?: string; limit?: number } = {}) {
  const safeLimit =
    Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 500;
  return db.$queryRaw<AdminPaymentRecord[]>(Prisma.sql`
    SELECT id,"creatorId","amountNgn",type::text AS type,tier::text AS tier,cycle::text AS cycle,
      "portfolioId","calendarId","paystackReference","createdAt"
    FROM "PaymentRecord" WHERE "revenueStatus"='LIVE'
      ${creatorId ? Prisma.sql`AND "creatorId"=${creatorId}` : Prisma.empty}
    ORDER BY "createdAt" DESC,id DESC LIMIT ${safeLimit}
  `);
}
