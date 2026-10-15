ALTER TABLE "PaymentRecord" ADD COLUMN "revenueStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED', ADD COLUMN "revenueReason" TEXT;
CREATE INDEX "PaymentRecord_revenueStatus_idx" ON "PaymentRecord"("revenueStatus");
