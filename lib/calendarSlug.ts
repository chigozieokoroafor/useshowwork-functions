/** Public calendar path derived from the workspace's display name. */
export function calendarSlugBase(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/g, "") || "calendar";
}
export function calendarSlugCandidate(name: string, attempt: number): string {
  const base = calendarSlugBase(name);
  return attempt === 0 ? base : `${base}-${attempt + 1}`;
}
