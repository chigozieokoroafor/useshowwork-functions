import type {
  ContentWorkspaceStorageReservation,
  Prisma,
} from "@prisma/client";

/** All consumers and releasers must lock the receipt before touching owner usage. */
export async function lockWorkspaceUploadReservation(
  tx: Prisma.TransactionClient,
  id: string,
) {
  const rows = await tx.$queryRaw<ContentWorkspaceStorageReservation[]>`
    SELECT *
    FROM "ContentWorkspaceStorageReservation" WHERE id = ${id} FOR UPDATE
  `;
  if (!rows[0]) return null;
  // Evaluate expiry after acquiring the lock, including any time spent waiting.
  const clock = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  return { ...rows[0], live: rows[0].expiresAt > clock[0].now };
}

/** Counter readers that calculate a decrement must serialize with atomic writers. */
export async function lockWorkspaceUploadUsage(
  tx: Prisma.TransactionClient,
  creatorId: string,
) {
  await tx.$queryRaw`SELECT "creatorId" FROM "ContentWorkspaceUsage" WHERE "creatorId" = ${creatorId} FOR UPDATE`;
}
