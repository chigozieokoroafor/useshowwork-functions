CREATE TABLE "PaymentRevenueSyncState" (
  "id" TEXT NOT NULL,
  "scanFrom" TIMESTAMP(3),
  "scanTo" TIMESTAMP(3),
  "nextPage" INTEGER NOT NULL DEFAULT 1,
  "lastSyncedAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "leaseToken" TEXT,
  "lastError" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentRevenueSyncState_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PaymentRevenueSyncIssue" (
  "id" TEXT NOT NULL,
  "integration" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "resolvedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentRevenueSyncIssue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentRevenueSyncIssue_integration_reference_key" ON "PaymentRevenueSyncIssue"("integration", "reference");
CREATE INDEX "PaymentRevenueSyncIssue_integration_resolvedAt_updatedAt_idx" ON "PaymentRevenueSyncIssue"("integration", "resolvedAt", "updatedAt");
CREATE TABLE "PaymentRevenueReceipt" (
  "reference" TEXT NOT NULL,
  "integration" TEXT NOT NULL,
  "amountKobo" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "tool" TEXT NOT NULL DEFAULT 'unattributed',
  "creatorId" TEXT,
  "paymentRecordId" TEXT,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentRevenueReceipt_pkey" PRIMARY KEY ("reference")
);
CREATE INDEX "PaymentRevenueReceipt_paidAt_idx" ON "PaymentRevenueReceipt"("paidAt");
CREATE INDEX "PaymentRevenueReceipt_tool_paidAt_idx" ON "PaymentRevenueReceipt"("tool", "paidAt");
CREATE INDEX "PaymentRevenueReceipt_creatorId_idx" ON "PaymentRevenueReceipt"("creatorId");
