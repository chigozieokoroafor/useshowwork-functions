-- Discounted checkout stores the selected package in BillingOfferSubscription.
ALTER TABLE "BillingOfferSubscription"
  DROP CONSTRAINT "BillingOfferSubscription_valid_terms",
  ADD CONSTRAINT "BillingOfferSubscription_valid_terms" CHECK (
    "product" IN ('DELIVERY', 'CONTENT_WORKSPACE')
    AND (("product" = 'DELIVERY' AND "plan" IN ('STARTER', 'GROWTH', 'UNLIMITED'))
      OR ("product" = 'CONTENT_WORKSPACE' AND "plan" IN ('CREATOR', 'GROWTH', 'STUDIO', 'UNLIMITED', 'ENGAGE')))
    AND "percent" BETWEEN 1 AND 100 AND "durationMonths" BETWEEN 1 AND 36 AND "paidCycles" >= 0
    AND "standardPriceNgn" >= 0 AND "discountedPriceNgn" >= 0 AND "discountedPriceNgn" <= "standardPriceNgn"
    AND "status" IN ('CHECKOUT', 'FAILED', 'ACTIVE', 'RESTORE_PENDING', 'STANDARD', 'COMPLIMENTARY', 'REVOKED')
  );
