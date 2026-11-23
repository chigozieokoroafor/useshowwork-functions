import { createHash } from "node:crypto";

type Query = (sql: string, args: unknown[]) => Promise<unknown>;

export type WorkspaceNotice = {
  calendarId: string;
  key: string;
  kind: "generated" | "imported" | "uploaded" | "team-feedback" | "team-approved" | "client-approved" | "client-feedback" | "channel";
  actorId?: string;
  actor?: string;
  title: string;
  description?: string;
  postId?: string;
  batchId?: string;
  focusDate?: string;
};

export const channelNames: Record<string, string> = {
  FACEBOOK: "Facebook", INSTAGRAM: "Instagram", TIKTOK: "TikTok", LINKEDIN: "LinkedIn",
  X: "X", YOUTUBE: "YouTube", WHATSAPP: "WhatsApp",
};

export function approvalBatch(request: Request, actor: string) {
  const batch = request.headers.get("x-showwork-approval-batch");
  return batch && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batch)
    ? createHash("sha256").update(JSON.stringify([actor, batch])).digest("hex") : undefined;
}

export async function recordWorkspaceNotice(event: WorkspaceNotice, query?: Query) {
  try {
    const write = query ?? (async (sql, args) => {
      const { db } = await import("@/lib/db");
      return db.$executeRawUnsafe(sql, ...args);
    });
    await write(`
      INSERT INTO "WorkspaceNotification" ("calendarId", "eventKey", kind, "batchId", actor, title, description, "postId", "focusDate")
      VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT COALESCE(NULLIF(name, ''), email) FROM "Creator" WHERE id = $6)), $7, $8, $9, $10)
      ON CONFLICT ("calendarId", "eventKey") DO NOTHING RETURNING "eventKey"
    `, [event.calendarId, `${event.kind}:${event.key}`, event.kind, event.batchId ?? null, event.actor ?? null,
      event.actorId ?? null, event.title, event.description ?? null, event.postId ?? null, event.focusDate ?? null]);
  } catch (error) {
    console.warn("[Workspace notifications] Could not record activity", { kind: event.kind, error: error instanceof Error ? error.name : "UnknownError" });
  }
}

export function recordChannelConnected(input: {
  calendarId: string; connectionId: string; platform: string; connectedAt: Date; actorId: string; accountName?: string | null;
}, query?: Query) {
  return recordWorkspaceNotice({
    calendarId: input.calendarId, key: `${input.connectionId}:${input.connectedAt.toISOString()}`,
    kind: "channel", actorId: input.actorId, description: input.accountName ?? undefined,
    title: `${channelNames[input.platform] ?? input.platform} connected`,
  }, query);
}
