import type { CalendarLeadPipelineStatus, CalendarLeadTemperature, SocialLeadStatus } from "@prisma/client";

export const LEAD_TEMPERATURES: CalendarLeadTemperature[] = ["COLD", "WARM", "HOT"];
export const LEAD_PIPELINE_STATUSES: CalendarLeadPipelineStatus[] = ["NEW", "CONTACTED", "QUALIFIED", "CUSTOMER", "LOST"];

export function socialStatusToPipeline(status: SocialLeadStatus): CalendarLeadPipelineStatus {
  return status === "NOT_A_LEAD" ? "LOST" : status;
}

export function pipelineToSocialStatus(status: CalendarLeadPipelineStatus): SocialLeadStatus {
  return status === "LOST" ? "NOT_A_LEAD" : status;
}

export function cleanOptionalString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

export function normalizedEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}
