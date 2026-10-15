/** Existing policy formulas, shared without importing a global database client. */
import {workspaceComplimentaryPlan,type ComplimentaryAccount} from "./complimentaryAccess";
import {CONTENT_WORKSPACE_PLANS,planIncludesWorkspaceFeature,type ContentWorkspacePlan,type ContentWorkspaceFeature} from "./contentWorkspaceEntitlements";
import type {ContentWorkspaceAccount} from "./contentWorkspaceUsage";
export function isContentWorkspaceTrialActive(
  account: Pick<
    ContentWorkspaceAccount,
    "contentWorkspaceBillingStatus" | "contentWorkspaceTrialEndsAt"
  >
): boolean {
  return (
    ["TRIAL", "ACTIVE"].includes(account.contentWorkspaceBillingStatus) &&
    !!account.contentWorkspaceTrialEndsAt &&
    account.contentWorkspaceTrialEndsAt.getTime() > Date.now()
  );
}

export function isComplimentaryAccessActive(
  account: Pick<ContentWorkspaceAccount, "isComped" | "compedUntil"> & ComplimentaryAccount
): boolean {
  return !!workspaceComplimentaryPlan(account);
}


export function canAccessContentWorkspace(
  account: Pick<
    ContentWorkspaceAccount,
    | "contentWorkspaceBillingStatus"
    | "contentWorkspaceTrialEndsAt"
    | "contentWorkspacePlan"
    | "isComped"
    | "compedUntil"
  > & ComplimentaryAccount
): boolean {
  if (isComplimentaryAccessActive(account)) {
    return true;
  }

  if (
    account.contentWorkspaceBillingStatus === "ACTIVE" &&
    !!account.contentWorkspacePlan
  ) {
    return true;
  }

  if (
    account.contentWorkspaceBillingStatus === "TRIAL" &&
    !!account.contentWorkspacePlan
  ) {
    return isContentWorkspaceTrialActive(account);
  }

  return false;
}
export function getContentWorkspacePlan(
  account: Pick<
    ContentWorkspaceAccount,
    "contentWorkspacePlan" | "isComped" | "compedUntil"
    | "contentWorkspaceBillingStatus" | "contentWorkspaceTrialEndsAt"
  > & ComplimentaryAccount
): ContentWorkspacePlan | null {
  if (isContentWorkspaceTrialActive(account)) return "UNLIMITED";

  const complimentary = workspaceComplimentaryPlan(account);
  if (complimentary) {
    const order = ["CREATOR", "STUDIO", "UNLIMITED"];
    return account.contentWorkspaceBillingStatus === "ACTIVE" && account.contentWorkspacePlan &&
      order.indexOf(account.contentWorkspacePlan) > order.indexOf(complimentary)
      ? account.contentWorkspacePlan : complimentary;
  }

  return account.contentWorkspacePlan;
}
/** Feature access always uses the owner's live billing state, never the caller's plan. */
export function canUseContentWorkspaceFeature(account: ContentWorkspaceAccount, feature: ContentWorkspaceFeature): boolean {
  return canAccessContentWorkspace(account) && planIncludesWorkspaceFeature(getContentWorkspacePlan(account), feature);
}

export function currentAiCycleStart(anchor: Date, now = new Date()): Date {
  let months = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
  const boundary = (offset: number) => {
    const date = new Date(anchor);
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + offset);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
    return date;
  };
  if (boundary(months) > now) months--;
  return months > 0 ? boundary(months) : anchor;
}

/** Joined publishing-action transaction; reuses the existing owner plan/cycle
 * policy. Never opens a global Prisma transaction or retries a committed action. */
export async function validateCanonicalWorkspaceUsage(tx:{query(sql:string,values?:unknown[]):Promise<{rows:Record<string,any>[]}>},input:{calendarId:string;kind:'AI_DRAFT'|'AI_REGENERATION'|'UPLOAD'|'MEMBERSHIP';deltaBytes?:string}) {
 const owner=(await tx.query(`SELECT c.* FROM "Creator" c JOIN "SocialCalendar" w ON w."managerId"=c.id WHERE w.id=$1`,[input.calendarId])).rows[0];
 if(!owner||!canAccessContentWorkspace(owner as ContentWorkspaceAccount))throw Error('WORKSPACE_ENTITLEMENT_DENIED');
 const plan=getContentWorkspacePlan(owner as ContentWorkspaceAccount);if(!plan)throw Error('WORKSPACE_ENTITLEMENT_DENIED');
 if(input.kind==='MEMBERSHIP'){
  const count=(await tx.query(`SELECT count(*)::integer AS count FROM "CalendarCollaborator" m JOIN "SocialCalendar" w ON w.id=m."calendarId" WHERE w."managerId"=$1 AND m."creatorId"<>$1`,[owner.id])).rows[0].count;
  if(count>=CONTENT_WORKSPACE_PLANS[plan].collaborators)throw Error('COLLABORATOR_LIMIT_REACHED');return;
 }
 if(input.kind==='UPLOAD')throw Error('STORAGE_RESERVATION_PROOF_REQUIRED');
 await tx.query(`INSERT INTO "ContentWorkspaceUsage"("creatorId","cycleStart","updatedAt") VALUES($1,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING`,[owner.id]);
 const usage=(await tx.query(`SELECT * FROM "ContentWorkspaceUsage" WHERE "creatorId"=$1 FOR UPDATE`,[owner.id])).rows[0],now=(await tx.query('SELECT clock_timestamp() AS now')).rows[0].now;
 const cycle=currentAiCycleStart(usage.cycleStart,now);
 if(cycle.getTime()!==usage.cycleStart.getTime())await tx.query(`UPDATE "ContentWorkspaceUsage" SET "cycleStart"=$2,"aiGenerationsUsed"=0,"aiRegenerationsUsed"=0,"updatedAt"=clock_timestamp() WHERE "creatorId"=$1`,[owner.id,cycle]);
 const regenerate=input.kind==='AI_REGENERATION',limit=regenerate?CONTENT_WORKSPACE_PLANS[plan].aiRegenerations:CONTENT_WORKSPACE_PLANS[plan].aiGenerations;
 const updated=(await tx.query(`UPDATE "ContentWorkspaceUsage" SET "aiGenerationsUsed"="aiGenerationsUsed"+1,"aiRegenerationsUsed"="aiRegenerationsUsed"+$3,"updatedAt"=clock_timestamp() WHERE "creatorId"=$1 AND "aiGenerationsUsed"<$2 AND ($3=0 OR "aiRegenerationsUsed"<$2) RETURNING "creatorId"`,[owner.id,limit,regenerate?1:0])).rows;
 if(!updated.length)throw Error(regenerate?'AI_REGENERATION_LIMIT_REACHED':'AI_GENERATION_LIMIT_REACHED');
}

