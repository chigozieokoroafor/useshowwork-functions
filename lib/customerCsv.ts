import type { CustomerRow } from "@/lib/adminCustomers";
import {
  CUSTOMER_PRODUCTS,
  CUSTOMER_STATUSES,
} from "@/lib/adminCustomerFilters";
export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (
    typeof value === "string" &&
    (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
  )
    text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
const date = (v: Date | null) => (v ? v.toISOString() : "");
export const customerCsvHeader = [
  "Customer ID",
  "Customer name",
  "Email",
  "Phone",
  "Company",
  "Account type",
  "Account created (UTC)",
  "Account deactivated",
  "Product",
  "Current subscription status",
  "Current plan",
  "Billing cycle",
  "Next renewal or access end (UTC)",
  "First payment (UTC)",
  "Latest payment (UTC)",
  "Product lifetime payment count",
  "Product lifetime collected (NGN)",
  "Product payment count in selected period",
  "Product collected in selected period (NGN)",
  "Subscription payment count",
  "One-time payment count",
  "Latest payment reference",
];
export function customerCsvRow(r: CustomerRow) {
  return [
    r.creatorId ?? r.key,
    r.name ?? (r.creatorId ? "Customer" : "Archived customer"),
    r.email,
    r.phone,
    r.companyName,
    r.accountType,
    date(r.joinedAt),
    r.deactivated ? "Yes" : "No",
    CUSTOMER_PRODUCTS[r.product as keyof typeof CUSTOMER_PRODUCTS] ?? r.product,
    CUSTOMER_STATUSES[r.status as keyof typeof CUSTOMER_STATUSES] ?? r.status,
    r.plan,
    r.cycle,
    date(r.nextBillingAt),
    date(r.firstPaidAt),
    date(r.lastPaidAt),
    r.lifetimePayments,
    r.lifetimeRevenue.toFixed(2),
    r.periodPayments,
    r.periodRevenue.toFixed(2),
    r.subscriptionPayments,
    r.oneTimePayments,
    r.recentPayments[0]?.reference ?? "",
  ]
    .map(csvCell)
    .join(",");
}
