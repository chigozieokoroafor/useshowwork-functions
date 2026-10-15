import { effectiveTeamPermissions, normalizeTeamRole, type TeamPermission, type TeamRole } from "@/lib/calendarTeamPolicy";
import { complimentaryAccessSelect } from "@/lib/complimentaryAccess";
import { db } from "@/lib/db";
import {
  canAccessContentWorkspace,
  canUseContentWorkspaceFeature,
  getContentWorkspacePlan,
  type ContentWorkspaceAccount,
} from "@/lib/contentWorkspaceUsage";
import { CONTENT_WORKSPACE_PLANS, CONTENT_WORKSPACE_FEATURES, workspaceFeatureUpgradeMessage, type ContentWorkspaceFeature } from "@/lib/contentWorkspaceEntitlements";
import { NextResponse } from "next/server";

export type CalendarRole = "VIEW_ONLY" | "ADD_CONTENT" | "EDIT_CALENDAR";
export type CalendarAccess = { role: TeamRole; isOwner: boolean; permissions: TeamPermission[]; memberId?: string };
export async function getCalendarAccess(creatorId: string, calendarId: string): Promise<CalendarAccess | null> {
  const calendar = await db.socialCalendar.findUnique({ where: { id: calendarId }, select: { managerId: true } });
  if (!calendar) return null;
  if (calendar.managerId === creatorId) return { role: "OWNER", isOwner: true, permissions: effectiveTeamPermissions("OWNER") };
  const member = await db.calendarCollaborator.findUnique({ where: { calendarId_creatorId: { calendarId, creatorId } } });
  if (!member) return null;
  const role = normalizeTeamRole(member.role);
  if (!role) return null;
  return { role, isOwner: false, memberId: member.id, permissions: effectiveTeamPermissions(member.role, member.permissions, member.customPermissions) };
}
/** Legacy projection for calendar widgets; API authorization always uses feature permissions. */
export async function getCalendarRole(creatorId: string, calendarId: string): Promise<CalendarRole | null> {
  const access = await getCalendarAccess(creatorId, calendarId);
  if (!access) return null;
  return access.permissions.includes("calendar.edit") ? "EDIT_CALENDAR" : access.permissions.includes("creatives.upload") ? "ADD_CONTENT" : "VIEW_ONLY";
}
export async function hasCalendarPermission(creatorId: string, calendarId: string, required: CalendarRole | TeamPermission): Promise<boolean> {
  const access = await getCalendarAccess(creatorId, calendarId);
  if (!access) return false;
  const permission: TeamPermission = required === "VIEW_ONLY" ? "calendar.view" : required === "ADD_CONTENT" ? "creatives.upload" : required === "EDIT_CALENDAR" ? "calendar.edit" : required;
  if (!access.permissions.includes(permission)) return false;
  // Reading existing data and revoking team access are available after billing expiry.
  if (permission.endsWith(".view") || permission === "people.manage") return true;
  return canAccessCalendarById(calendarId);
}

/**
 * Single source of truth for whether the Content Workspace / Calendar
 * product is currently accessible.
 *
 * Billing is account-level: one Content Workspace subscription covers
 * all workspaces owned by the creator.
 *
 * This now uses the new Content Workspace billing fields rather than
 * the legacy calendar billing fields.
 */
export function canAccessCalendar(
  manager: ContentWorkspaceAccount
): boolean {
  return canAccessContentWorkspace(manager);
}

/**
 * Convenience wrapper for cases where only a calendarId is available.
 *
 * The calendar's manager owns the Content Workspace subscription, so
 * access is determined from the manager's Content Workspace billing
 * state.
 */
export async function canAccessCalendarById(
  calendarId: string, database: typeof db = db
): Promise<boolean> {
  const calendar = await database.socialCalendar.findUnique({
    where: { id: calendarId },
    select: {
      managerId: true,
      manager: { select: {
        id: true, contentWorkspacePlan: true, contentWorkspaceBillingStatus: true,
        contentWorkspaceBillingCycle: true, contentWorkspaceTrialEndsAt: true,
        ...complimentaryAccessSelect, isComped: true, compedUntil: true,
      } },
    },
  });

  if (!calendar) return false;

  if (!canAccessCalendar(calendar.manager)) return false;
  const plan = getContentWorkspacePlan(calendar.manager);
  if (!plan) return false;
  const limit = CONTENT_WORKSPACE_PLANS[plan].activeWorkspaces;
  if (limit === Number.MAX_SAFE_INTEGER) return true;
  // Keep excess trial workspaces intact and readable; only covered workspaces can mutate.
  const covered = await database.socialCalendar.findMany({
    where: { managerId: calendar.managerId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit,
    select: { id: true },
  });
  return covered.some(workspace => workspace.id === calendarId);
}

export async function canUseCalendarFeature(calendarId: string, feature: ContentWorkspaceFeature): Promise<boolean> {
  const calendar = await db.socialCalendar.findUnique({
    where: { id: calendarId },
    select: { manager: { select: {
      id: true, contentWorkspacePlan: true, contentWorkspaceBillingStatus: true,
      contentWorkspaceBillingCycle: true, contentWorkspaceTrialEndsAt: true,
      ...complimentaryAccessSelect, isComped: true, compedUntil: true,
    } } },
  });
  return !!calendar && canUseContentWorkspaceFeature(calendar.manager, feature) && await canAccessCalendarById(calendarId);
}

/** Call only after authenticating and checking the user's workspace permission. */
export async function calendarFeatureGate(calendarId: string, feature: ContentWorkspaceFeature) {
  if (await canUseCalendarFeature(calendarId, feature)) return null;
  return NextResponse.json({
    error: workspaceFeatureUpgradeMessage(feature), code: "WORKSPACE_FEATURE_LOCKED",
    feature, requiredPlan: CONTENT_WORKSPACE_FEATURES[feature].minimumPlan,
    upgradeUrl: "/dashboard/billing?product=content-workspace#content-workspace-plans",
  }, { status: 403 });
}
