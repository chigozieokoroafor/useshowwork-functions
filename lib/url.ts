/**
 * Returns NEXT_PUBLIC_APP_URL with any trailing slash stripped, so
 * building a URL like `${appUrl()}/${slug}` never produces a double
 * slash regardless of how the env var happens to be set.
 */
export function appUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return raw.replace(/\/+$/, "");
}