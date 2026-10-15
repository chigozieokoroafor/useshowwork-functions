import { db } from "@/lib/db";
import { publishingStatus } from "./state";
/** Approved content must stay identical to the content the client reviewed. */
export async function postContentEditError(postId: string, calendarId: string) {
  const post = await db.calendarPost.findFirst({ where: { id: postId, calendarId } });
  if (!post) return "Post not found in this workspace.";
  if (post.approvalStatus === "APPROVED" || ["SCHEDULED", "PUBLISHING", "PUBLISHED"].includes(publishingStatus(post))) return "This post is approved or publishing. Request a revision before changing its content.";
  if (post.tikTokPublishId || post.platformPostId) return "This post already has a platform operation in progress. Reconcile it before changing content, or create a new post.";
  return null;
}
