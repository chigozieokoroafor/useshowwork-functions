/** Queue an account-scoped reporting sync in Netlify without holding the
 * browser request open while provider APIs and historical posts are fetched. */
export async function dispatchCalendarReportingSync(calendarId: string) {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl || !process.env.CRON_SECRET) return false;
  try {
    const response = await fetch(`${siteUrl}/.netlify/functions/reporting-sync-background`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ calendarId }),
      signal: AbortSignal.timeout(2500),
    });
    return response.ok;
  } catch (error) {
    console.error("Could not queue calendar reporting sync:", error);
    return false;
  }
}
