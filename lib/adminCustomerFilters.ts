export const CUSTOMER_PRODUCTS = {
  all: "All products",
  delivery: "Project Delivery",
  portfolio: "Portfolio",
  workspace: "Content Workspace",
  ai: "AI Assistant",
  unattributed: "Unattributed payments",
} as const;
export const CUSTOMER_STATUSES = {
  all: "All statuses",
  active: "Active",
  mixed: "Active & expired",
  expired: "Expired",
  one_time: "One-time purchase",
  complimentary: "Complimentary",
  trial: "Trial",
  pending: "Pending",
  archived: "Archived account",
} as const;
export type CustomerParams = {
  q?: string;
  product?: string;
  status?: string;
  range?: string;
  from?: string;
  to?: string;
  dateBasis?: string;
  sort?: string;
  page?: string;
};
export function customerFilters(params: CustomerParams, now = new Date()) {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const pick = (v: unknown, options: object, fallback: string) =>
    Object.prototype.hasOwnProperty.call(options, text(v)) ? text(v) : fallback;
  const range = ["all", "7", "30", "90", "custom"].includes(text(params.range))
    ? text(params.range)
    : "all";
  const today = new Date(now.getTime() + 3600000).toISOString().slice(0, 10);
  const parse = (value: unknown) => {
    const s = text(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) &&
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s
      ? new Date(`${s}T00:00:00+01:00`)
      : null;
  };
  let from: Date | null = null,
    to: Date | null = null,
    error = "";
  if (["7", "30", "90"].includes(range)) {
    to = new Date(new Date(`${today}T00:00:00+01:00`).getTime() + 86400000);
    from = new Date(to.getTime() - Number(range) * 86400000);
  }
  if (range === "custom") {
    from = parse(params.from);
    const end = parse(params.to);
    if (!from || !end || from > end || text(params.to) > today) {
      error = "Choose valid start and end dates, ending today or earlier.";
      from = null;
      to = null;
    } else to = new Date(end.getTime() + 86400000);
  }
  const page = Number(text(params.page));
  return {
    q: text(params.q).slice(0, 200),
    product: pick(params.product, CUSTOMER_PRODUCTS, "all"),
    status: pick(params.status, CUSTOMER_STATUSES, "all"),
    range,
    from,
    to,
    error,
    dateBasis: text(params.dateBasis) === "last" ? "last" : "any",
    sort: ["last", "spend", "payments", "name"].includes(text(params.sort))
      ? text(params.sort)
      : "last",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    fromValue: from
      ? new Date(from.getTime() + 3600000).toISOString().slice(0, 10)
      : text(params.from),
    toValue: to
      ? new Date(to.getTime() - 86400000 + 3600000).toISOString().slice(0, 10)
      : text(params.to),
  };
}
export type CustomerFilters = ReturnType<typeof customerFilters>;
export function customerQuery(
  filters: CustomerFilters,
  overrides: Partial<CustomerParams> = {},
) {
  const values = {
    q: filters.q,
    product: filters.product,
    status: filters.status,
    range: filters.range,
    from: filters.fromValue,
    to: filters.toValue,
    dateBasis: filters.dateBasis,
    sort: filters.sort,
    page: String(filters.page),
    ...overrides,
  };
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(values))
    if (v && v !== "all" && !(k === "page" && v === "1")) query.set(k, v);
  return query.toString();
}
