export function clientReviewLocked(post: { publishStatus?: string | null; instagramPublishStatus?: string | null; tikTokPublishStatus?: string | null }) {
  return [post.publishStatus, post.instagramPublishStatus, post.tikTokPublishStatus].some(status => status && ["PUBLISHING", "PUBLISHED"].includes(status));
}
export function clientRevisionNote(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Tell your team what you would like changed.");
  const note = value.trim();
  if (note.length > 4000) throw new Error("Keep feedback within 4,000 characters.");
  return note;
}
