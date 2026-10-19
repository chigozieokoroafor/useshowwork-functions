import { db } from './db';

export type AiGenerationJobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface AiGenerationJobRecord {
  id: string;
  calendarId: string;
  creatorId: string;
  status: AiGenerationJobStatus;
  payload: any;
  result: any;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export async function createAiGenerationJob(params: {
  id?: string;
  calendarId: string;
  creatorId: string;
  payload: Record<string, unknown>;
}): Promise<AiGenerationJobRecord> {
  const id = params.id || (await import('crypto')).randomUUID();
  const rows = await db.$queryRawUnsafe<AiGenerationJobRecord[]>(
    'INSERT INTO "AiGenerationJob" ("id", "calendarId", "creatorId", "status", "payload", "createdAt") VALUES ($1, $2, $3, $4, $5::jsonb, NOW()) RETURNING *',
    id,
    params.calendarId,
    params.creatorId,
    'PENDING',
    JSON.stringify(params.payload)
  );
  return rows[0];
}

export async function getAiGenerationJob(id: string): Promise<AiGenerationJobRecord | null> {
  const rows = await db.$queryRawUnsafe<AiGenerationJobRecord[]>(
    'SELECT * FROM "AiGenerationJob" WHERE "id" = $1 LIMIT 1',
    id
  );
  return rows[0] || null;
}

export async function updateAiGenerationJob(
  id: string,
  update: {
    status?: AiGenerationJobStatus;
    result?: Record<string, unknown> | null;
    error?: string | null;
    startedAt?: Date;
    completedAt?: Date;
  }
): Promise<void> {
  const sets: string[] = [];
  const values: any[] = [id];
  let idx = 2;

  if (update.status) {
    sets.push('"status" = $' + (idx++));
    values.push(update.status);
  }
  if (update.result !== undefined) {
    sets.push('"result" = $' + (idx++) + '::jsonb');
    values.push(update.result ? JSON.stringify(update.result) : null);
  }
  if (update.error !== undefined) {
    sets.push('"error" = $' + (idx++));
    values.push(update.error);
  }
  if (update.startedAt) {
    sets.push('"startedAt" = $' + (idx++));
    values.push(update.startedAt);
  }
  if (update.completedAt) {
    sets.push('"completedAt" = $' + (idx++));
    values.push(update.completedAt);
  }

  if (sets.length === 0) return;

  await db.$executeRawUnsafe(
    'UPDATE "AiGenerationJob" SET ' + sets.join(', ') + ' WHERE "id" = $1',
    ...values
  );
}

export async function claimNextPendingAiGenerationJob(): Promise<AiGenerationJobRecord | null> {
  const rows = await db.$queryRawUnsafe<AiGenerationJobRecord[]>(
    'UPDATE "AiGenerationJob" SET "status" = \'PROCESSING\', "startedAt" = NOW() WHERE "id" = (SELECT "id" FROM "AiGenerationJob" WHERE "status" = \'PENDING\' ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *'
  );
  return rows[0] || null;
}
