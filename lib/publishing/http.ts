import { publishingFetch as fetch } from "@/lib/publishing/executionContext";
export async function providerJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(60_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || (Array.isArray(data.errors) && data.errors.length && !data.data)) {
    const message = data.error?.message || data.errors?.[0]?.detail || data.detail || data.message || `Platform request failed (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status, providerCode: data.error?.code });
  }
  return data as T;
}
export function linkedInHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "LinkedIn-Version": process.env.LINKEDIN_API_VERSION || "202609", "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" };
}
export async function mediaBytes(url: string, start?: number, end?: number) {
  const response = await fetch(url, { headers: start === undefined ? {} : { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok || (start !== undefined && response.status !== 206)) throw new Error("Could not read the media from storage.");
  return { bytes: await response.arrayBuffer(), type: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream" };
}
export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
