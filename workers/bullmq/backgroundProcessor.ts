import type { Job } from 'bullmq';
import type { BackgroundJobData } from '../../lib/queues/backgroundQueue';
import { enqueuePublishJob } from '../../lib/queues/publishingQueue';
import { db } from '../../lib/db';
import { PUBLISHING_PLATFORMS, statusWhere } from '../../lib/publishing/state';

export async function processBackgroundJob(job: Job<BackgroundJobData>) {
  const { jobType } = job.data;
  console.log(`[BullMQ Background] Executing background task: ${jobType}`);

  if (jobType === 'scheduled-publishing-scanner') {
    return await scanAndEnqueueScheduledPosts();
  }

  // API-triggered cron jobs
  const siteUrl = (
    process.env.URL ||
    process.env.DEPLOY_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.warn('[BullMQ Background] CRON_SECRET is not configured in .env. Skipping HTTP cron dispatch.');
    return { skipped: true, reason: 'CRON_SECRET_MISSING' };
  }

  const endpointMap: Record<string, string> = {
    'social-inbox-sync': '/api/cron/social-inbox-sync',
    'social-inbox-auto-replies': '/api/cron/social-inbox-auto-replies',
    'reporting-sync': '/api/cron/reporting-sync',
    'billing-offers': '/api/cron/billing-offers',
    'calendar-trial-emails': '/api/cron/calendar-trial-emails',
  };

  const endpoint = endpointMap[jobType];
  if (!endpoint) {
    console.warn(`[BullMQ Background] Unknown background task: ${jobType}`);
    return { skipped: true, reason: 'UNKNOWN_JOB_TYPE' };
  }

  const url = `${siteUrl}${endpoint}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(60_000),
    });

    const status = res.status;
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = await res.text();
    }

    if (!res.ok) {
      console.error(`[BullMQ Background] ${jobType} returned ${status}:`, data);
      throw new Error(`${jobType} failed with status ${status}`);
    }

    console.log(`[BullMQ Background] ${jobType} completed successfully (status ${status}):`, data);
    return { success: true, status, data };
  } catch (err) {
    console.error(`[BullMQ Background] ${jobType} error connecting to ${url}:`, err);
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
