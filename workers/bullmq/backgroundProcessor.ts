import type { Job } from 'bullmq';
import type { BackgroundJobData } from '../../lib/queues/backgroundQueue';
import { enqueuePublishJob } from '../../lib/queues/publishingQueue';
import { db } from '../../lib/db';
import { PUBLISHING_PLATFORMS, statusWhere } from '../../lib/publishing/state';
import { syncSocialInboxes } from '../../lib/socialMessaging/x';
import { processSocialInboxAutoReplies } from '../../lib/socialMessaging/autoReply';
import { syncConnectedSocialReporting } from '../../lib/reporting/sync';
import { reconcileOfferExpirations } from '../../lib/billingOffers';
import { runCalendarTrialEmailCheck } from '../../lib/calendarTrialEmails';
import { runScheduledAiBusinessResearch } from '../../lib/aiResearchScheduler';
import { deliverBenefitEmails } from '../../lib/billingBenefitNotifications';
import { cleanupExpiredContentWorkspaceStorageReservations } from '../../lib/contentWorkspaceUsage';
import { cleanupTikTokPreparedFiles } from '../../lib/r2';
import { runLifecycleEmailCheck } from '../../lib/lifecycleEmails';
import { reconcilePaymentBatch } from '../../lib/paymentReconciliation';

export async function processBackgroundJob(job: Job<BackgroundJobData>) {
  const { jobType } = job.data;
  console.log(`[BullMQ Background] Executing background task: ${jobType}`);

  try {
    switch (jobType) {
      case 'scheduled-publishing-scanner':
        return await scanAndEnqueueScheduledPosts();

      case 'social-inbox-sync': {
        const summary = await syncSocialInboxes();
        console.log('[BullMQ Background] social-inbox-sync finished:', summary);
        return { success: true, summary };
      }

      case 'social-inbox-auto-replies': {
        const summary = await processSocialInboxAutoReplies();
        console.log('[BullMQ Background] social-inbox-auto-replies finished:', summary);
        return { success: true, summary };
      }

      case 'reporting-sync': {
        const summary = await syncConnectedSocialReporting();
        console.log('[BullMQ Background] reporting-sync finished:', summary);
        return { success: true, summary };
      }

      case 'billing-offers': {
        const summary = await reconcileOfferExpirations();
        console.log('[BullMQ Background] billing-offers finished:', summary);
        return { success: true, summary };
      }

      case 'calendar-trial-emails': {
        const summary = await runCalendarTrialEmailCheck();
        console.log('[BullMQ Background] calendar-trial-emails finished:', summary);
        return { success: true, summary };
      }

      case 'ai-research': {
        const summary = await runScheduledAiBusinessResearch();
        console.log('[BullMQ Background] ai-research finished:', summary);
        return { success: true, summary };
      }

      case 'billing-benefit-emails': {
        const summary = await deliverBenefitEmails();
        console.log('[BullMQ Background] billing-benefit-emails finished:', summary);
        return { success: true, summary };
      }

      case 'content-workspace-storage': {
        const storageSummary = await cleanupExpiredContentWorkspaceStorageReservations();
        const preparedMedia = await cleanupTikTokPreparedFiles();
        const summary = { ...storageSummary, preparedMedia };
        console.log('[BullMQ Background] content-workspace-storage finished:', summary);
        return { success: true, summary };
      }

      case 'lifecycle-emails': {
        const summary = await runLifecycleEmailCheck();
        console.log('[BullMQ Background] lifecycle-emails finished:', summary);
        return { success: true, summary };
      }

      case 'payment-revenue': {
        const summary = await reconcilePaymentBatch();
        console.log('[BullMQ Background] payment-revenue finished:', summary);
        return { success: true, summary };
      }

      default:
        console.warn(`[BullMQ Background] Unknown background task: ${jobType}`);
        return { skipped: true, reason: 'UNKNOWN_JOB_TYPE' };
    }
  } catch (err) {
    console.error(`[BullMQ Background] Error executing ${jobType}:`, err);
    throw err;
  }
}

async function scanAndEnqueueScheduledPosts() {
  const now = new Date();
  const duePosts = await db.calendarPost.findMany({
    where: {
      OR: PUBLISHING_PLATFORMS.map(platform => statusWhere(platform, 'SCHEDULED')),
      approvalStatus: 'APPROVED',
      isAiDraft: false,
      postDate: { lte: now },
    },
    select: {
      id: true,
      platform: true,
      calendarId: true,
      postDate: true,
    },
    take: 50,
  });

  if (duePosts.length === 0) {
    return { queued: 0 };
  }

  console.log(`[BullMQ Scanner] Found ${duePosts.length} due post(s). Enqueueing to publishing queue...`);
  let queuedCount = 0;

  for (const post of duePosts) {
    try {
      await enqueuePublishJob(post.id, post.platform, post.postDate, {
        calendarId: post.calendarId,
      });
      queuedCount++;
    } catch (err) {
      console.error(`[BullMQ Scanner] Failed to enqueue post ${post.id}:`, err);
    }
  }

  return { queued: queuedCount };
}
