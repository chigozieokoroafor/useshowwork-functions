import { paymentRevenueSchema } from "@/lib/paymentRevenueSchema";
import { getLiveRevenueTotals } from "@/lib/livePaymentRevenue";
import { createHash, randomUUID } from "crypto";
import { db } from "@/lib/db";
import { listSuccessfulTransactions, verifyTransaction } from "@/lib/paystack";
import { syncVerifiedPayment } from "@/lib/paymentSync";
import { classifyPaymentRevenue } from "@/lib/paymentRevenue";

export function paymentIntegration() {
  const key = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!key) throw new Error("Paystack key is missing");
  return {
    id: `paystack-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
    live: key.startsWith("sk_live_"),
  };
}
const reasonFor = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 250) : "Payment sync failed";
async function syncReference(reference: string, integration: string) {
  try {
    const result = await syncVerifiedPayment(reference);
    await db.paymentRevenueSyncIssue.updateMany({
      where: { integration, reference, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    return result;
  } catch (error) {
    const reason = reasonFor(error);
    if (reason === "No account matches the verified payment") {
      const retained = await db.paymentRevenueReceipt.findUnique({
        where: { reference },
      });
      if (retained && retained.integration === integration) {
        await db.paymentRevenueSyncIssue.updateMany({
          where: { integration, reference, resolvedAt: null },
          data: {
            reason:
              "Verified charge retained for an unavailable historical account",
            resolvedAt: new Date(),
          },
        });
        return {
          action: "retained",
          payment: {
            amountNgn: Number(retained.amountKobo) / 100,
            revenueStatus: "LIVE",
          },
        };
      }
    }
    await db.paymentRevenueSyncIssue.upsert({
      where: { integration_reference: { integration, reference } },
      create: { id: randomUUID(), integration, reference, reason },
      update: { reason, attempts: { increment: 1 }, resolvedAt: null },
    });
    return null;
  }
}

/** A leased, stable date-window scan resumes after timeouts and covers the entire provider history. */
export async function reconcilePaymentBatch({
  maxPages = 2,
  budgetMs = 12000,
}: { maxPages?: number; budgetMs?: number } = {}) {
  const integration = paymentIntegration();
  if (!integration.live)
    throw new Error(
      "Revenue reconciliation requires the live Paystack integration",
    );
  const schema = await paymentRevenueSchema();
  if (!schema.receipts || !schema.state || !schema.issues)
    throw new Error(
      "Payment reconciliation requires the prepared database migration",
    );
  const started = Date.now();
  const leaseToken = randomUUID();
  await db.paymentRevenueSyncState.upsert({
    where: { id: integration.id },
    create: { id: integration.id },
    update: {},
  });
  const lock = await db.paymentRevenueSyncState.updateMany({
    where: {
      id: integration.id,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: { leaseToken, leaseUntil: new Date(Date.now() + 120000) },
  });
  if (!lock.count)
    return {
      busy: true,
      imported: 0,
      reconciled: 0,
      failed: 0,
      complete: false,
    };
  let imported = 0,
    reconciled = 0,
    failed = 0,
    complete = false;
  const processedReferences = new Set<string>();
  const leaseWhere = { id: integration.id, leaseToken };
  try {
    let state = (await db.paymentRevenueSyncState.findUnique({
      where: { id: integration.id },
    }))!;
    if (!state.scanTo) {
      await db.paymentRevenueSyncState.updateMany({
        where: leaseWhere,
        data: {
          scanTo: new Date(),
          scanFrom: null,
          nextPage: 1,
        },
      });
      state = (await db.paymentRevenueSyncState.findUnique({
        where: { id: integration.id },
      }))!;
    }
    for (let n = 0; n < maxPages && Date.now() - started < budgetMs; n++) {
      const batch = await listSuccessfulTransactions({
        page: state.nextPage,
        perPage: 1,
        from: state.scanFrom ?? undefined,
        to: state.scanTo!,
      });
      let processed = true;
      for (const charge of batch.data) {
        if (Date.now() - started > budgetMs) {
          processed = false;
          break;
        }
        if (charge.domain !== "live") continue;
        processedReferences.add(charge.reference);
        const result = await syncReference(charge.reference, integration.id);
        if (result) result.action === "import" ? imported++ : reconciled++;
        else failed++;
      }
      // Replay a partially processed page rather than skip its remaining transactions.
      if (!processed) break;
      const last =
        batch.data.length < 1 ||
        (batch.meta?.total !== undefined && state.nextPage >= batch.meta.total);
      if (last) {
        complete = true;
        await db.paymentRevenueSyncState.updateMany({
          where: leaseWhere,
          data: {
            lastSyncedAt: state.scanTo,
            scanTo: null,
            scanFrom: null,
            nextPage: 1,
            lastError: failed ? "Unresolved payments require review" : null,
          },
        });
        break;
      }
      state.nextPage++;
      await db.paymentRevenueSyncState.updateMany({
        where: leaseWhere,
        data: { nextPage: state.nextPage },
      });
    }
    // Prioritize forward progress; older unresolved references must not starve the history scan.
    if (Date.now() - started < budgetMs - 5000) {
      const issues = await db.paymentRevenueSyncIssue.findMany({
        where: {
          integration: integration.id,
          resolvedAt: null,
          reference: { notIn: [...processedReferences] },
        },
        orderBy: { updatedAt: "asc" },
        take: 1,
      });
      for (const issue of issues) {
        const result = await syncReference(issue.reference, integration.id);
        if (result) result.action === "import" ? imported++ : reconciled++;
        else failed++;
      }
    }
    return { busy: false, imported, reconciled, failed, complete };
  } catch (error) {
    await db.paymentRevenueSyncState.updateMany({
      where: leaseWhere,
      data: { lastError: reasonFor(error) },
    });
    throw error;
  } finally {
    await db.paymentRevenueSyncState.updateMany({
      where: leaseWhere,
      data: { leaseToken: null, leaseUntil: null },
    });
  }
}

/** Explicit historical audit, read-only by default. Applying never changes subscriptions or charges cards. */
export async function reconcileAllPaymentHistory({
  apply = false,
  onResult = () => {},
}: {
  apply?: boolean;
  onResult?: (row: Record<string, unknown>) => void;
} = {}) {
  const integration = paymentIntegration();
  if (apply && !integration.live)
    throw new Error(
      "Applying historical revenue sync requires the live Paystack integration",
    );
  if (apply) {
    const schema = await paymentRevenueSchema();
    if (!schema.receipts || !schema.state || !schema.issues)
      throw new Error(
        "Historical reconciliation requires the prepared database migration",
      );
  }
  const summary = {
    providerCharges: 0,
    providerRevenueNgn: 0,
    imported: 0,
    reconciled: 0,
    excluded: 0,
    failed: 0,
    existingAudited: 0,
  };
  const to = new Date();
  for (let page = 1; ; page++) {
    const batch = await listSuccessfulTransactions({ page, perPage: 50, to });
    for (const charge of batch.data) {
      if (charge.domain !== "live") {
        summary.excluded++;
        continue;
      }
      summary.providerCharges++;
      summary.providerRevenueNgn +=
        charge.currency === "NGN" ? charge.amount / 100 : 0;
      try {
        const result = apply
          ? await syncReference(charge.reference, integration.id)
          : await syncVerifiedPayment(charge.reference, undefined, {
              apply: false,
            });
        if (!result) {
          summary.failed++;
          onResult({ reference: charge.reference, status: "unresolved" });
          continue;
        }
        result.action === "import" ? summary.imported++ : summary.reconciled++;
        onResult({
          reference: charge.reference,
          action: result.action,
          amountNgn: result.payment.amountNgn,
          revenueStatus: result.payment.revenueStatus,
        });
      } catch (error) {
        summary.failed++;
        onResult({
          reference: charge.reference,
          status: "unresolved",
          reason: reasonFor(error),
        });
      }
    }
    if (
      batch.data.length < 50 ||
      (batch.meta?.total !== undefined && page * 50 >= batch.meta.total)
    )
      break;
  }
  // Also inspect receipts absent from the provider's successful-transaction list.
  let cursor: string | undefined;
  while (true) {
    const rows = await db.paymentRecord.findMany({
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        paystackReference: true,
        amountNgn: true,
        revenueStatus: true,
        revenueReason: true,
      },
    });
    for (const payment of rows) {
      summary.existingAudited++;
      try {
        if (
          !payment.paystackReference ||
          payment.paystackReference.startsWith("RECONCILED-")
        ) {
          const data = {
            revenueStatus: "EXCLUDED",
            revenueReason:
              "No actual provider charge reference; synthetic subscription receipts are not revenue",
          };
          if (apply)
            await db.paymentRecord.update({ where: { id: payment.id }, data });
          onResult({
            id: payment.id,
            previousStatus: payment.revenueStatus,
            ...data,
          });
        } else {
          const verification = await verifyTransaction(
            payment.paystackReference,
          );
          if (
            verification?.status &&
            verification.data?.domain === "live" &&
            verification.data?.status === "success" &&
            verification.data?.reference === payment.paystackReference
          ) {
            const result = apply
              ? await syncReference(payment.paystackReference, integration.id)
              : await syncVerifiedPayment(
                  payment.paystackReference,
                  verification,
                  { apply: false },
                );
            if (!result) summary.failed++;
            onResult({
              id: payment.id,
              reference: payment.paystackReference,
              status: result ? "reconciled" : "unresolved",
            });
            continue;
          }
          const status = classifyPaymentRevenue(payment, verification);
          if (status.revenueStatus === "LIVE") {
            if (apply)
              await syncReference(payment.paystackReference, integration.id);
          } else if (status.revenueStatus === "EXCLUDED") {
            if (apply)
              await db.paymentRecord.update({
                where: { id: payment.id },
                data: status,
              });
          } else {
            // A test key or temporary outage must never downgrade previously verified live revenue.
            if (apply)
              await syncReference(payment.paystackReference, integration.id);
            summary.failed++;
          }
          onResult({
            id: payment.id,
            reference: payment.paystackReference,
            previousStatus: payment.revenueStatus,
            ...status,
          });
        }
      } catch (error) {
        summary.failed++;
        onResult({
          id: payment.id,
          status: "unresolved",
          reason: reasonFor(error),
        });
      }
    }
    if (rows.length < 100) break;
    cursor = rows.at(-1)!.id;
  }
  const ledger = apply ? await getLiveRevenueTotals() : null;
  return {
    ...summary,
    ledgerRevenueNgn: ledger?.amountNgn ?? null,
    ledgerCharges: ledger?.count ?? null,
    applied: apply,
    complete: integration.live && summary.failed === 0,
  };
}
