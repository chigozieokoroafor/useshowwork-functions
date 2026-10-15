export const REPORTING_RECOMMENDATION_EVENT = "showwork-reporting-recommendation";

// The in-memory fallback also covers browsers where session storage is blocked.
const pending = new Map<string, string>();
const storageKey = (calendarId: string) => `calendar:${calendarId}:reporting-recommendation`;

export function queueReportingRecommendation(calendarId: string, instructions: string) {
  const value = instructions.trim();
  if (!value) return false;
  pending.set(calendarId, value);
  try { window.sessionStorage.setItem(storageKey(calendarId), value); } catch { /* Keep the in-memory handoff. */ }
  window.dispatchEvent(new CustomEvent(REPORTING_RECOMMENDATION_EVENT, { detail: { calendarId } }));
  return true;
}

export function consumeReportingRecommendation(calendarId: string): string | null {
  let value = pending.get(calendarId);
  try { value ??= window.sessionStorage.getItem(storageKey(calendarId)) ?? undefined; } catch { /* Storage may be unavailable. */ }
  pending.delete(calendarId);
  try { window.sessionStorage.removeItem(storageKey(calendarId)); } catch { /* Already consumed in memory. */ }
  return value?.trim() || null;
}
