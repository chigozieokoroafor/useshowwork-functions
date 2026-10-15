export const TEAM_PERMISSIONS = {
  'calendar.view': { label: 'View calendar', group: 'Content' },
  'calendar.edit': { label: 'Plan and edit content', group: 'Content' },
  'creatives.upload': { label: 'Upload creatives to planned posts', group: 'Content' },
  'publishing.manage': { label: 'Publish to social channels', group: 'Content' },
  'delivery.manage': { label: 'Deliver content for client review', group: 'Content' },
  'analytics.view': { label: 'View analytics and reports', group: 'Insights' },
  'analytics.manage': { label: 'Sync and analyze performance', group: 'Insights' },
  'inbox.view': { label: 'Read messages', group: 'Customer care' },
  'inbox.reply': { label: 'Reply to messages and draft AI replies', group: 'Customer care' },
  'leads.view': { label: 'View leads', group: 'Customer care' },
  'leads.manage': { label: 'Manage leads', group: 'Customer care' },
  'ai.generate': { label: 'Generate AI content', group: 'Business knowledge' },
  'knowledge.view': { label: 'Read business knowledge', group: 'Business knowledge' },
  'knowledge.manage': { label: 'Upload documents and manage knowledge', group: 'Business knowledge' },
  'people.view': { label: 'View team and access history', group: 'Administration' },
  'people.manage': { label: 'Invite and manage teammates', group: 'Administration' },
  'channels.view': { label: 'View connected channels', group: 'Administration' },
  'channels.manage': { label: 'Manage channel connections', group: 'Administration' },
  'workspace.manage': { label: 'Manage workspace and client access settings', group: 'Administration' },
} as const;
export type TeamPermission = keyof typeof TEAM_PERMISSIONS;
export const ALL_TEAM_PERMISSIONS = Object.keys(TEAM_PERMISSIONS) as TeamPermission[];
export type TeamRole = 'OWNER' | 'MANAGER' | 'SOCIAL_MEDIA_MANAGER' | 'CREATIVE_CONTRIBUTOR' | 'INBOX_AGENT' | 'VIEWER';
const SOCIAL: TeamPermission[] = ['calendar.view', 'calendar.edit', 'creatives.upload', 'publishing.manage', 'delivery.manage', 'analytics.view', 'analytics.manage', 'ai.generate', 'knowledge.view', 'channels.view'];
export const TEAM_ROLES: Record<TeamRole, { label: string; description: string; defaults: readonly TeamPermission[]; allowed: readonly TeamPermission[] }> = {
  OWNER: { label: 'Owner', description: 'Owns the workspace, billing, and all access decisions.', defaults: ALL_TEAM_PERMISSIONS, allowed: ALL_TEAM_PERMISSIONS },
  MANAGER: { label: 'Manager', description: 'Runs this workspace, its team, channels, and business knowledge. Billing and ownership stay with the owner.', defaults: ALL_TEAM_PERMISSIONS, allowed: ALL_TEAM_PERMISSIONS },
  SOCIAL_MEDIA_MANAGER: { label: 'Social Media Manager', description: 'Plans content, delivers it for client review, publishes, and tracks results.', defaults: SOCIAL, allowed: [...SOCIAL, 'inbox.view', 'inbox.reply', 'leads.view', 'leads.manage'] },
  CREATIVE_CONTRIBUTOR: { label: 'Creative Contributor', description: 'Views planned content and uploads creative assets. Cannot edit the calendar or publish.', defaults: ['calendar.view', 'creatives.upload'], allowed: ['calendar.view', 'creatives.upload'] },
  INBOX_AGENT: { label: 'Inbox Agent', description: 'Reads and replies to messages only. No calendar, leads, reports, documents, or team access.', defaults: ['inbox.view', 'inbox.reply'], allowed: ['inbox.view', 'inbox.reply'] },
  VIEWER: { label: 'Viewer', description: 'Reads the selected areas without making changes.', defaults: ['calendar.view'], allowed: ['calendar.view', 'analytics.view', 'inbox.view', 'leads.view', 'knowledge.view', 'channels.view'] },
};
export const INVITABLE_TEAM_ROLES = ['MANAGER', 'SOCIAL_MEDIA_MANAGER', 'CREATIVE_CONTRIBUTOR', 'INBOX_AGENT', 'VIEWER'] as const;
export function normalizeTeamRole(role: string): TeamRole | null {
  if (role === 'EDIT_CALENDAR') return 'SOCIAL_MEDIA_MANAGER';
  if (role === 'ADD_CONTENT') return 'CREATIVE_CONTRIBUTOR';
  if (role === 'VIEW_ONLY') return 'VIEWER';
  return Object.hasOwn(TEAM_ROLES, role) ? role as TeamRole : null;
}
const DEPENDENCIES: Partial<Record<TeamPermission, TeamPermission>> = {
  'calendar.edit': 'calendar.view', 'creatives.upload': 'calendar.view', 'publishing.manage': 'calendar.view', 'delivery.manage': 'calendar.view',
  'workspace.manage': 'calendar.view', 'analytics.manage': 'analytics.view', 'inbox.reply': 'inbox.view', 'leads.manage': 'leads.view', 'people.manage': 'people.view', 'channels.manage': 'channels.view', 'knowledge.manage': 'knowledge.view', 'ai.generate': 'calendar.edit',
};
export function effectiveTeamPermissions(role: string, permissions: readonly string[] = [], custom = false): TeamPermission[] {
  const normalized = normalizeTeamRole(role);
  if (!normalized) return [];
  if (normalized === 'OWNER') return [...ALL_TEAM_PERMISSIONS];
  const config = TEAM_ROLES[normalized];
  const selected = custom ? permissions : config.defaults;
  const result = new Set(selected.filter(p => config.allowed.includes(p as TeamPermission)) as TeamPermission[]);
  for (let pass = 0; pass < 3; pass++) for (const [permission, dependency] of Object.entries(DEPENDENCIES)) if (result.has(permission as TeamPermission) && dependency && !result.has(dependency)) result.delete(permission as TeamPermission);
  return [...result];
}
export function validateTeamAssignment(value: unknown): { role: Exclude<TeamRole, 'OWNER'>; permissions: TeamPermission[]; customPermissions: boolean } | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'Choose a role and feature access.' };
  const input = value as { role?: unknown; permissions?: unknown; customPermissions?: unknown };
  const role = typeof input.role === 'string' ? normalizeTeamRole(input.role) : null;
  if (!role || role === 'OWNER') return { error: 'Choose a supported teammate role. Ownership cannot be assigned by invitation.' };
  const custom = input.customPermissions === true;
  if (input.customPermissions !== undefined && typeof input.customPermissions !== 'boolean') return { error: 'Feature access must be a valid selection.' };
  if (input.permissions !== undefined && (!Array.isArray(input.permissions) || input.permissions.some(p => typeof p !== 'string'))) return { error: 'Choose valid feature permissions.' };
  const permissions = custom ? input.permissions as string[] : [...TEAM_ROLES[role].defaults];
  if (!permissions || !permissions.length) return { error: 'Select at least one feature for this teammate.' };
  if (permissions.some(p => !TEAM_ROLES[role].allowed.includes(p as TeamPermission))) return { error: 'This role cannot be given the selected feature access.' };
  const effective = effectiveTeamPermissions(role, permissions, true);
  if (effective.length !== new Set(permissions).size) return { error: 'Enable the corresponding view access before granting an action.' };
  return { role, permissions: effective, customPermissions: custom };
}
export function needsAdvancedTeamPermissions(role: string, custom = false) {
  return custom || !['CREATIVE_CONTRIBUTOR', 'VIEWER'].includes(normalizeTeamRole(role) || '');
}
export function canManageTeamRole(actorRole: TeamRole, targetRole: string) {
  const target = normalizeTeamRole(targetRole);
  return actorRole === 'OWNER' || (actorRole === 'MANAGER' && target !== 'OWNER' && target !== 'MANAGER');
}
export function toggleTeamPermission(current: readonly TeamPermission[], permission: TeamPermission, enabled: boolean): TeamPermission[] {
  const result = new Set(current);
  if (enabled) { const add = (value: TeamPermission) => { result.add(value); if (DEPENDENCIES[value]) add(DEPENDENCIES[value]!); }; add(permission); }
  else { result.delete(permission); for (const [action, view] of Object.entries(DEPENDENCIES)) if (view === permission) result.delete(action as TeamPermission); }
  return [...result];
}
