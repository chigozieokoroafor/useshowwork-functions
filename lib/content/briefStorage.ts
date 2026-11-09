import type { PrismaClient } from "@prisma/client";

/** Select no customer content: validate both the loaded client and database columns before AI work. */
export async function checkBriefStorage(database: Pick<PrismaClient, "calendarPost" | "calendarPostAiGeneration">, calendarId: string): Promise<boolean> {
  try {
    await database.calendarPost.findFirst({
      where: { calendarId, id: "__showwork_schema_probe__" }, select: { creativeBrief: true, creativeDevelopment: true },
    });
    await database.calendarPostAiGeneration.findFirst({
      where: { id: "__showwork_schema_probe__", post: { calendarId } }, select: { creativeBrief: true, creativeDevelopment: true },
    });
    return true;
  } catch {
    return false;
  }
}

