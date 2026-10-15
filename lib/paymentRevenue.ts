/** Only a successful, matching live Paystack charge is real revenue. */
export function classifyPaymentRevenue(
  payment: { paystackReference?: string | null; amountNgn: number },
  verification: {
    status?: boolean;
    code?: string;
    data?: {
      domain?: string;
      status?: string;
      reference?: string;
      currency?: string;
      amount?: number;
    };
  } | null,
): {
  revenueStatus: "LIVE" | "EXCLUDED" | "UNVERIFIED";
  revenueReason: string | null;
} {
  if (!payment.paystackReference)
    return {
      revenueStatus: "EXCLUDED",
      revenueReason: "No payment provider reference",
    };
  if (verification?.code === "transaction_not_found")
    return {
      revenueStatus: "UNVERIFIED",
      revenueReason: "Reference not found in configured Paystack integration",
    };
  if (!verification?.status || !verification.data)
    return {
      revenueStatus: "UNVERIFIED",
      revenueReason: "Provider verification unavailable",
    };
  const charge = verification.data;
  // Work in integer kobo; decimal NGN can otherwise round differently in JavaScript.
  const expectedAmountKobo = Math.round(payment.amountNgn * 100);
  if (charge.domain === "test")
    return {
      revenueStatus: "EXCLUDED",
      revenueReason: "Paystack test transaction",
    };
  if (
    charge.reference !== payment.paystackReference ||
    charge.status !== "success" ||
    charge.currency !== "NGN" ||
    !Number.isSafeInteger(expectedAmountKobo) ||
    Math.abs(payment.amountNgn * 100 - expectedAmountKobo) > 0.000001 ||
    charge.amount !== expectedAmountKobo ||
    payment.amountNgn <= 0
  ) {
    return {
      revenueStatus: "EXCLUDED",
      revenueReason:
        "Charge reference, status, currency or amount does not match",
    };
  }
  if (charge.domain !== "live")
    return {
      revenueStatus: "UNVERIFIED",
      revenueReason: "Live payment environment not confirmed",
    };
  return { revenueStatus: "LIVE", revenueReason: null };
}
