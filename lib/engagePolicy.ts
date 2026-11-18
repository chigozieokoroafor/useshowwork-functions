import type { TeamPermission } from "./calendarTeamPolicy";

export const ENGAGE_PERMISSIONS: readonly TeamPermission[] = [
  "workspace.manage",
  "people.view",
  "people.manage",
  "inbox.view",
  "inbox.reply",
  "leads.view",
  "leads.manage",
  "channels.view",
  "channels.manage",
  "knowledge.view",
  "knowledge.manage",
];

/** Package rights intersect team permissions; a role never grants another product. */
export function packagePermissions(
  plan: string | null,
  permissions: TeamPermission[],
): TeamPermission[] {
  return plan === "ENGAGE"
    ? permissions.filter((permission) =>
        ENGAGE_PERMISSIONS.includes(permission),
      )
    : permissions;
}

export const ENGAGE_CHANNEL_PLATFORMS = [
  "FACEBOOK",
  "INSTAGRAM",
  "WHATSAPP",
] as const;

export function packageAllowsChannel(
  plan: string | null | undefined,
  platform: string,
): boolean {
  return (
    plan !== "ENGAGE" ||
    (ENGAGE_CHANNEL_PLATFORMS as readonly string[]).includes(
      platform.toUpperCase(),
    )
  );
}
