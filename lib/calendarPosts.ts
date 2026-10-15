import {
  Prisma,
  type SocialPlatform,
  type TikTokPrivacyLevel,
} from "@prisma/client";
import { Temporal } from "@js-temporal/polyfill";

export const POST_PLATFORMS: SocialPlatform[] = [
  "INSTAGRAM",
  "TIKTOK",
  "YOUTUBE",
  "FACEBOOK",
  "X",
  "LINKEDIN",
];
export function requirePostPlatform(platform: SocialPlatform): Exclude<SocialPlatform, "WHATSAPP"> {
  if (platform === "WHATSAPP") throw new Error("WhatsApp is a messaging-only channel.");
  return platform;
}
export const POST_TEXT_FIELDS = [
  "postType",
  "category",
  "caption",
  "contentIdea",
  "hook",
  "script",
  "cta",
  "hashtags",
  "taggedAccounts",
  "linkUrl",
] as const;
const PRIVACY_LEVELS: TikTokPrivacyLevel[] = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
];

/** Shared by manual creation and confirmed imports. Publishing always starts off. */
export function calendarPostData(
  calendarId: string,
  input: Record<string, unknown>,
  platform: SocialPlatform,
): Prisma.CalendarPostCreateInput {
  if (!POST_PLATFORMS.includes(platform)) throw new Error("Invalid platform.");
  if (
    typeof input.postDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(input.postDate) ||
    !Number.isFinite(new Date(input.postDate).getTime())
  )
    throw new Error("A valid date and time with timezone is required.");
  try {
    Temporal.Instant.from(input.postDate);
  } catch {
    throw new Error("A valid calendar date and time is required.");
  }
  const data: Prisma.CalendarPostCreateInput = {
    calendar: { connect: { id: calendarId } },
    postDate: new Date(input.postDate),
    platform,
  };
  for (const field of POST_TEXT_FIELDS) {
    const value = input[field];
    if (value !== undefined && value !== null && typeof value !== "string")
      throw new Error(`${field} must be text.`);
    if (typeof value === "string" && value.length > 20000)
      throw new Error(`${field} is too long (maximum 20,000 characters).`);
    data[field] = typeof value === "string" ? value.trim() || null : null;
  }
  if (input.customFields !== undefined && !Array.isArray(input.customFields))
    throw new Error("Custom fields must be an array.");
  const fields = (input.customFields ?? []) as unknown[];
  if (fields.length > 50)
    throw new Error("At most 50 custom fields are supported per post.");
  const customFields = fields
    .map((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("label" in value) ||
        !("value" in value) ||
        typeof value.label !== "string" ||
        typeof value.value !== "string"
      )
        throw new Error("Custom fields require text labels and values.");
      if (value.label.length > 200 || value.value.length > 20000)
        throw new Error("Custom field is too long.");
      return { label: value.label.trim(), value: value.value.trim() };
    })
    .filter((value) => value.label && value.value);
  data.customFields = { create: customFields };
  const privacy = input.tikTokPrivacyLevel;
  if (
    privacy != null &&
    !PRIVACY_LEVELS.includes(privacy as TikTokPrivacyLevel)
  )
    throw new Error("Choose a valid TikTok privacy level.");
  data.tikTokPrivacyLevel =
    platform === "TIKTOK"
      ? ((privacy as TikTokPrivacyLevel | undefined) ?? null)
      : null;
  return data;
}

/** Serialize mutations like import confirmation and manual creation within a workspace. */
export async function lockCalendar(
  tx: Prisma.TransactionClient,
  calendarId: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "SocialCalendar" WHERE "id" = ${calendarId} FOR UPDATE`;
}
