import { Queue, type JobsOptions } from 'bullmq';
import type { SocialPlatform } from '@prisma/client';
import { getRedisConnection } from '../redis';

export const PUBLISHING_QUEUE_NAME = 'publishing';

export interface PublishJobData {
  postId: string;
  platform: SocialPlatform;
  scheduledFor?: string;
  calendarId?: string;
}

let publishingQueue: Queue<PublishJobData> | null = null;

export function getPublishingQueue(): Queue<PublishJobData> {
  if (!publishingQueue) {
    publishingQueue = new Queue<PublishJobData>(PUBLISHING_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 86400 * 7, // 7 days
          count: 2000,
        },
        removeOnFail: {
          age: 86400 * 30, // 30 days
          count: 5000,
        },
      },
    });
  }
  return publishingQueue;
}

export async function enqueuePublishJob(
  postId: string,
  platform: SocialPlatform,
  runAt?: Date | null,
  metadata?: { calendarId?: string }
) {
  const queue = getPublishingQueue();
  const now = Date.now();
  const scheduledTime = runAt ? runAt.getTime() : now;
  const delay = Math.max(0, scheduledTime - now);
  const jobId = `publish-${postId}`;

  const jobOptions: JobsOptions = {
    jobId,
    delay,
  };

  const job = await queue.add(
    'publish-post',
    {
      postId,
      platform,
      scheduledFor: runAt ? runAt.toISOString() : undefined,
      calendarId: metadata?.calendarId,
    },
    jobOptions
  );

  return job;
}

export async function removePublishJob(postId: string) {
  const queue = getPublishingQueue();
  const jobId = `publish-${postId}`;
  const job = await queue.getJob(jobId);
  if (job) {
    await job.remove();
    return true;
  }
  return false;
}
