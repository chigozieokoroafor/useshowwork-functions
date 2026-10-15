import { Temporal } from "@js-temporal/polyfill";

export const IMPORT_PLATFORMS = [
  "INSTAGRAM",
  "TIKTOK",
  "YOUTUBE",
  "FACEBOOK",
  "X",
  "LINKEDIN",
] as const;
export const IMPORT_FIELDS = [
  "date",
  "time",
  "platform",
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
  "notes",
  "status",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type SourceItem = {
  id: string;
  source: string;
  values: Record<string, string>;
  warnings?: string[];
};
export type ImportOptions = {
  timezone: string;
  dateOrder: "ASK" | "DMY" | "MDY";
  year: string;
  defaultTime: string;
  defaultPlatform: string;
  timeFormat?: "ASK" | "24H";
};
export type ImportMapping = Record<string, ImportField | "custom" | "ignore">;
export type ImportRow = {
  id: string;
  source: string;
  date: string;
  time: string;
  platform: string;
  postType: string;
  category: string;
  caption: string;
  contentIdea: string;
  hook: string;
  script: string;
  cta: string;
  hashtags: string;
  taggedAccounts: string;
  linkUrl: string;
  notes: string;
  status: string;
  customFields: { label: string; value: string }[];
  warnings: string[];
};

const aliases: Record<ImportField, string[]> = {
  date: [
    "date",
    "postdate",
    "publishdate",
    "postingdate",
    "scheduleddate",
    "datetime",
    "publicationdate",
    "dateofpublication",
    "scheduledfor",
    "daydate",
    "postingdatetime",
    "publishingdate",
  ],
  time: [
    "time",
    "posttime",
    "publishtime",
    "postingtime",
    "scheduledtime",
    "publishingtime",
  ],
  platform: [
    "platform",
    "platforms",
    "channel",
    "channels",
    "socialplatform",
    "network",
    "socialnetwork",
    "socialmedia",
  ],
  postType: [
    "posttype",
    "contenttype",
    "format",
    "contentformat",
    "type",
    "creativetype",
    "mediaformat",
  ],
  category: ["category", "pillar", "contentpillar", "theme"],
  caption: [
    "caption",
    "copy",
    "postcopy",
    "captioncopy",
    "description",
    "body",
    "content",
    "postcaption",
    "socialcopy",
    "contentdescription",
  ],
  contentIdea: [
    "title",
    "topic",
    "contentidea",
    "idea",
    "subject",
    "posttitle",
    "contenttitle",
  ],
  hook: ["hook"],
  script: ["script"],
  cta: ["cta", "calltoaction"],
  hashtags: ["hashtags", "tags"],
  taggedAccounts: ["taggedaccounts", "mentions", "accounts"],
  linkUrl: ["link", "url", "linkurl", "destinationurl"],
  notes: ["notes", "note", "brief", "instructions"],
  status: ["status", "approvalstatus", "workflowstatus"],
};
export function suggestField(header: string): ImportField | "custom" {
  const key = header.toLowerCase().replace(/[^a-z]/g, "");
  return (
    IMPORT_FIELDS.find((field) => aliases[field].includes(key)) ?? "custom"
  );
}
export function suggestMapping(items: SourceItem[]): ImportMapping {
  return Object.fromEntries(
    [...new Set(items.flatMap((item) => Object.keys(item.values)))].map(
      (header) => [header, suggestField(header)],
    ),
  );
}
export function mapItems(
  items: SourceItem[],
  mapping: ImportMapping,
  options: ImportOptions,
): ImportRow[] {
  return items.map((item) => {
    const row: ImportRow = {
      id: item.id,
      source: item.source,
      date: "",
      time: "",
      platform: "",
      postType: "",
      category: "",
      caption: "",
      contentIdea: "",
      hook: "",
      script: "",
      cta: "",
      hashtags: "",
      taggedAccounts: "",
      linkUrl: "",
      notes: "",
      status: "",
      customFields: [],
      warnings: item.warnings ?? [],
    };
    for (const [header, value] of Object.entries(item.values)) {
      const field = mapping[header] ?? "custom";
      if (field === "custom" && value.trim())
        row.customFields.push({ label: header, value });
      else if (field !== "ignore" && field !== "custom")
        row[field] = [row[field], value]
          .filter(Boolean)
          .join(field === "platform" ? ", " : "\n");
    }
    if (!row.platform.trim()) row.platform = options.defaultPlatform;
    return row;
  });
}

export function parsePlatforms(value: string): string[] {
  const names: Record<string, string> = {
    ig: "INSTAGRAM",
    instagram: "INSTAGRAM",
    fb: "FACEBOOK",
    facebook: "FACEBOOK",
    tt: "TIKTOK",
    tiktok: "TIKTOK",
    yt: "YOUTUBE",
    youtube: "YOUTUBE",
    linkedin: "LINKEDIN",
    li: "LINKEDIN",
    twitter: "X",
    x: "X",
  };
  const parts = value
    .toLowerCase()
    .split(/[,;|/&+\n]+|\band\b/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("Choose a platform.");
  return [
    ...new Set(
      parts.map((p) => {
        const platform = names[p.replace(/\s/g, "")];
        if (!platform) throw new Error(`Unsupported platform: ${p}.`);
        return platform;
      }),
    ),
  ];
}

export function resolveDate(
  dateValue: string,
  timeValue: string,
  options: ImportOptions,
): { iso: string; local: string; warnings: string[] } {
  const warnings: string[] = [];
  let date = dateValue
    .trim()
    .replace(
      /^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?),?\s+/i,
      "",
    )
    .replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1");
  let time = timeValue.trim();
  if (!date) throw new Error("A date is required.");
  // An explicit offset identifies a real instant; show it in the chosen import timezone.
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(date)) {
    const instant = Temporal.Instant.from(date);
    const local = instant
      .toZonedDateTimeISO(options.timezone)
      .toPlainDateTime()
      .toString();
    if (!time) return { iso: instant.toString(), local, warnings };
    // A user-entered replacement uses the import timezone and replaces the embedded time.
    date = local.slice(0, 10);
  }
  const combined = date.match(
    /^(.*?)(?:T|\s+)(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)$/i,
  );
  if (combined) {
    date = combined[1];
    if (!time) time = combined[2];
  }
  const year = options.year.trim();
  let normalized: string;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(date)) {
    const [y, m, d] = date.split(/[-/]/);
    normalized = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  } else {
    const numeric = date.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/);
    if (numeric) {
      const a = Number(numeric[1]),
        b = Number(numeric[2]);
      let order = options.dateOrder;
      if (a > 12) order = "DMY";
      else if (b > 12) order = "MDY";
      else if (a !== b && order === "ASK")
        throw new Error("Ambiguous date: choose day/month or month/day order.");
      let y = numeric[3] ?? year;
      if (/^\d{2}$/.test(y)) {
        if (!/^\d{4}$/.test(year) || !year.endsWith(y))
          throw new Error(
            "Two-digit year: choose a matching four-digit default year or correct this date.",
          );
        y = year;
        warnings.push(`Using selected year ${year} for the two-digit year.`);
      }
      if (!/^\d{4}$/.test(y))
        throw new Error(
          "Choose a four-digit year for dates without a full year.",
        );
      if (!numeric[3]) warnings.push(`Using selected year ${y}.`);
      const m = order === "DMY" ? b : a,
        d = order === "DMY" ? a : b;
      normalized = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    } else {
      const months = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ];
      const named = date
        .replace(/,/g, "")
        .replace(/[-/]/g, " ")
        .replace(/\b([a-z]{3})\./gi, "$1")
        .match(
          /^(?:(\d{1,2})\s+([a-z]+)|([a-z]+)\s+(\d{1,2}))(?:\s+(\d{4}))?$/i,
        );
      if (!named)
        throw new Error(
          "Unrecognized date. Use YYYY-MM-DD or correct the source mapping.",
        );
      const m =
        months.indexOf((named[2] ?? named[3]).toLowerCase().slice(0, 3)) + 1;
      const y = named[5] ?? year;
      if (!m || !/^\d{4}$/.test(y))
        throw new Error("Choose a valid month and four-digit year.");
      if (!named[5]) warnings.push(`Using selected year ${y}.`);
      normalized = `${y}-${String(m).padStart(2, "0")}-${(named[1] ?? named[4]).padStart(2, "0")}`;
    }
  }
  if (!time) {
    if (!options.defaultTime)
      throw new Error("Time is missing. Set a time or choose a default time.");
    time = options.defaultTime;
    warnings.push(`Using default time ${time}.`);
  }
  time = time.replace(/([ap])\.?m\.?$/i, "$1m").replace(/(\d)\.(\d{2})/, "$1:$2");
  if (/^noon$/i.test(time)) time = "12 PM";
  if (/^midnight$/i.test(time)) time = "12 AM";
  const match = time.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match)
    throw new Error("Invalid time. Use HH:mm or a time such as 2:30 PM.");
  let hours = Number(match[1]);
  if (!match[4] && hours >= 1 && hours <= 12 && !/^0\d:/.test(time) && options.timeFormat !== "24H")
    throw new Error("Specify AM or PM for this time, or choose 24-hour times if that is how your calendar is written.");
  if (match[4]) {
    if (hours < 1 || hours > 12) throw new Error("Invalid 12-hour time.");
    hours = (hours % 12) + (match[4].toLowerCase() === "pm" ? 12 : 0);
  }
  const local = `${normalized}T${String(hours).padStart(2, "0")}:${match[2] ?? "00"}:${match[3] ?? "00"}`;
  const plain = Temporal.PlainDateTime.from(local, { overflow: "reject" });
  // Reject both nonexistent and repeated local times instead of silently shifting dates.
  const zoned = plain.toZonedDateTime(options.timezone, {
    disambiguation: "reject",
  });
  return {
    iso: zoned.toInstant().toString(),
    local: plain.toString(),
    warnings,
  };
}

export function approvalFor(
  value: string,
): "PENDING" | "APPROVED" | "NEEDS_REVISION" {
  const key = value.trim().toLowerCase().replace(/[_-]/g, " ");
  if (["approved", "client approved"].includes(key)) return "APPROVED";
  if (
    ["needs revision", "revision", "changes requested", "rejected"].includes(
      key,
    )
  )
    return "NEEDS_REVISION";
  return "PENDING";
}

export function rowIssues(
  row: ImportRow,
  options: ImportOptions,
): { errors: string[]; warnings: string[]; iso?: string; local?: string } {
  const errors: string[] = [],
    warnings = [...row.warnings];
  let resolved: ReturnType<typeof resolveDate> | undefined;
  try {
    resolved = resolveDate(row.date, row.time, options);
    warnings.push(...resolved.warnings);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Invalid date/time.");
  }
  try {
    parsePlatforms(row.platform);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Invalid platform.");
  }
  if (
    ![row.caption, row.contentIdea, row.hook, row.script, row.notes].some(
      (value) => value.trim(),
    )
  )
    errors.push(
      "Add a caption, topic, script, hook, or notes to identify this content item.",
    );
  for (const field of IMPORT_FIELDS)
    if (row[field].length > 20000)
      errors.push(`${field} exceeds 20,000 characters.`);
  if (
    row.customFields.length +
      Number(!!row.notes.trim()) +
      Number(!!row.status.trim()) >
    50
  )
    errors.push(
      "At most 50 custom fields (including notes and source status) are supported.",
    );
  if (
    row.customFields.some(
      (field) =>
        !field ||
        typeof field !== "object" ||
        typeof field.label !== "string" ||
        typeof field.value !== "string" ||
        field.label.length > 200 ||
        field.value.length > 20000,
    )
  )
    errors.push(
      "Custom fields require text labels up to 200 characters and text values up to 20,000 characters.",
    );
  if (!row.caption.trim()) warnings.push("Caption is missing.");
  if (!row.postType.trim()) warnings.push("Content format is missing.");
  if (row.status.trim())
    warnings.push(
      approvalFor(row.status) === "APPROVED"
        ? "Approved posts are locked after import. Confirm approval below."
        : `Source status “${row.status}” maps to ${approvalFor(row.status)}; publishing remains off.`,
    );
  return { errors, warnings, iso: resolved?.iso, local: resolved?.local };
}

export function contentKey(post: {
  caption?: string | null;
  contentIdea?: string | null;
  hook?: string | null;
  script?: string | null;
}): string {
  return [post.caption, post.contentIdea, post.hook, post.script]
    .map((value) =>
      (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(),
    )
    .join("\u001f");
}
export function duplicateKey(post: {
  postDate: string | Date;
  platform: string;
  caption?: string | null;
  contentIdea?: string | null;
  hook?: string | null;
  script?: string | null;
  postType?: string | null;
  category?: string | null;
  cta?: string | null;
  hashtags?: string | null;
  taggedAccounts?: string | null;
  linkUrl?: string | null;
  notes?: string;
  customFields?: { label: string; value: string }[];
}): string {
  const normalize = (value: string | null | undefined) =>
    (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const custom = [
    ...(post.customFields ?? []),
    ...(post.notes?.trim() ? [{ label: "Notes", value: post.notes }] : []),
  ]
    .filter((field) => normalize(field.label) !== "source status")
    .map((field) => [normalize(field.label), normalize(field.value)])
    .filter(([, value]) => value)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([
    new Date(post.postDate).toISOString(),
    post.platform,
    contentKey(post),
    ...[
      post.postType,
      post.category,
      post.cta,
      post.hashtags,
      post.taggedAccounts,
      post.linkUrl,
    ].map(normalize),
    custom,
  ]);
}

export type ExistingPost = {
  id: string;
  postDate: string | Date;
  platform: string;
  caption: string | null;
  contentIdea: string | null;
  hook: string | null;
  script: string | null;
  postType?: string | null;
  category?: string | null;
  cta?: string | null;
  hashtags?: string | null;
  taggedAccounts?: string | null;
  linkUrl?: string | null;
  notes?: string;
  customFields?: { label: string; value: string }[];
};

/** Precompute fingerprints so reviewing a large calendar does not repeatedly format every date. */
export function duplicateIndex(posts: ExistingPost[], timezone: string) {
  const exact = new Set<string>(),
    similar = new Set<string>();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const keys = (post: ExistingPost) => {
    const prefix = `${post.platform}|${formatter.format(new Date(post.postDate))}|`;
    return (["caption", "contentIdea", "hook", "script"] as const).flatMap(
      (field) => {
        const value = (post[field] ?? "")
          .normalize("NFKC")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        return value ? [prefix + field + "|" + value] : [];
      },
    );
  };
  const add = (post: ExistingPost) => {
    exact.add(duplicateKey(post));
    keys(post).forEach((key) => similar.add(key));
  };
  posts.forEach(add);
  return {
    add,
    exact: (post: ExistingPost) => exact.has(duplicateKey(post)),
    possible: (post: ExistingPost) =>
      keys(post).some((key) => similar.has(key)),
  };
}
