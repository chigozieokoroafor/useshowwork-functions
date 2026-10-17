import { Queue } from 'bullmq';
import { getRedisConnection } from '../redis';

export const BACKGROUND_QUEUE_NAME = 'background-jobs';

export interface BackgroundJobData {
  jobType: 
    | 'social-inbox-sync'
    | 'social-inbox-auto-replies'
    | 'reporting-sync'
    | 'billing-offers'
    | 'calendar-trial-emails'
    | 'scheduled-publishing-scanner'
    | 'ai-research'
    | 'billing-benefit-emails'
    | 'content-workspace-storage'
    | 'lifecycle-emails'
    | 'payment-revenue';
  metadata?: Record<string, unknown>;
}

let backgroundQueue: Queue<BackgroundJobData> | null = null;

export function getBackgroundQueue(): Queue<BackgroundJobData> {
  if (!backgroundQueue) {
    backgroundQueue = new Queue<BackgroundJobData>(BACKGROUND_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 10000,
        },
        removeOnComplete: {
          count: 500,
        },
        removeOnFail: {
          count: 1000,
        },
      },
    });
  }
  return backgroundQueue;
}

export async function registerRepeatableBackgroundJobs() {
  const queue = getBackgroundQueue();

  const schedules: Array<{ jobType: BackgroundJobData['jobType']; pattern: string }> = [
    { jobType: 'scheduled-publishing-scanner', pattern: '* * * * *' },   // every minute
    { jobType: 'billing-benefit-emails', pattern: '* * * * *' },         // every minute
    { jobType: 'social-inbox-auto-replies', pattern: '*/2 * * * *' },    // every 2 mins
    { jobType: 'social-inbox-sync', pattern: '*/5 * * * *' },           // every 5 mins
    { jobType: 'billing-offers', pattern: '*/15 * * * *' },             // every 15 mins
    { jobType: 'payment-revenue', pattern: '*/15 * * * *' },            // every 15 mins
    { jobType: 'reporting-sync', pattern: '17 2 * * *' },               // daily 2:17 AM
    { jobType: 'ai-research', pattern: '0 3 * * *' },                   // daily 3:00 AM
    { jobType: 'calendar-trial-emails', pattern: '0 9 * * *' },         // daily 9:00 AM
    { jobType: 'content-workspace-storage', pattern: '0 0 * * *' },     // daily midnight
    { jobType: 'lifecycle-emails', pattern: '0 0 * * *' },              // daily midnight
  ];

  for (const { jobType, pattern } of schedules) {
    await queue.upsertJobScheduler(
      jobType,
      { pattern },
      {
        name: jobType,
        data: { jobType },
      }
    );
  }

  console.log('Registered BullMQ repeatable background jobs:', schedules.map(s => s.jobType).join(', '));
}
