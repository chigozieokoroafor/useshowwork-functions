import type { ReliablePublishingStore } from "./reliableStore";

/** Adapter for a future authenticated application route, not a diagnostic API.
 * Existing route validation remains authoritative; this additional durable guard
 * forbids a manual checkbox from clearing an uncertain publishing intent. */
export function createPublishingActionBoundary(input: {
  authenticate: () => Promise<{ id: string } | null>;
  canManage: (actor: string, calendar: string) => Promise<boolean>;
  jobsForPost: (post: string) => Promise<{ phase: string }[]>;
  store: ReliablePublishingStore;
  existingHandler: (request: Request) => Promise<Response>;
}) {
  return async (request: Request, calendarId: string, postId: string) => {
    const actor = await input.authenticate();
    if (!actor) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!await input.canManage(actor.id, calendarId)) return Response.json({ error: "You cannot publish in this workspace" }, { status: 403 });
    const body = await request.clone().json().catch(() => ({}));
    const jobs = await input.jobsForPost(postId);
    if (["retry","publish","schedule"].includes(body.action) && jobs.some(j => ["EXTERNAL_PENDING","PROVIDER_PENDING","OUTCOME_UNKNOWN","CONFIRMED"].includes(j.phase))) return Response.json({ error: "Existing publishing outcome must be resolved; create a new post to repost confirmed content" }, { status: 409 });
    const response = await input.existingHandler(request);
    if (response.ok && body.action === "retry" && body.confirmedNotPublished === true) await input.store.authorizeKnownRejectedRetry(postId, actor.id);
    return response;
  };
}
