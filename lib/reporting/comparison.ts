/** Period comparisons use matching accounts and never turn missing observations into zero. */
export type Change = { value: number | null; delta: number | null; percent: number | null; basis: string; note?: string };
type Snapshot = { snapshotDate: Date | string; followers: number | null; reach: number | null; views: number | null; engagement: number | null; additionalMetrics?: unknown };
type Account = { id: string; platform: string; status: string; accountMetricSnapshots: Snapshot[]; accountPosts?: Array<{ publishedAt: Date | string; views: number | null; reach: number | null; engagement: number | null; likes: number | null }> };
export function change(value: number | null, previous: number | null, basis: string): Change {
  const delta = value != null && previous != null ? value - previous : null;
  return { value, delta, percent: delta != null && previous! > 0 ? delta / previous! * 100 : null, basis };
}
export function compareAccounts(accounts: Account[], start: Date, end: Date, previousStart: Date) {
  const active = accounts.filter(a => a.status === "CONNECTED");
  const inRange = (s: Snapshot, from: Date, to: Date) => new Date(s.snapshotDate) >= from && new Date(s.snapshotDate) <= to;
  const previousEnd = new Date(start.getTime() - 1);
  const ordered = (a: Account) => [...a.accountMetricSnapshots].sort((a, b) => +new Date(a.snapshotDate) - +new Date(b.snapshotDate));
  const result: Record<string, Change> = {};
  const followerRows = active.map(a => {
    const rows = ordered(a).filter(s => s.followers != null);
    const current = rows.filter(s => inRange(s, start, end));
    const prior = rows.filter(s => inRange(s, previousStart, previousEnd)).at(-1);
    return { latest: current.at(-1), baseline: prior ?? (current.length > 1 ? current[0] : undefined), prior: Boolean(prior) };
  }).filter(r => r.latest);
  const comparableFollowers = followerRows.length > 0 && followerRows.every(r => r.baseline);
  result.followers = change(followerRows.length ? followerRows.reduce((sum, r) => sum + r.latest!.followers!, 0) : null,
    comparableFollowers ? followerRows.reduce((sum, r) => sum + r.baseline!.followers!, 0) : null,
    followerRows.every(r => r.prior) ? "since last observation before period" : "between available follower snapshots");
  if (comparableFollowers) {
    const baseline = followerRows.reduce((sum, r) => sum + r.baseline!.followers!, 0);
    const latest = result.followers.value!;
    const dates = followerRows.map(r => `${new Date(r.baseline!.snapshotDate).toISOString().slice(0, 10)} → ${new Date(r.latest!.snapshotDate).toISOString().slice(0, 10)}`);
    result.followers.note = followerRows.length === 1
      ? `Recorded counts: ${baseline} → ${latest} (${dates[0]})${followerRows[0].prior ? "" : ". History before the first recorded count is unavailable."}`
      : `Recorded counts: ${baseline} → ${latest} across ${followerRows.length} accounts. Each account uses its available snapshot dates.`;
  }
  if (!comparableFollowers) result.followers.note = followerRows.length ? "First follower snapshot recorded · next sync enables a trend" : "Sync an account to collect follower counts";
  for (const key of ["reach", "views", "engagement", "likes"] as const) {
    const read = (s: Snapshot): number | null => {
      if (key !== "likes") return s[key];
      const value = (s.additionalMetrics as { likes?: unknown } | null)?.likes;
      return typeof value === "number" ? value : null;
    };
    const rows = active.map(a => {
      const current = ordered(a).filter(s => inRange(s, start, end) && read(s) != null);
      const previous = ordered(a).filter(s => inRange(s, previousStart, previousEnd) && read(s) != null);
      const rolling = a.platform === "INSTAGRAM" && key !== "reach";
      if (current.length || previous.length) {
        const sum = (items: Snapshot[]) => items.reduce((total, item) => total + read(item)!, 0);
        return {
          current: current.length ? rolling ? read(current.at(-1)!) : sum(current) : null,
          previous: previous.length ? rolling ? read(previous.at(-1)!) : sum(previous) : rolling && current.length > 1 ? read(current[0]) : null,
          source: rolling ? "rolling" : "daily", within: rolling && !previous.length && current.length > 1,
        };
      }
      // Native counters are lifetime totals for posts published in each period.
      // They remain useful, but must not be labelled as activity earned in that period.
      const posts = a.accountPosts ?? [];
      const postSum = (from: Date, to: Date) => {
        const values = posts.filter(p => new Date(p.publishedAt) >= from && new Date(p.publishedAt) <= to)
          .map(p => p[key]).filter((value): value is number => value != null);
        return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
      };
      return { current: postSum(start, end), previous: postSum(previousStart, previousEnd), source: "posts", within: false };
    }).filter(r => r.current != null || r.previous != null);
    const comparable = rows.length > 0 && rows.every(r => r.current != null && r.previous != null);
    const sources = new Set(rows.map(r => r.source));
    const basis = sources.size > 1 ? "available account & post metrics" : sources.has("rolling")
      ? rows.some(r => r.within) ? "rolling total change between syncs" : "latest rolling total vs previous period"
      : sources.has("posts") ? "lifetime totals of posts published in each period" : "observed totals vs previous period";
    result[key] = change(rows.some(r => r.current != null) ? rows.reduce((total, r) => total + (r.current ?? 0), 0) : null,
      comparable ? rows.reduce((total, r) => total + r.previous!, 0) : null, basis);
    if (!comparable) result[key].note = result[key].value == null ? "Metric not supplied by this account yet" : "No earlier matching data · current total shown";

  }
  return result;
}


/** Live Page observations are explicitly current, never manufactured historical snapshots. */
export function applyLiveFacebookOverview(
  compared: Record<string, Change>,
  live: { followers: number | null; latestMetrics?: { asOf: string; reach: number | null; views: number | null; engagement: number | null } | null },
  start: Date, end: Date,
) {
  const result = { ...compared };
  if (result.followers?.value == null && live.followers !== null) result.followers = {
    value: live.followers, delta: null, percent: null, basis: "Current Facebook follower count from Meta",
    note: "Live count; no saved follower history for a period comparison.",
  };
  const latest = live.latestMetrics;
  if (latest && new Date(latest.asOf) >= start && new Date(latest.asOf) <= end) {
    for (const key of ["reach", "views", "engagement"] as const) {
      if (latest[key] === null) continue;
      // Preserve actual recorded daily totals. A post-lifetime fallback is not
      // an account daily total and must not take priority over real Page data.
      if (result[key]?.value != null && !result[key].basis.includes("lifetime totals")) continue;
      result[key] = { value: latest[key], delta: null, percent: null,
        basis: "Latest available Facebook daily metric from Meta",
        note: "Live daily value, not the total for the entire selected period. Sync records history for comparisons.",
      };
    }
  }
  return result;
}
