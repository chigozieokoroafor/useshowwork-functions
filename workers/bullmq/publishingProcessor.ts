import type { Job } from 'bullmq';
import type { PublishJobData } from '../../lib/queues/publishingQueue';
import { db } from '../../lib/db';
import { canAccessCalendarById } from '../../lib/calendarPermissions';
import { publishPostToInstagram } from '../../lib/instagramPublishing';
import { publishPostToTikTok } from '../../lib/tiktokPublishing';
import { recordPublishedSocialPost } from '../../lib/socialReporting';
import { freshConnection } from '../../lib/socialTokens';
import { publishFacebook, publishLinkedIn, publishX } from '../../lib/publishing/providers';
import { buildCaption, validatePublishContent, PUBLISHING_PLATFORMS, statusUpdate, statusWhere, publishingStatus } from '../../lib/publishing/state';

export async function processPublishJob(job: Job<PublishJobData>): Promise<{ success: boolean; postId: string; platform: string; platformPostId?: string }> {
  const { postId, platform } = job.data;
  console.log(`[BullMQ] Starting publish job for post ${postId} to ${platform} (attempt ${job.attemptsMade + 1})`);

  if (!PUBLISHING_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported publishing channel: ${platform}`);
  }

  const post = await db.calendarPost.findUnique({
    where: { id: postId },
    include: { assets: { orderBy: { displayOrder: 'asc' } } },
  });

  if (!post) {
    console.warn(`[BullMQ] Post ${postId} not found in database. Skipping.`);
    return { success: false, postId, platform };
  }

  // Idempotency: if already published, don't publish again!
  if (publishingStatus(post) === 'PUBLISHED') {
    console.log(`[BullMQ] Post ${postId} is already PUBLISHED. Nothing to do.`);
    return { success: true, postId, platform, platformPostId: post.platformPostId ?? undefined };
  }

  // Check workspace permissions
  const hasAccess = await canAccessCalendarById(post.calendarId);
  if (!hasAccess) {
    const errorMsg = 'This workspace is no longer active. Renew access before publishing.';
    await db.calendarPost.updateMany({
      where: { id: postId },
      data: statusUpdate(platform, 'FAILED', errorMsg),
    });
    throw new Error(errorMsg);
  }

  // Validate content
  validatePublishContent(platform, post.assets, buildCaption(post), post.postType);

  // Mark status as PUBLISHING
  await db.calendarPost.updateMany({
    where: { id: postId },
    data: {
      ...statusUpdate(platform, 'PUBLISHING'),
      publishWorkerStartedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  try {
    let resultId: string | undefined;

    if (platform === 'INSTAGRAM') {
      await publishPostToInstagram(postId);
      const updated = await db.calendarPost.findUnique({ where: { id: postId } });
      resultId = updated?.platformPostId ?? undefined;
    } else if (platform === 'TIKTOK') {
      await publishPostToTikTok(postId);
      const updated = await db.calendarPost.findUnique({ where: { id: postId } });
      resultId = updated?.platformPostId ?? undefined;
    } else {
      const stored = await db.socialConnection.findFirst({
        where: { calendarId: post.calendarId, platform, status: 'CONNECTED' },
      });
      if (!stored) {
        throw new Error(`Connect ${platform} channel before publishing.`);
      }
      const connection = await freshConnection(stored);
      const publish = platform === 'FACEBOOK' ? publishFacebook : platform === 'LINKEDIN' ? publishLinkedIn : publishX;
      
      const result = await publish(post, connection, async id => {
        await db.calendarPost.update({ where: { id: postId }, data: { platformPostId: id } });
      });

      const publishedAt = new Date();
      await db.calendarPost.update({
        where: { id: postId },
        data: {
          publishStatus: 'PUBLISHED',
          publishedAt,
          platformPostId: result.id,
          publishPermalink: result.permalink,
          publishError: null,
        },
      });

      resultId = result.id;

      try {
        await recordPublishedSocialPost({
          calendarId: post.calendarId,
          calendarPostId: postId,
          platform,
          platformAccountId: connection.platformAccountId,
          platformPostId: result.id,
          permalink: result.permalink,
          publishedAt,
          platformPostType: post.postType,
        });
      } catch (e) {
        console.error(`[BullMQ] Could not link published ${platform} post ${postId} to reporting:`, e);
      }
    }

    console.log(`[BullMQ] Successfully published post ${postId} to ${platform}! Result ID: ${resultId}`);
    return { success: true, postId, platform, platformPostId: resultId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Publishing failed. Check platform status.';
    console.error(`[BullMQ] Error publishing post ${postId} to ${platform}:`, message);
    await db.calendarPost.updateMany({
      where: { id: postId },
      data: statusUpdate(platform, 'FAILED', message),
    });
    throw error;
  }
}
