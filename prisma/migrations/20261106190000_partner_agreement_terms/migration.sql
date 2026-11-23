-- Preserve existing agreements; explicit terms are required for all new approvals.
ALTER TABLE "PartnerProfile"
 ADD COLUMN "commissionPercent" INTEGER NOT NULL DEFAULT 10,
 ADD COLUMN "commissionMonths" INTEGER NOT NULL DEFAULT 12,
 ADD COLUMN "discountPercent" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "discountMonths" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Referral"
 ADD COLUMN "commissionPercent" INTEGER NOT NULL DEFAULT 10,
 ADD COLUMN "commissionMonths" INTEGER NOT NULL DEFAULT 12,
 ADD COLUMN "discountPercent" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "discountMonths" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PartnerProfile" ADD CONSTRAINT "PartnerProfile_terms_check" CHECK (
 "commissionPercent" BETWEEN 0 AND 100 AND "commissionMonths" BETWEEN 1 AND 120 AND
 (("discountPercent" = 0 AND "discountMonths" = 0) OR ("discountPercent" BETWEEN 1 AND 99 AND "discountMonths" BETWEEN 1 AND 36)));
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_terms_check" CHECK (
 "commissionPercent" BETWEEN 0 AND 100 AND "commissionMonths" BETWEEN 1 AND 120 AND
 (("discountPercent" = 0 AND "discountMonths" = 0) OR ("discountPercent" BETWEEN 1 AND 99 AND "discountMonths" BETWEEN 1 AND 36)));
