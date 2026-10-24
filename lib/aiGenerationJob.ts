/** Compatibility facade for older AI worker callers. The Prisma job schema is
 * authoritative: request/result/httpStatus and RUNNING, never a second table. */
import { db } from "./db";
import type { AiGenerationJob } from "@prisma/client";

export type AiGenerationJobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface AiGenerationJobRecord {
  id: string;
  calendarId: string;
  creatorId: string;
  status: AiGenerationJobStatus;
  payload: any;
  request?: any;
  result: any;
  error: string | null;
  httpStatus?: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

function legacy(job: AiGenerationJob): AiGenerationJobRecord {
  const result = job.result;
  const payload = (job as any).payload ?? job.request ?? {};
  const request = job.request ?? (job as any).payload ?? {};
  return {
    id: job.id,
    calendarId: job.calendarId,
    creatorId: job.creatorId,
    status: (job.status === "RUNNING" ? "PROCESSING" : job.status) as AiGenerationJobStatus,
    payload,
    request,
    result,
    error: (result && typeof result === "object" && !Array.isArray(result) && typeof (result as any).error === "string")
      ? (result as any).error
      : (job.error ?? null),
    httpStatus: job.httpStatus ?? (job.status === "COMPLETED" ? 200 : job.status === "FAILED" ? 500 : null),
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? (job.status === "PENDING" ? null : (job as any).updatedAt ?? job.createdAt),
    completedAt: ["COMPLETED", "FAILED"].includes(job.status)
      ? (job.completedAt ?? (job as any).updatedAt ?? job.createdAt)
      : null,
  };
}

export const normalizeAiJobRecord = legacy;

/** Schema creation belongs to migrations, not a running worker. */
export async function ensureAiGenerationJobTable(): Promise<void> {}

export async function createAiGenerationJob(params: {
  id?: string;
  calendarId: string;
  creatorId: string;
  payload?: Record<string, unknown>;
  request?: Record<string, unknown>;
}): Promise<AiGenerationJobRecord> {
  const input = params.request ?? params.payload ?? {};
  const job = await db.aiGenerationJob.create({
    data: {
      ...(params.id ? { id: params.id } : {}),
      calendarId: params.calendarId,
      creatorId: params.creatorId,
      status: "PENDING",
      request: JSON.parse(JSON.stringify(input)),
      payload: JSON.parse(JSON.stringify(input)),
    },
  });
  return legacy(job);
}

export async function getAiGenerationJob(id: string): Promise<AiGenerationJobRecord | null> {
  const job = await db.aiGenerationJob.findUnique({
    where: { id },
  });
  return job ? legacy(job) : null;
}

export async function updateAiGenerationJob(
  id: string,
  update: {
    status?: AiGenerationJobStatus | "RUNNING";
    result?: Record<string, unknown> | null;
    error?: string | null;
    httpStatus?: number | null;
    startedAt?: Date;
    completedAt?: Date;
  }
): Promise<void> {
  const terminal = update.status === "COMPLETED" || update.status === "FAILED";
  const result = update.error ? { error: update.error } : update.result;
  const valid = result && typeof result === "object" && !Array.isArray(result);
  const failed = update.status === "FAILED" || (terminal && !valid);
  const status = failed ? "FAILED" : update.status === "PROCESSING" ? "RUNNING" : update.status;
  const httpStatus = update.httpStatus ?? (terminal ? (failed ? 500 : 200) : undefined);

  const data: any = {
    ...(status ? { status } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(valid
      ? { result: JSON.parse(JSON.stringify(result)) }
      : terminal
      ? { result: { error: update.error || "AI generation did not return a result. Check your drafts before retrying." } }
      : {}),
    ...(update.error !== undefined ? { error: update.error } : {}),
    ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
    ...(update.completedAt !== undefined ? { completedAt: update.completedAt } : {}),
  };

  await db.aiGenerationJob.update({
    where: { id },
    data,
  });
}

export async function claimNextPendingAiGenerationJob(): Promise<AiGenerationJobRecord | null> {
  return await db.$transaction(async (tx) => {
    const nextJob = await tx.aiGenerationJob.findFirst({
      where: {
        status: "PENDING",
        createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!nextJob) return null;

    const claimed = await tx.aiGenerationJob.update({
      where: { id: nextJob.id },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
      },
    });

    return legacy(claimed);
  });
}
