import { Job } from "bullmq";
import { db } from "../../lib/db";
import { generateContentCalendar } from "../../lib/openai";
import { updateAiGenerationJob } from "../../lib/aiGenerationJob";
import { checkBriefStorage } from "../../lib/content/briefStorage";
import { parseCreativeBrief } from "../../lib/content/brief";
import { generationCount, scheduledContentDate } from "../../lib/content/schedule";
import { recentContentMemory } from "../../lib/content/creativeGeneration";
import { getBusinessKnowledgeContext } from "../../lib/knowledge/context";
import { ContentGenerationError } from "../../lib/content/generationError";
import type { ContentGenerationJobData } from "../../lib/queues/contentGenerationQueue";
import type { Prisma, SocialPlatform } from "@prisma/client";

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function processContentGenerationJob(job: Job<ContentGenerationJobData>) {
  const { jobId, calendarId, creatorId } = job.data;
  console.log(`[BullMQ AI Gen] Starting generation job ${jobId} for calendar ${calendarId}...`);

  await updateAiGenerationJob(jobId, { status: "PROCESSING", startedAt: new Date() });

  try {
    const calendar = await db.socialCalendar.findUnique({ where: { id: calendarId } });
    if (!calendar) throw new Error("Calendar not found");

    const docCount = await db.calendarBusinessDocument.count({
      where: { calendarId, extractedText: { not: null } },
    });
    if (docCount === 0 && !calendar.aiBusinessSummary?.trim()) {
      throw new Error("Upload at least one business document first, so the AI understands what to create content about");
    }

    if (!await checkBriefStorage(db, calendarId)) {
      throw new Error("Content storage is not ready. The administrator must regenerate Prisma, apply the creative briefs database migration if pending, and restart the application.");
    }

    // Resolve payload safely from job data (supports both "payload" and "request" schemas) or fallback to DB record
    let payload = job.data.payload ?? (job.data as any).request;
    if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
      const dbJob = await db.aiGenerationJob.findUnique({
        where: { id: jobId },
      }).catch(() => null);
      if (dbJob) {
        payload = (dbJob.payload as any) ?? (dbJob.request as any);
      }
    }

    if (!payload || typeof payload !== "object") {
      throw new Error("Missing generation input payload.");
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
      campaignObjective,
      timeZone,
    } = payload;

    if (!startDate || !endDate) {
      throw new Error("Missing required generation dates: startDate and endDate must be specified.");
    }

    const schedules = platformSchedules && typeof platformSchedules === "object" ? platformSchedules : {};

    const { drafts: expectedDrafts, slots: plannedSlots } = generationCount(
      String(startDate),
      String(endDate),
      typeof postsPerWeek === "number" ? postsPerWeek : 3,
      (platforms || []) as string[],
      contentStrategy as string | undefined,
      contentGroups as string[][] | undefined
    );

    console.log(`[BullMQ AI Gen] Preparing business knowledge context for calendar ${calendarId}...`);
    const [businessSummary, recentContent] = await Promise.all([
      getBusinessKnowledgeContext(
        calendarId,
        String(customInstructions ?? ""),
        "content",
        { platforms: (platforms || []) as string[], contentStrategy: contentStrategy as string | undefined }
      ),
      recentContentMemory(calendarId),
    ]);

    console.log(`[BullMQ AI Gen] Calling OpenAI brief generation for calendar ${calendarId} (range: ${startDate} to ${endDate}, expectedDrafts: ${expectedDrafts})...`);

    const ideas = await generateContentCalendar({
      clientName: calendar.clientName,
      businessSummary,
      recentContent,
      campaignObjective: typeof campaignObjective === "string" ? campaignObjective : undefined,
      startDate,
      endDate,
      postsPerWeek: typeof postsPerWeek === "number" ? postsPerWeek : 3,
      platforms: (platforms || []) as SocialPlatform[],
      customInstructions: typeof customInstructions === "string" && customInstructions.trim() ? customInstructions.trim() : undefined,
      contentStrategy: contentStrategy as any,
      contentGroups: contentGroups as any,
      scheduleStrategy: scheduleStrategy as any,
      platformSchedules: schedules,
      onBatch: async (_batchPosts: unknown[], completed: number, total: number) => {
        await updateAiGenerationJob(jobId, {
          result: {
            inProgress: true,
            completedCount: completed,
            totalCount: expectedDrafts || total,
          },
        }).catch(() => {});
      },
    });

    if (!ideas || ideas.length === 0) {
      throw new Error("The AI returned no content. Please try again.");
    }

    console.log(`[BullMQ AI Gen] Validating ${ideas.length} generated draft(s)...`);

    for (const idea of ideas) {
      let brief;
      try {
        brief = parseCreativeBrief(idea.creativeBrief);
      } catch {
        throw new ContentGenerationError("AI_CONTENT_INVALID", "Generated content is missing required fields. No incomplete drafts were saved.");
      }
      if (brief.version !== 2 || !brief.objective.trim() || !brief.targetAudience.trim()) {
        throw new ContentGenerationError("AI_CONTENT_INVALID", "Generated content is missing its objective or target audience. No incomplete drafts were saved.");
      }
    }

    const dailySlots = new Map<string, number>();
    const rows = ideas.map((idea) => {
      if (!isRealDate(idea.postDate)) throw new Error("Generated content contains an invalid date.");
      const postTime = schedules[idea.platform]?.time ?? "09:00";
      if (typeof postTime !== "string" || !TIME_RE.test(postTime)) throw new Error(`Invalid time for ${idea.platform}`);
      const slotKey = `${idea.platform}:${idea.postDate}`;
      const ordinal = dailySlots.get(slotKey) || 0;
      dailySlots.set(slotKey, ordinal + 1);
      const postDate = scheduledContentDate(
        idea.postDate,
        postTime,
        typeof timeZone === "string" ? timeZone : "UTC",
        ordinal
      );
      if (!Number.isFinite(postDate.getTime())) throw new Error(`Invalid timestamp for ${idea.platform}`);

      const brief = idea.creativeBrief ? parseCreativeBrief(idea.creativeBrief) : null;

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
        ...(brief ? { creativeBrief: brief as unknown as Prisma.InputJsonValue } : {}),
        isAiDraft: true,
      };
    });

    console.log(`[BullMQ AI Gen] Persisting ${rows.length} draft posts and snapshots to database...`);

    const posts = await db.$transaction(async (tx) => {
      let created: any[] = [];
      if (typeof (tx.calendarPost as any).createManyAndReturn === "function") {
        try {
          created = await (tx.calendarPost as any).createManyAndReturn({ data: rows });
        } catch {
          created = [];
        }
      }
      if (!created.length) {
        created = [];
        for (const data of rows) {
          created.push(await tx.calendarPost.create({ data }));
        }
      }

      const snapshots = created
        .filter((post) => post.creativeBrief)
        .map((post) => ({
          postId: post.id,
          generationNumber: 1,
          postDate: post.postDate,
          platform: post.platform,
          postType: post.postType,
          category: post.category,
          hook: post.hook,
          script: post.script,
          caption: post.caption,
          contentIdea: post.contentIdea,
          cta: post.cta,
          hashtags: post.hashtags,
          creativeBrief: post.creativeBrief as Prisma.InputJsonValue,
        }));

      if (snapshots.length) {
        await tx.calendarPostAiGeneration.createMany({ data: snapshots });
      }

      return created;
    }, { timeout: 25000 });

    const result = {
      created: posts.length,
      postIds: posts.map((p) => p.id),
      posts,
      httpStatus: 200,
    };

    await updateAiGenerationJob(jobId, {
      status: "COMPLETED",
      result,
      httpStatus: 200,
      completedAt: new Date(),
    });

    console.log(`[BullMQ AI Gen] Successfully completed job ${jobId}: created ${posts.length} drafts with creativeBrief v2!`);
    return result;
  } catch (error: any) {
    console.error(`[BullMQ AI Gen] Job ${jobId} failed:`, error);
    const message = error instanceof Error ? error.message : "Failed to generate content";
    const status = typeof error?.status === "number" && error.status >= 400 && error.status < 600
      ? error.status
      : 500;

    // Refund AI generation count
    try {
      const calendar = await db.socialCalendar.findUnique({ where: { id: calendarId }, select: { managerId: true } });
      if (calendar?.managerId) {
        await db.contentWorkspaceUsage.updateMany({
          where: { creatorId: calendar.managerId, aiGenerationsUsed: { gt: 0 } },
          data: { aiGenerationsUsed: { decrement: 1 } },
        });
      }
    } catch (refundError) {
      console.error("[BullMQ AI Gen] Failed to refund usage:", refundError);
    }

    const errorResult = {
      error: message,
      httpStatus: status,
      failedAt: new Date().toISOString(),
    };

    await updateAiGenerationJob(jobId, {
      status: "FAILED",
      error: message,
      result: errorResult,
      httpStatus: status,
      completedAt: new Date(),
    });

    throw error;
  }
}
