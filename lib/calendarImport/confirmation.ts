import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  calendarPostData,
  lockCalendar,
  POST_TEXT_FIELDS,
} from "@/lib/calendarPosts";
import {
  approvalFor,
  duplicateIndex,
  parsePlatforms,
  rowIssues,
  type ImportOptions,
  type ImportRow,
  type ExistingPost,
} from "./mapping";
import type { Prisma, SocialPlatform } from "@prisma/client";

import {validateConfirm,ImportError} from "./validation";
export {validateConfirm,ImportError} from "./validation";
export type {ConfirmInput,ImportSelection} from "./validation";

export async function confirmImport(
  calendarId: string,
  creatorId: string,
  raw: unknown,
) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { return await invokePublishingEntrypoint<{postIds:string[];skipped:string[];firstDate:string|null}>("lib/calendarImport/confirmation.ts#confirmImport@126",[calendarId,creatorId,raw]); } /* end-canonical-integration-boundary */

  const input = validateConfirm(raw);
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return db.$transaction(
    async (tx) => {
      await lockCalendar(tx, calendarId);
      const previous = await tx.calendarImport.findUnique({
        where: {
          calendarId_requestId: { calendarId, requestId: input.requestId },
        },
      });
      if (previous) {
        if (
          previous.creatorId !== creatorId ||
          previous.payloadHash !== payloadHash
        )
          throw new ImportError(
            "This import request was already used. Start a new import for changed content.",
            409,
          );
        return previous.result;
      }
      const existing: ExistingPost[] = await tx.calendarPost.findMany({
        where: { calendarId },
        select: {
          id: true,
          postDate: true,
          platform: true,
          caption: true,
          contentIdea: true,
          hook: true,
          script: true,
          postType: true,
          category: true,
          cta: true,
          hashtags: true,
          taggedAccounts: true,
          linkUrl: true,
          customFields: { select: { label: true, value: true } },
        },
      });
      const duplicates = duplicateIndex(existing, input.options.timezone);
      const postIds: string[] = [],
        skipped: string[] = [];
      const posts: Prisma.CalendarPostCreateManyInput[] = [];
      const fields: Prisma.CalendarPostCustomFieldCreateManyInput[] = [];
      let firstDate: string | null = null;
      for (const row of input.rows) {
        const postDate = rowIssues(row, input.options).iso!;
        for (const platform of parsePlatforms(row.platform)) {
          const candidate: ExistingPost = {
            ...row,
            id: row.id,
            postDate,
            platform,
          };
          if (duplicates.exact(candidate)) {
            skipped.push(`${row.id}:${platform}`);
            continue;
          }
          if (
            duplicates.possible(candidate) &&
            row.keepPossibleDuplicate !== true
          )
            throw new ImportError(
              `Possible duplicate at ${row.source.slice(0, 100)}. Review it and explicitly keep it or exclude the item.`,
              409,
            );
          const customFields = importCustomFields(row);
          const data = calendarPostData(
            calendarId,
            { ...row, postDate, customFields },
            platform as SocialPlatform,
          );
          data.approvalStatus = approvalFor(row.status);
          const id = randomUUID();
          const { calendar, customFields: nestedFields, ...post } = data;
          posts.push({ ...post, id, calendarId });
          for (const field of (nestedFields?.create ?? []) as {
            label: string;
            value: string;
          }[]) {
            fields.push({ ...field, postId: id });
          }
          postIds.push(id);
          if (!firstDate || postDate < firstDate) firstDate = postDate;
          duplicates.add(candidate);
        }
      }
      // Bulk inserts avoid a database round trip for every post and nested field.
      // Keep posts, fields, and the retry receipt in the same locked transaction.
      if (posts.length) await tx.calendarPost.createMany({ data: posts });
      for (let offset = 0; offset < fields.length; offset += 1000) {
        await tx.calendarPostCustomField.createMany({
          data: fields.slice(offset, offset + 1000),
        });
      }
      const result = { postIds, skipped, firstDate };
      await tx.calendarImport.create({
        data: {
          calendarId,
          creatorId,
          requestId: input.requestId,
          payloadHash,
          result: result as Prisma.InputJsonValue,
        },
      });
      return result;
    },
    { maxWait: 10000, timeout: 30000 },
  );
}

function importCustomFields(row: ImportRow) {
  return [
    ...row.customFields,
    ...(row.notes.trim() ? [{ label: "Notes", value: row.notes }] : []),
    ...(row.status.trim()
      ? [{ label: "Source status", value: row.status }]
      : []),
  ];
}
