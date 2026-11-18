import { BRIEF_FIELDS, type CreativeBrief } from "./content/brief";

/** Share brief fields even when incomplete, without internal warnings or unknown metadata. */
export function clientPostBrief(value: unknown): CreativeBrief | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 && source.version !== 2) return null;
  const fields = Object.fromEntries(BRIEF_FIELDS.map(field => [field, typeof source[field] === "string" ? source[field] : ""])) as Record<typeof BRIEF_FIELDS[number], string>;
  return {version:source.version,format:typeof source.format === "string" ? source.format : "",...fields};
}
