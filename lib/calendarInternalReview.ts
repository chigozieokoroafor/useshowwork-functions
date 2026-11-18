import { clientPostBrief } from "./clientPostBrief";
/** Internal decisions are private; clients only receive posts that passed review. */
export function internalReviewInput(body: Record<string, unknown>) {
  if (!['approve', 'request_changes', 'reopen', 'feedback'].includes(String(body.action))) throw new Error('INVALID_INTERNAL_REVIEW_ACTION');
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 0) throw new Error('INVALID_REVIEW_VERSION');
  if (body.note != null && typeof body.note !== 'string') throw new Error('INVALID_REVIEW_NOTE');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > 4000) throw new Error('INVALID_REVIEW_NOTE_TOO_LONG');
  if (['request_changes','feedback'].includes(String(body.action)) && !note) throw new Error('A note is required when sharing feedback or requesting changes.');
  return { status: body.action === 'approve' ? 'APPROVED' as const : body.action === 'request_changes' ? 'NEEDS_CHANGES' as const : body.action === 'feedback' ? undefined : 'PENDING' as const, note: note || null, version: Number(body.version) };
}
export function internalReviewError(post: { isAiDraft?: boolean; approvalStatus: string; publishStatus?: string; instagramPublishStatus?: string; tikTokPublishStatus?: string }, status: string | undefined) {
  if (post.isAiDraft && status !== "APPROVED") return 'Confirm this AI draft before internal review.';
  if ([post.publishStatus, post.instagramPublishStatus, post.tikTokPublishStatus].some(s => s && ['SCHEDULED','PUBLISHING','PUBLISHED'].includes(s))) return 'This post is already scheduled, publishing or published.';
  if (post.approvalStatus === 'APPROVED') return 'Client-approved content is locked.';
  return null;
}
export function withoutInternalReview<T extends Record<string, unknown>>(post: T) {
  const {internalReviewStatus, internalReviewNote, internalReviewedAt, internalReviewedBy, internalReviewVersion, ...publicPost} = post;
  return {...publicPost,...("creativeBrief" in publicPost ? {creativeBrief:clientPostBrief(publicPost.creativeBrief)} : {})};
}
