import { scheduleReportingSync, runNextReportingJob } from "./jobs";

export interface ReportingSyncResult {
  queued: number;
  processed: number;
  mode: "http" | "direct";
}

/**
 * Triggers the automatic analytics reporting sync.
 * Primary: Authenticated HTTP request to /api/cron/reporting-sync using CRON_SECRET.
 * Fallback: Direct in-process database execution of scheduleReportingSync + runNextReportingJob.
 */
export async function triggerReportingSync(): Promise<ReportingSyncResult> {
  const secret = process.env.CRON_SECRET?.trim();
  const rawBaseUrl =
    process.env.INTERNAL_APP_URL ||
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000";
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");

  if (secret) {
    const endpoint = `${baseUrl}/api/cron/reporting-sync`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 280_000);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as { queued?: number; processed?: number };
        const queued = typeof data.queued === "number" ? data.queued : 0;
        const processed = typeof data.processed === "number" ? data.processed : 0;
        return { queued, processed, mode: "http" };
      }

      console.warn(`[ReportingSync] /api/cron/reporting-sync responded with HTTP ${res.status}. Falling back to direct database execution...`);
    } catch (err) {
      console.warn(
        `[ReportingSync] HTTP request to ${endpoint} failed (${err instanceof Error ? err.message : String(err)}). Falling back to direct database execution...`
      );
    }
  } else {
    console.warn("[ReportingSync] CRON_SECRET is not configured in worker environment. Executing reporting sync directly via database...");
  }

  // Direct database runner
  try {
    const queued = await scheduleReportingSync();
    let processed = 0;
    const deadline = Date.now() + 180_000;
    while (processed < 5 && Date.now() < deadline && (await runNextReportingJob())) {
      processed++;
    }
    return { queued, processed, mode: "direct" };
  } catch (err) {
    console.error("[ReportingSync] Direct reporting sync failed:", err);
    throw err;
  }
}

