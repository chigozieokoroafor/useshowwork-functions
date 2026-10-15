import { PAID_TIER_ORDER } from "@/lib/subscriptionTiers";
export function parseBillingOffer(body: any, now = new Date()) {
  if (!body || typeof body !== "object") throw new Error("Invalid offer details");
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < 3 || title.length > 100) throw new Error("Give this offer a name between 3 and 100 characters");
  if (!["DELIVERY", "CONTENT_WORKSPACE", "BOTH"].includes(body.product)) throw new Error("Select a valid product");
  if (!["ALL", "SELECTED"].includes(body.audience)) throw new Error("Select a valid audience");
  if (!Number.isInteger(body.percent) || body.percent < 1 || body.percent > 100) throw new Error("Discount must be a whole percentage between 1 and 100");
  if (!Number.isInteger(body.durationMonths) || body.durationMonths < 1 || body.durationMonths > 36) throw new Error("Duration must be between 1 and 36 whole months");
  const billingCycle = body.billingCycle === "ANY" ? null : body.billingCycle;
  if (billingCycle !== null && !["MONTHLY", "ANNUAL"].includes(billingCycle)) throw new Error("Select a valid billing cycle");
  if (billingCycle === "ANNUAL" && body.durationMonths % 12 !== 0) throw new Error("Annual offers must last 12, 24 or 36 months");
  const deliveryTier = body.product === "CONTENT_WORKSPACE" ? null : (body.deliveryTier || null);
  const workspacePlan = body.product === "DELIVERY" ? null : (body.workspacePlan || null);
  if (deliveryTier && !PAID_TIER_ORDER.includes(deliveryTier)) throw new Error("Select a valid Delivery plan");
  if (workspacePlan && !["CREATOR", "STUDIO", "UNLIMITED"].includes(workspacePlan)) throw new Error("Select a valid Content Workspace plan");
  if (!Array.isArray(body.creatorIds) || body.creatorIds.some((id: unknown) => typeof id !== "string" || !id || id.length > 100)) throw new Error("Invalid selected accounts");
  const creatorIds = body.audience === "SELECTED" ? [...new Set<string>(body.creatorIds)] : [];
  if (body.audience === "SELECTED" && (creatorIds.length === 0 || creatorIds.length > 500)) throw new Error("Select between 1 and 500 accounts");
  if (body.percent === 100) {
    if (body.audience !== "SELECTED") throw new Error("Complimentary access requires selected accounts");
    if ((body.product !== "CONTENT_WORKSPACE" && !deliveryTier) || (body.product !== "DELIVERY" && !workspacePlan)) throw new Error("Complimentary access requires a specific plan for each selected product");
    if (body.acknowledgeExistingBilling !== true) throw new Error("Confirm that complimentary access does not cancel existing paid subscriptions");
  }
  let availableUntil: Date | null = null;
  if (body.percent !== 100 && body.availableUntil) {
    if (typeof body.availableUntil !== "string") throw new Error("Invalid activation deadline");
    availableUntil = new Date(body.availableUntil);
    if (!Number.isFinite(availableUntil.getTime()) || availableUntil <= now) throw new Error("Activation deadline must be in the future");
  }
  return { title, product: body.product as string, deliveryTier, workspacePlan, billingCycle: body.percent === 100 ? null : billingCycle,
    percent: body.percent as number, durationMonths: body.durationMonths as number, audience: body.audience as string,
    availableUntil: body.percent === 100 ? null : availableUntil, creatorIds };
}
