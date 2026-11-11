/** Platforms with a metrics adapter. Safe to share with the browser. */
export const SYNC_REPORTING_PLATFORMS = ["INSTAGRAM", "TIKTOK", "FACEBOOK", "LINKEDIN", "X"] as const;
export const REPORTING_STALE_MS = 60 * 60_000;
export const REPORTING_SCHEDULE_MS = 6 * 60 * 60_000;
export const REPORTING_MANUAL_COOLDOWN_MS = 5 * 60_000;

