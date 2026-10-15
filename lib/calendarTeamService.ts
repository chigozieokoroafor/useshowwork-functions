import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCalendarAccess, canAccessCalendarById } from '@/lib/calendarPermissions';
import { TEAM_ROLES, canManageTeamRole, effectiveTeamPermissions, needsAdvancedTeamPermissions, normalizeTeamRole, validateTeamAssignment, type TeamRole } from '@/lib/calendarTeamPolicy';
import { getContentWorkspacePlan, canAccessContentWorkspace, canUseContentWorkspaceFeature, type ContentWorkspaceAccount } from '@/lib/contentWorkspaceUsage';
import { CONTENT_WORKSPACE_PLANS } from '@/lib/contentWorkspaceEntitlements';
import { sendCalendarInviteEmail } from '@/lib/resend';

type Actor = { id: string; name: string | null; email: string };
export class TeamError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const inviteHash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function teamAccess(actorId: string, calendarId: string, manage = false) {
  // A live Next dev process can retain the old generated Prisma module even
  // after prisma generate. Do not allow unaudited writes or crash on a missing delegate.
  if (!db.calendarTeamActivity) {
    throw new TeamError(process.env.NODE_ENV === 'development'
      ? 'The development server is using an outdated Prisma client. Stop it with Ctrl+C, then run npm run dev again.'
      : 'Team tools are temporarily unavailable. Please try again shortly.', 503);
  }
  const access = await getCalendarAccess(actorId, calendarId);
  if (!access || !access.permissions.includes(manage ? 'people.manage' : 'people.view')) throw new TeamError('You do not have permission to manage this team.', 403);
  return access;
}
async function lockedOwner(tx: Prisma.TransactionClient, managerId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Creator" WHERE "id" = ${managerId} FOR UPDATE`;
  return tx.creator.findUniqueOrThrow({ where: { id: managerId } });
}
async function activity(tx: Prisma.TransactionClient, calendarId: string, actor: Actor, action: string, targetEmail: string, details?: Prisma.InputJsonValue) {
  return tx.calendarTeamActivity.create({ data: { calendarId, actorCreatorId: actor.id, actorName: actor.name || actor.email, action, targetEmail, ...(details ? { details } : {}) } });
}
function assignment(body: unknown) {
  const result = validateTeamAssignment(body);
  if ('error' in result) throw new TeamError(result.error);
  return result;
}
function assertDelegation(actorRole: TeamRole, targetRole: string) {
  if (!canManageTeamRole(actorRole, targetRole)) throw new TeamError('Only the owner can appoint or change another manager.', 403);
}
function checkPlan(owner: ContentWorkspaceAccount, role: string, custom: boolean) {
  const plan = getContentWorkspacePlan(owner);
  if (!plan || !canAccessContentWorkspace(owner)) throw new TeamError('Activate the workspace before granting new access.', 403);
  if (needsAdvancedTeamPermissions(role, custom) && !canUseContentWorkspaceFeature(owner, 'advancedTeamPermissions')) throw new TeamError('Upgrade to Studio to assign this role or customize feature access.', 403);
  return plan;
}
async function lockAndRecheck(tx: Prisma.TransactionClient, calendarId: string, actor: Actor, managerId: string) {
  const owner = await lockedOwner(tx, managerId);
  if (actor.id === managerId) return { owner, role: 'OWNER' as TeamRole, permissions: effectiveTeamPermissions('OWNER') };
  const member = await tx.calendarCollaborator.findUnique({ where: { calendarId_creatorId: { calendarId, creatorId: actor.id } } });
  const role = member && normalizeTeamRole(member.role);
  if (!role || !effectiveTeamPermissions(role, member?.permissions, member?.customPermissions).includes('people.manage')) throw new TeamError('Your team-management access has changed.', 403);
  return { owner, role, permissions: effectiveTeamPermissions(role, member?.permissions, member?.customPermissions) };
}
export async function inviteTeammate(calendarId: string, actor: Actor, body: unknown, resendId?: string) {
  await teamAccess(actor.id, calendarId, true);
  if (!(await canAccessCalendarById(calendarId))) throw new TeamError('This workspace is read-only. Restore access before inviting teammates.', 403);
  const calendar = await db.socialCalendar.findUniqueOrThrow({ where: { id: calendarId }, select: { managerId: true, clientName: true } });
  const input = body as { email?: unknown } | null;
  const existing = resendId ? await db.calendarInvite.findFirst({ where: { id: resendId, calendarId } }) : null;
  if (resendId && !existing) throw new TeamError('Invitation not found.', 404);
  const emailValue = existing?.email ?? input?.email;
  if (typeof emailValue !== 'string' || emailValue.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue.trim())) throw new TeamError('Enter a valid email address.');
  const email = emailValue.trim().toLowerCase();
  const selected = assignment(existing || body);
  const token = randomUUID() + randomUUID();
  const invite = await db.$transaction(async tx => {
    const { owner, role, permissions: actorPermissions } = await lockAndRecheck(tx, calendarId, actor, calendar.managerId);
    assertDelegation(role, selected.role);
    if (role !== "OWNER" && selected.permissions.some(permission => !actorPermissions.includes(permission))) throw new TeamError("You can only grant features you have access to. Ask the owner to assign broader permissions.", 403);
    if (email === owner.email.trim().toLowerCase() || email === actor.email.trim().toLowerCase()) throw new TeamError('You cannot invite yourself or the workspace owner.');
    const plan = checkPlan(owner, selected.role, selected.customPermissions);
    const member = await tx.calendarCollaborator.findFirst({ where: { calendarId, creator: { email: { equals: email, mode: 'insensitive' } } } });
    if (member) throw new TeamError('This person already belongs to the workspace. Edit their access instead.', 409);
    const pending = await tx.calendarInvite.findFirst({ where: { calendarId, email, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
    if (pending) assertDelegation(role, pending.role);
    if (resendId && pending?.id !== resendId) throw new TeamError('This invitation is no longer pending.', 409);
    const [members, invites] = await Promise.all([
      tx.calendarCollaborator.count({ where: { calendar: { managerId: calendar.managerId } } }),
      tx.calendarInvite.count({ where: { calendar: { managerId: calendar.managerId }, status: 'PENDING', expiresAt: { gt: new Date() }, ...(pending ? { id: { not: pending.id } } : {}) } }),
    ]);
    if (members + invites >= CONTENT_WORKSPACE_PLANS[plan].collaborators) throw new TeamError('Your account’s teammate allowance is full. Cancel an invitation or upgrade.', 403);
    const data = { email, ...selected, tokenHash: inviteHash(token), expiresAt: new Date(Date.now() + 7 * 86400000), deliveryStatus: 'QUEUED', lastDeliveryError: null };
    const saved = pending ? await tx.calendarInvite.update({ where: { id: pending.id }, data }) : await tx.calendarInvite.create({ data: { ...data, calendarId, invitedByCreatorId: actor.id } });
    await activity(tx, calendarId, actor, pending ? 'INVITATION_RESENT' : 'INVITATION_CREATED', email, { role: selected.role, permissions: selected.permissions });
    return saved;
  });
  try {
    await sendCalendarInviteEmail({ to: email, invitedByName: actor.name || actor.email, clientName: calendar.clientName, token, roleLabel: TEAM_ROLES[selected.role].label, permissions: selected.permissions });
    await db.calendarInvite.updateMany({ where: { id: invite.id, tokenHash: invite.tokenHash }, data: { deliveryStatus: 'SENT', lastDeliveryError: null } });
  } catch {
    await db.calendarInvite.updateMany({ where: { id: invite.id, tokenHash: invite.tokenHash }, data: { deliveryStatus: 'FAILED', lastDeliveryError: 'Email could not be sent. Retry this invitation.' } });
    throw new TeamError('The invitation was saved, but its email could not be sent. Use Resend to try again.', 502);
  }
  return { ok: true, inviteId: invite.id, role: selected.role };
}
export async function editTeammate(calendarId: string, memberId: string, actor: Actor, body: unknown) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { return await invokePublishingEntrypoint<{ok:boolean}>("lib/calendarTeamService.ts#editTeammate@96",[calendarId,memberId,actor,body]); } /* end-canonical-integration-boundary */

  await teamAccess(actor.id, calendarId, true);
  if (!(await canAccessCalendarById(calendarId))) throw new TeamError('Restore workspace access before changing permissions. You can still remove a teammate.', 403);
  const selected = assignment(body);
  const calendar = await db.socialCalendar.findUniqueOrThrow({ where: { id: calendarId }, select: { managerId: true } });
  return db.$transaction(async tx => {
    const { owner, role, permissions: actorPermissions } = await lockAndRecheck(tx, calendarId, actor, calendar.managerId);
    const member = await tx.calendarCollaborator.findFirst({ where: { id: memberId, calendarId }, include: { creator: { select: { email: true } } } });
    if (!member) throw new TeamError('Teammate not found.', 404);
    if (member.creatorId === actor.id) throw new TeamError('Only the owner can change your own manager access.', 403);
    assertDelegation(role, member.role); assertDelegation(role, selected.role);
    if (role !== "OWNER" && selected.permissions.some(permission => !actorPermissions.includes(permission))) throw new TeamError("You can only grant features you have access to. Ask the owner to assign broader permissions.", 403);
    checkPlan(owner, selected.role, selected.customPermissions);
    await tx.calendarCollaborator.update({ where: { id: memberId }, data: selected });
    await activity(tx, calendarId, actor, 'ACCESS_CHANGED', member.creator.email, { previousRole: member.role, role: selected.role, permissions: selected.permissions });
    return { ok: true };
  });
}
export async function removeTeammate(calendarId: string, memberId: string, actor: Actor) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { return await invokePublishingEntrypoint<{ok:boolean}>("lib/calendarTeamService.ts#removeTeammate@114",[calendarId,memberId,actor]); } /* end-canonical-integration-boundary */

  await teamAccess(actor.id, calendarId, true);
  const calendar = await db.socialCalendar.findUniqueOrThrow({ where: { id: calendarId }, select: { managerId: true } });
  return db.$transaction(async tx => {
    const { role } = await lockAndRecheck(tx, calendarId, actor, calendar.managerId);
    const member = await tx.calendarCollaborator.findFirst({ where: { id: memberId, calendarId }, include: { creator: { select: { email: true } } } });
    if (!member) throw new TeamError('Teammate not found.', 404);
    assertDelegation(role, member.role);
    await tx.calendarCollaborator.delete({ where: { id: memberId } });
    await activity(tx, calendarId, actor, 'MEMBER_REMOVED', member.creator.email, { role: member.role });
    return { ok: true };
  });
}
export async function cancelTeamInvite(calendarId: string, inviteId: string, actor: Actor) {
  await teamAccess(actor.id, calendarId, true);
  const calendar = await db.socialCalendar.findUniqueOrThrow({ where: { id: calendarId }, select: { managerId: true } });
  return db.$transaction(async tx => {
    const { role } = await lockAndRecheck(tx, calendarId, actor, calendar.managerId);
    const invite = await tx.calendarInvite.findFirst({ where: { id: inviteId, calendarId } });
    if (!invite) throw new TeamError('Invitation not found.', 404);
    if (invite.status !== 'PENDING') throw new TeamError('This invitation is no longer pending. Remove the teammate to revoke accepted access.', 409);
    assertDelegation(role, invite.role);
    await tx.calendarInvite.update({ where: { id: inviteId }, data: { status: 'DECLINED', respondedAt: new Date() } });
    await activity(tx, calendarId, actor, 'INVITATION_CANCELLED', invite.email);
    return { ok: true };
  });
}
export async function acceptTeamInvite(token: string, actor: Actor) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { return await invokePublishingEntrypoint<{ok:boolean;calendarId:string;alreadyMember?:boolean}>("lib/calendarTeamService.ts#acceptTeamInvite@141",[token,actor]); } /* end-canonical-integration-boundary */

  const found = await db.calendarInvite.findUnique({ where: { tokenHash: inviteHash(token) }, include: { calendar: { select: { managerId: true } } } });
  if (!found) throw new TeamError('Invitation not found.', 404);
  if (actor.email.trim().toLowerCase() !== found.email.trim().toLowerCase()) throw new TeamError('Sign in with the email address this invitation was sent to.', 403);
  if (actor.id === found.calendar.managerId) throw new TeamError('The owner already has full access.');
  if (!(await canAccessCalendarById(found.calendarId))) throw new TeamError('The workspace is read-only. Ask its owner to restore access.', 403);
  return db.$transaction(async tx => {
    const owner = await lockedOwner(tx, found.calendar.managerId);
    const invite = await tx.calendarInvite.findUnique({ where: { id: found.id } });
    if (!invite || invite.tokenHash !== inviteHash(token)) throw new TeamError('This invitation was replaced. Open the latest email.', 410);
    const member = await tx.calendarCollaborator.findUnique({ where: { calendarId_creatorId: { calendarId: invite.calendarId, creatorId: actor.id } } });
    if (invite.status === 'ACCEPTED' && member) return { ok: true, alreadyMember: true, calendarId: invite.calendarId };
    if (invite.status !== 'PENDING') throw new TeamError('This invitation is no longer active.', 410);
    if (invite.expiresAt <= new Date()) throw new TeamError('This invitation expired. Ask the owner to resend it.', 410);
    const selected = assignment(invite); const plan = checkPlan(owner, selected.role, selected.customPermissions);
    if (!member) {
      const count = await tx.calendarCollaborator.count({ where: { calendar: { managerId: owner.id } } });
      if (count >= CONTENT_WORKSPACE_PLANS[plan].collaborators) throw new TeamError('The teammate allowance is full. Ask the owner to upgrade.', 403);
      await tx.calendarCollaborator.create({ data: { calendarId: invite.calendarId, creatorId: actor.id, ...selected } });
    }
    await tx.calendarInvite.update({ where: { id: invite.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
    await activity(tx, invite.calendarId, actor, 'MEMBER_JOINED', actor.email, { role: selected.role });
    return { ok: true, calendarId: invite.calendarId };
  });
}

export function teamErrorResponse(error: unknown) {
  if (!(error instanceof TeamError)) console.error("Workspace team action failed:", error);
  return { error: error instanceof TeamError ? error.message : 'Could not complete this team action. Please try again.', status: error instanceof TeamError ? error.status : 500 };
}
