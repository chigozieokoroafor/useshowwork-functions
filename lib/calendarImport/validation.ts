import {calendarPostData,POST_TEXT_FIELDS} from "@/lib/calendarPosts";
import {approvalFor,parsePlatforms,rowIssues,type ImportOptions,type ImportRow} from "./mapping";
import type {SocialPlatform} from "@prisma/client";

export class ImportError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export type ImportSelection = ImportRow & { keepPossibleDuplicate?: boolean };
export type ConfirmInput = {
  requestId: string;
  options: ImportOptions;
  rows: ImportSelection[];
  confirmApprovals: boolean;
};
export function validateConfirm(input: unknown): ConfirmInput {
  if (!input || typeof input !== "object")
    throw new ImportError("Invalid import request.");
  const body = input as ConfirmInput;
  if (
    typeof body.requestId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(body.requestId)
  )
    throw new ImportError("Invalid import request ID.");
  if (
    !body.options ||
    typeof body.options.timezone !== "string" ||
    body.options.timezone.length > 100 ||
    !["ASK", "DMY", "MDY"].includes(body.options.dateOrder)
  )
    throw new ImportError("Invalid date options.");
  for (const field of ["year", "defaultTime", "defaultPlatform"] as const)
    if (typeof body.options[field] !== "string")
      throw new ImportError("Invalid import options.");
  if (body.options.timeFormat !== undefined && !["ASK", "24H"].includes(body.options.timeFormat))
    throw new ImportError("Choose a valid time format.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: body.options.timezone });
  } catch {
    throw new ImportError("Choose a valid timezone.");
  }
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 200)
    throw new ImportError("Choose between 1 and 200 items to import.");
  const ids = new Set<string>();
  for (const row of body.rows) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.id !== "string" ||
      row.id.length > 100 ||
      ids.has(row.id)
    )
      throw new ImportError("Invalid or repeated content item.");
    ids.add(row.id);
    for (const field of [
      "source",
      "date",
      "time",
      "platform",
      "notes",
      "status",
      ...POST_TEXT_FIELDS,
    ]) {
      const value = row[field as keyof ImportRow];
      if (typeof value !== "string" || value.length > 20000)
        throw new ImportError(`Invalid ${field} field.`);
    }
    if (
      !Array.isArray(row.customFields) ||
      !Array.isArray(row.warnings) ||
      row.warnings.some((value) => typeof value !== "string")
    )
      throw new ImportError("Invalid content item details.");
    const issues = rowIssues(row, body.options);
    if (issues.errors.length)
      throw new ImportError(
        `${row.source.slice(0, 100)}: ${issues.errors.join(" ")}`,
      );
    if (
      approvalFor(row.status) === "APPROVED" &&
      body.confirmApprovals !== true
    )
      throw new ImportError(
        "Confirm that imported approved posts will be locked.",
      );
    try {
      calendarPostData(
        "validation",
        { ...row, postDate: issues.iso, customFields: importCustomFields(row) },
        parsePlatforms(row.platform)[0] as SocialPlatform,
      );
    } catch (error) {
      throw new ImportError(
        error instanceof Error ? error.message : "Invalid content fields.",
      );
    }
  }
  if (
    body.rows.reduce(
      (count, row) => count + parsePlatforms(row.platform).length,
      0,
    ) > 500
  )
    throw new ImportError("At most 500 platform posts per import.");
  return body;
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
