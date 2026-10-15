/**
 * Admin access is gated by an email allowlist in an env var, not a
 * database flag — simplest possible setup, zero extra migration, and
 * changing who's an admin is just an environment variable edit.
 *
 * Set in .env:
 *   ADMIN_EMAILS="you@useshowwork.com,cofounder@useshowwork.com"
 */
export function isAdminEmail(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}