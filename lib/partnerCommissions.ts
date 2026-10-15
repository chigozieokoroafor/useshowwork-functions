import { db } from "@/lib/db";

const PARTNER_COMMISSION_PERCENT = 10;
const QUALIFYING_PAYMENT_TYPES = new Set([
  "SUBSCRIPTION_INITIAL",
  "SUBSCRIPTION_RENEWAL",
  "CONTENT_WORKSPACE_SUBSCRIPTION_INITIAL",
  "CONTENT_WORKSPACE_SUBSCRIPTION_RENEWAL",
]);

function addTwelveMonths(date: Date): Date {
  const result = new Date(date);
  // Clamp leap-day anniversaries to February's last day, in UTC.
  const month = result.getUTCMonth();
  result.setUTCFullYear(result.getUTCFullYear() + 1);
  if (result.getUTCMonth() !== month) result.setUTCDate(0);
  return result;
}

type PaymentForCommission = {
  id: string;
  creatorId: string;
  amountNgn: number;
  type: string;
  createdAt: Date;
  revenueStatus?: string;
};

export async function processReferralCommission(
  payment: PaymentForCommission
): Promise<void> {
  if (payment.revenueStatus !== "LIVE" ||
      !QUALIFYING_PAYMENT_TYPES.has(payment.type) ||
      !Number.isSafeInteger(payment.amountNgn) || payment.amountNgn <= 0) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.$transaction(async (tx) => {
        const referral = await tx.referral.findUnique({
          where: { referredCreatorId: payment.creatorId },
          select: { id: true, status: true, startedAt: true, commissionEndsAt: true },
        });
        if (!referral || !["PENDING", "ACTIVE"].includes(referral.status)) return;

        const existing = await tx.referralCommission.findUnique({
          where: { paymentRecordId: payment.id }, select: { id: true },
        });
        if (existing) return;

        if (referral.status === "PENDING") {
          await tx.referral.update({
            where: { id: referral.id },
            data: {
              status: "ACTIVE", startedAt: payment.createdAt,
              commissionEndsAt: addTwelveMonths(payment.createdAt),
            },
          });
        } else if (!referral.startedAt || !referral.commissionEndsAt ||
                   payment.createdAt < referral.startedAt ||
                   payment.createdAt >= referral.commissionEndsAt) {
          return;
        }

        // Stopping new referrals does not cancel existing customers' eligibility.
        await tx.referralCommission.create({
          data: {
            referralId: referral.id, paymentRecordId: payment.id,
            paymentAmountNgn: payment.amountNgn,
            commissionPercent: PARTNER_COMMISSION_PERCENT,
            commissionAmountNgn: Math.floor(payment.amountNgn * PARTNER_COMMISSION_PERCENT / 100),
            status: "PENDING", earnedAt: payment.createdAt,
          },
        });
      }, { isolationLevel: "Serializable" });
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Concurrent payments must re-read the window; duplicate deliveries are harmless.
      if ((code === "P2034" || code === "P2002") && attempt < 2) continue;
      throw error;
    }
  }
}
