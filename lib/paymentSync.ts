import { paymentRevenueSchema } from "@/lib/paymentRevenueSchema";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { verifyTransaction } from "@/lib/paystack";
import { extractPaystackPlanCode } from "@/lib/paystackPlan";
import { resolveDeliveryPlan, resolveWorkspacePlan } from "@/lib/billingOffers";
import {
  verifiedPaymentReceipt,
  type VerifiedCharge,
} from "@/lib/verifiedPaymentReceipt";
import { processReferralCommission } from "@/lib/partnerCommissions";
import type { Prisma, PaymentType } from "@prisma/client";

function metadataFor(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return metadataFor(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function referenceId(reference: string, prefix: string) {
  return reference.startsWith(prefix)
    ? (reference
        .slice(prefix.length)
        .match(
          /^([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})_/i,
        )?.[1] ?? null)
    : null;
}

/** Every product writes the same verified ledger, keyed by the actual provider reference. */
export async function syncVerifiedPayment(
  reference: string,
  supplied?: VerifiedCharge,
  options: { apply?: boolean; expectedCreatorId?: string } = {},
) {
  const verification = supplied ?? (await verifyTransaction(reference));
  const receipt = verifiedPaymentReceipt(reference, verification);
  const charge = verification.data!;
  const metadata = metadataFor(charge.metadata);
  const planCode = extractPaystackPlanCode(charge);
  const writeProviderReceipt =
    options.apply !== false &&
    receipt.revenueStatus === "LIVE" &&
    (await paymentRevenueSchema()).receipts;
  // The provider ledger is independent of customer records: a deleted account must not erase revenue.
  if (writeProviderReceipt) {
    const key = process.env.PAYSTACK_SECRET_KEY?.trim();
    if (!key?.startsWith("sk_live_"))
      throw new Error("Live receipt requires the live provider integration");
    const guessedTool =
      reference.startsWith("spotlite_") || reference.startsWith("showwork_sub_")
        ? "delivery"
        : reference.startsWith("showwork_portfolio_sub_") ||
            reference.startsWith("showwork_portfolio_setup_")
          ? "portfolio"
          : reference.startsWith("showwork_content_workspace_sub_") ||
              reference.startsWith("showwork_calendar_sub_")
            ? "workspace"
            : reference.startsWith("showwork_ai_assistant_sub_")
              ? "ai"
              : "unattributed";
    const source = {
      integration: `paystack-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
      amountKobo: BigInt(charge.amount!),
      currency: charge.currency!,
      paidAt: receipt.createdAt,
    };
    const historicalIds = [
      stringValue(metadata.creatorId),
      referenceId(reference, "showwork_sub_"),
      referenceId(reference, "showwork_content_workspace_sub_"),
      referenceId(reference, "showwork_ai_assistant_sub_"),
    ].filter((id): id is string => !!id);
    const historicalCreatorId =
      new Set(historicalIds).size === 1 ? historicalIds[0] : undefined;
    await db.paymentRevenueReceipt.upsert({
      where: { reference },
      create: {
        reference,
        tool: guessedTool,
        ...source,
        ...(historicalCreatorId ? { creatorId: historicalCreatorId } : {}),
      },
      update: {
        ...source,
        ...(historicalCreatorId ? { creatorId: historicalCreatorId } : {}),
      },
    });
  }
  if (!Number.isSafeInteger(receipt.amountNgn))
    throw new Error(
      "Live receipt saved; fractional NGN requires ledger attribution review",
    );
  const existing = await db.paymentRecord.findUnique({
    where: { paystackReference: reference },
  });
  const portfolioId =
    stringValue(metadata.portfolioId) ??
    referenceId(reference, "showwork_portfolio_sub_") ??
    referenceId(reference, "showwork_portfolio_setup_");
  const projectId =
    stringValue(metadata.projectId) ?? referenceId(reference, "spotlite_");
  const portfolio = portfolioId
    ? await db.portfolio.findUnique({
        where: { id: portfolioId },
        select: { id: true, creatorId: true },
      })
    : null;
  const project = projectId
    ? await db.project.findUnique({
        where: { id: projectId },
        select: { id: true, creatorId: true },
      })
    : await db.project.findFirst({
        where: { paystackRef: reference },
        select: { id: true, creatorId: true },
      });
  const subscriptionCode = stringValue(charge.subscription?.subscription_code);
  const offer = await db.billingOfferSubscription.findFirst({
    where: {
      OR: [
        { checkoutReference: reference },
        ...(planCode ? [{ paystackPlanCode: planCode }] : []),
        ...(subscriptionCode ? [{ subscriptionCode }] : []),
      ],
    },
  });
  const identityIds = [
    existing?.creatorId,
    project?.creatorId,
    portfolio?.creatorId,
    offer?.creatorId,
    stringValue(metadata.creatorId),
    referenceId(reference, "showwork_sub_"),
    referenceId(reference, "showwork_content_workspace_sub_"),
    referenceId(reference, "showwork_calendar_sub_"),
    referenceId(reference, "showwork_ai_assistant_sub_"),
  ].filter((id): id is string => !!id);
  if (new Set(identityIds).size > 1)
    throw new Error("Payment account identifiers conflict; review required");
  const email = stringValue(charge.customer?.email)?.toLowerCase();
  const creator = identityIds[0]
    ? await db.creator.findUnique({
        where: { id: identityIds[0] },
        select: { id: true, email: true },
      })
    : email
      ? await db.creator.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
          select: { id: true, email: true },
        })
      : null;
  if (!creator) throw new Error("No account matches the verified payment");
  if (options.expectedCreatorId && creator.id !== options.expectedCreatorId)
    throw new Error("Payment belongs to another account");
  // A client may pay a one-time delivery charge; subscriptions must match the account email.
  if (!project && (!email || email !== creator.email.trim().toLowerCase()))
    throw new Error("Payment customer does not match the account");

  let details: {
    type: PaymentType;
    tier?: Prisma.PaymentRecordUncheckedCreateInput["tier"];
    cycle?: Prisma.PaymentRecordUncheckedCreateInput["cycle"];
    contentWorkspacePlan?: Prisma.PaymentRecordUncheckedCreateInput["contentWorkspacePlan"];
    portfolioId?: string;
    calendarId?: string;
  };
  const delivery = planCode
    ? await resolveDeliveryPlan(planCode, creator.id)
    : null;
  const workspace = planCode
    ? await resolveWorkspacePlan(planCode, creator.id)
    : null;
  if ((project || reference.startsWith("spotlite_")) && !planCode)
    details = { type: "PROJECT_ONE_TIME" };
  else if (reference.startsWith("showwork_portfolio_setup_")) {
    details = {
      type: "PORTFOLIO_ONE_TIME",
      ...(portfolio ? { portfolioId: portfolio.id } : {}),
    };
  } else if (
    portfolio ||
    (planCode && planCode === process.env.PAYSTACK_PORTFOLIO_PLAN_CODE)
  ) {
    const owned =
      portfolio ??
      (subscriptionCode
        ? await db.portfolio.findFirst({
            where: {
              creatorId: creator.id,
              paystackSubscriptionCode: subscriptionCode,
            },
            select: { id: true, creatorId: true },
          })
        : null);
    details = {
      type: reference.startsWith("showwork_portfolio_sub_")
        ? "PORTFOLIO_SUBSCRIPTION_INITIAL"
        : "PORTFOLIO_SUBSCRIPTION_RENEWAL",
      ...(owned ? { portfolioId: owned.id } : {}),
    };
  } else if (
    workspace ||
    reference.startsWith(`showwork_content_workspace_sub_${creator.id}_`) ||
    offer?.product === "CONTENT_WORKSPACE"
  ) {
    details = {
      type:
        reference.startsWith("showwork_content_workspace_sub_") ||
        offer?.checkoutReference === reference
          ? "CONTENT_WORKSPACE_SUBSCRIPTION_INITIAL"
          : "CONTENT_WORKSPACE_SUBSCRIPTION_RENEWAL",
      contentWorkspacePlan: workspace?.plan,
      cycle: workspace?.cycle,
    };
  } else if (
    planCode &&
    [
      process.env.PAYSTACK_CALENDAR_INDIVIDUAL_PLAN_CODE,
      process.env.PAYSTACK_CALENDAR_COMPANY_PLAN_CODE,
      process.env.PAYSTACK_CALENDAR_PLAN_CODE,
    ].includes(planCode)
  ) {
    details = {
      type: reference.startsWith("showwork_calendar_sub_")
        ? "CALENDAR_SUBSCRIPTION_INITIAL"
        : "CALENDAR_SUBSCRIPTION_RENEWAL",
    };
  } else if (
    (planCode && planCode === process.env.PAYSTACK_AI_ASSISTANT_PLAN_CODE) ||
    reference.startsWith(`showwork_ai_assistant_sub_${creator.id}_`)
  ) {
    details = {
      type: reference.startsWith("showwork_ai_assistant_sub_")
        ? "AI_ASSISTANT_SUBSCRIPTION_INITIAL"
        : "AI_ASSISTANT_SUBSCRIPTION_RENEWAL",
    };
  } else if (
    delivery ||
    reference.startsWith(`showwork_sub_${creator.id}_`) ||
    offer?.product === "DELIVERY"
  ) {
    details = {
      type:
        reference.startsWith("showwork_sub_") ||
        offer?.checkoutReference === reference
          ? "SUBSCRIPTION_INITIAL"
          : "SUBSCRIPTION_RENEWAL",
      tier: delivery?.tier,
      cycle: delivery?.cycle,
    };
  } else if (existing) {
    details = {
      type: existing.type,
      tier: existing.tier,
      cycle: existing.cycle,
      contentWorkspacePlan: existing.contentWorkspacePlan,
      ...(existing.portfolioId ? { portfolioId: existing.portfolioId } : {}),
      ...(existing.calendarId ? { calendarId: existing.calendarId } : {}),
    };
  } else
    throw new Error(
      "Verified payment product cannot be identified; review required",
    );
  const result = {
    creatorId: creator.id,
    paystackReference: reference,
    ...details,
    ...receipt,
  };
  if (options.apply === false)
    return {
      payment: { ...result, id: existing?.id ?? "preview" },
      action: existing ? "reconcile" : "import",
    };
  const payment = await db.paymentRecord.upsert({
    where: { paystackReference: reference },
    create: result,
    update: { ...details, ...receipt },
  });
  if (writeProviderReceipt) {
    const tool = details.type.startsWith("PORTFOLIO_")
      ? "portfolio"
      : details.type.startsWith("AI_ASSISTANT_")
        ? "ai"
        : details.type.startsWith("CALENDAR_") ||
            details.type.startsWith("CONTENT_WORKSPACE_")
          ? "workspace"
          : "delivery";
    await db.paymentRevenueReceipt.update({
      where: { reference },
      data: { tool, creatorId: creator.id, paymentRecordId: payment.id },
    });
  }
  // Revenue is durable before commission calculation. Commission work is independently retryable.
  await processReferralCommission(payment);
  return { payment, action: existing ? "reconcile" : "import" };
}
