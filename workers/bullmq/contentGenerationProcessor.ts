import { Job } from 'bullmq';
import { db } from '../../lib/db';
import { generateContentCalendar } from '../../lib/openai';
import { updateAiGenerationJob } from '../../lib/aiGenerationJob';
import type { ContentGenerationJobData } from '../../lib/queues/contentGenerationQueue';
import type { SocialPlatform } from '@prisma/client';

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function processContentGenerationJob(job: Job<ContentGenerationJobData>) {
  const { jobId, calendarId, creatorId, payload } = job.data;
  console.log(`[BullMQ AI Gen] Starting generation job ${jobId} for calendar ${calendarId}...`);

  await updateAiGenerationJob(jobId, { status: 'PROCESSING', startedAt: new Date() });

  try {
    const calendar = await db.socialCalendar.findUnique({ where: { id: calendarId } });
    if (!calendar) throw new Error('Calendar not found');
    if (!calendar.aiBusinessSummary?.trim()) {
      throw new Error('Upload at least one business document first, so the AI understands what to create content about');
    }

    const {
      startDate,
      endDate,
      postsPerWeek,
      platforms,
      customInstructions,
      contentStrategy,
      contentGroups,
      scheduleStrategy,
      platformSchedules,
    } = payload;

    const schedules = platformSchedules && typeof platformSchedules === 'object' ? platformSchedules : {};

    console.log(`[BullMQ AI Gen] Calling OpenAI for calendar ${calendarId} (range: ${startDate} to ${endDate}, platforms: ${platforms?.join(', ') || 'none'})...`);

    const ideas = await generateContentCalendar({
      clientName: calendar.clientName,
      businessSummary: calendar.aiBusinessSummary,
      startDate,
      endDate,
      postsPerWeek: typeof postsPerWeek === 'number' ? postsPerWeek : 3,
      platforms: platforms as SocialPlatform[],
      customInstructions: typeof customInstructions === 'string' && customInstructions.trim() ? customInstructions.trim() : undefined,
      contentStrategy: contentStrategy,
      contentGroups: contentGroups,
      scheduleStrategy: scheduleStrategy,
      platformSchedules: schedules,
    });

    if (!ideas || ideas.length === 0) {
      throw new Error('The AI returned no content. Please try again.');
    }

    const rows = ideas.map((idea) => {
      if (!isRealDate(idea.postDate)) throw new Error('Generated content contains an invalid date.');
      const postTime = schedules[idea.platform]?.time ?? '09:00';
      if (typeof postTime !== 'string' || !TIME_RE.test(postTime)) throw new Error(`Invalid time for ${idea.platform}`);
      const postDate = new Date(`${idea.postDate}T${postTime}:00.000Z`);
      if (!Number.isFinite(postDate.getTime())) throw new Error(`Invalid timestamp for ${idea.platform}`);

      return {
        calendarId,
        postDate,
        platform: idea.platform,
        postType: idea.postType || null,
        category: idea.category || null,
        hook: idea.hook || null,
        script: idea.script || null,
        caption: idea.caption || null,
        contentIdea: idea.contentIdea || null,
        cta: idea.cta || null,
        hashtags: idea.hashtags || null,
        isAiDraft: true,
      };
    });

    const posts = await db.$transaction(async (tx) => {
      const created = [];
      for (const data of rows) {
        created.push(await tx.calendarPost.create({ data }));
      }
      return created;
    });

    const result = {
      created: posts.length,
      postIds: posts.map((p) => p.id),
      posts,
    };

    await updateAiGenerationJob(jobId, {
      status: 'COMPLETED',
      result,
      completedAt: new Date(),
    });

    console.log(`[BullMQ AI Gen] Successfully completed job ${jobId}: created ${posts.length} drafts!`);
    return result;
  } catch (error: any) {
    console.error(`[BullMQ AI Gen] Job ${jobId} failed:`, error);
    const message = error instanceof Error ? error.message : 'Failed to generate content';

    // Refund AI generation count
    try {
      const calendar = await db.socialCalendar.findUnique({ where: { id: calendarId }, select: { managerId: true } });
      if (calendar?.managerId) {
        await db.contentWorkspaceUsage.updateMany({
          where: { creatorId: calendar.managerId },
          data: { aiGenerationsUsed: { decrement: 1 } },
        });
      }
    } catch (refundError) {
      console.error('[BullMQ AI Gen] Failed to refund usage:', refundError);
    }

    await updateAiGenerationJob(jobId, {
      status: 'FAILED',
      error: message,
      completedAt: new Date(),
    });

    throw error;
  }
}
