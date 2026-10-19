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

let tableEnsured = false;

export async function ensureAiGenerationJobTable(): Promise<void> {
  if (tableEnsured) return;
  try {
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AiGenerationJob" (
        "id" TEXT PRIMARY KEY,
        "calendarId" TEXT NOT NULL,
        "creatorId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "payload" JSONB NOT NULL,
        "result" JSONB,
        "error" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "startedAt" TIMESTAMP(3),
        "completedAt" TIMESTAMP(3)
      )
    `);
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "idx_ai_gen_job_status" ON "AiGenerationJob" ("status", "createdAt")');
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "idx_ai_gen_job_calendar" ON "AiGenerationJob" ("calendarId")');
    tableEnsured = true;
  } catch (err: any) {
    console.error('[AiGenerationJob] Table bootstrap note/error:', err?.message || err);
  }
}

export async function createAiGenerationJob(params: {
  id?: string;
  calendarId: string;
  creatorId: string;
  payload: Record<string, unknown>;
}): Promise<AiGenerationJobRecord> {
  await ensureAiGenerationJobTable();
  const id = params.id || (await import('crypto')).randomUUID();
  try {
    const rows = await db.$queryRawUnsafe<AiGenerationJobRecord[]>(
      'INSERT INTO "AiGenerationJob" ("id", "calendarId", "creatorId", "status", "payload", "createdAt") VALUES ($1, $2, $3, $4, $5::jsonb, NOW()) RETURNING *',
      id,
      params.calendarId,
      params.creatorId,
      'PENDING',
      JSON.stringify(params.payload)
    );
    return rows[0];
  } catch (err: any) {
    if (err?.code === '42P01') {
      tableEnsured = false;
      await ensureAiGenerationJobTable();
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
    throw err;
  }
}

export async function getAiGenerationJob(id: string): Promise<AiGenerationJobRecord | null> {
  await ensureAiGenerationJobTable();
  try {
    const rows = await db.$queryRawUnsafe<AiGenerationJobRecord[]>(
      'SELECT * FROM "AiGenerationJob" WHERE "id" = $1 LIMIT 1',
      id
    );
    return rows[0] || null;
  } catch (err: any) {
    if (err?.code === '42P01') return null;
    throw err;
  }
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
  await ensureAiGenerationJobTable();
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

  try {
    await db.$executeRawUnsafe(
      'UPDATE "AiGenerationJob" SET ' + sets.join(', ') + ' WHERE "id" = $1',
      ...values
    );
  } catch (err: any) {
    if (err?.code === '42P01') {
      tableEnsured = false;
      await ensureAiGenerationJobTable();
      await db.$executeRawUnsafe(
        'UPDATE "AiGenerationJob" SET ' + sets.join(', ') + ' WHERE "id" = $1',
        ...values
      );
      return;
    }
    throw err;
  }
}

export async function claimNextPendingAiGenerationJob(): Promise<AiGenerationJobRecord | null> {
  await ensureAiGenerationJobTable();
  try {
    const rows = await db.$queryRawUnsafe<AiGenerationJobRecord[]>(
      'UPDATE "AiGenerationJob" SET "status" = \'PROCESSING\', "startedAt" = NOW() WHERE "id" = (SELECT "id" FROM "AiGenerationJob" WHERE "status" = \'PENDING\' ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *'
    );
    return rows[0] || null;
  } catch (err: any) {
    if (err?.code === '42P01') {
      tableEnsured = false;
      await ensureAiGenerationJobTable();
      return null;
    }
    throw err;
  }
}
