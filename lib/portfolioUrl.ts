/** Builds the canonical public URL for a portfolio route. */
export function portfolioUrl(slug: string): string {
  const raw = (process.env.NEXT_PUBLIC_APP_URL ?? "https://useshowwork.com").replace(/\/+$/, "");
  return `${raw}/portfolio/${encodeURIComponent(slug)}`;
}
