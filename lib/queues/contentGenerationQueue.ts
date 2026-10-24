import { Queue, type JobsOptions } from 'bullmq';
import { getRedisConnection } from '../redis';

export const CONTENT_GENERATION_QUEUE_NAME = 'content-generation';

export interface ContentGenerationJobData {
  jobId: string;
  calendarId: string;
  creatorId: string;
  payload: any;
  request?: any;
}

let contentGenerationQueue: Queue<ContentGenerationJobData> | null = null;

export function getContentGenerationQueue(): Queue<ContentGenerationJobData> {
  if (!contentGenerationQueue) {
    contentGenerationQueue = new Queue<ContentGenerationJobData>(CONTENT_GENERATION_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 1, // AI generation shouldn't silently re-spend tokens without review
        removeOnComplete: {
          age: 86400 * 3, // 3 days
          count: 500,
        },
        removeOnFail: {
          age: 86400 * 7, // 7 days
          count: 500,
        },
      },
    });
  }
  return contentGenerationQueue;
}

export async function enqueueContentGenerationJob(
  jobId: string,
  data: ContentGenerationJobData
) {
  const queue = getContentGenerationQueue();
  return await queue.add('generate-content', data, {
    jobId: `ai-gen-${jobId}`,
  });
}
