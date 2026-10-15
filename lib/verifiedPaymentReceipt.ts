import { classifyPaymentRevenue } from "@/lib/paymentRevenue";
export type VerifiedCharge = {
  status?: boolean;
  data?: {
    status?: string;
    reference?: string;
    currency?: string;
    domain?: string;
    amount?: number;
    paid_at?: string;
    paidAt?: string;
    customer?: { email?: string; customer_code?: string };
    plan?: unknown;
    plan_object?: { plan_code?: unknown } | null;
    metadata?: unknown;
    subscription?: { subscription_code?: string };
  };
};
export function verifiedPaymentReceipt(
  reference: string,
  verification: VerifiedCharge,
) {
  const charge = verification.data;
  const amount = charge?.amount;
  if (
    !verification.status ||
    charge?.status !== "success" ||
    charge.reference !== reference ||
    charge.currency !== "NGN" ||
    !["live", "test"].includes(charge.domain ?? "") ||
    !Number.isSafeInteger(amount) ||
    amount! <= 0
  ) {
    throw new Error(
      "Payment verification does not match a successful NGN charge",
    );
  }
  const paidAt = new Date(charge.paid_at ?? charge.paidAt ?? "");
  if (!Number.isFinite(paidAt.getTime()))
    throw new Error("Payment has no valid paid date");
  const amountNgn = amount! / 100;
  return {
    amountNgn,
    createdAt: paidAt,
    ...classifyPaymentRevenue(
      { paystackReference: reference, amountNgn },
      verification,
    ),
  };
}
