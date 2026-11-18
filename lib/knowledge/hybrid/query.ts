export interface RetrievalRequest {
  instructions?: string;
  platforms?: readonly string[];
  audience?: string;
  product?: string;
  objective?: string;
  contentStrategy?: string;
}
export interface QueryPlan { primary: string; queries: string[]; specific: boolean }
/** Expansion supplies search dimensions, never claims about the business. No model call. */
export function buildQueries(request: RetrievalRequest): QueryPlan {
  const instructions = request.instructions?.trim() || "";
  const details = [request.product && `Product/service: ${request.product}`, request.audience && `Audience: ${request.audience}`, request.objective && `Objective: ${request.objective}`].filter(Boolean).join("\n");
  const specific = !!(instructions || details);
  const primary = [instructions || "Business positioning products services audience differentiators", details].filter(Boolean).join("\n").slice(0, 8000);
  const platform = request.platforms?.slice(0, 6).join(" ") || "social media";
  return { primary, specific, queries: [
    primary,
    `${primary.slice(0, 1500)}\nProduct/service features benefits differentiators audience needs`,
    `${request.product || primary.slice(0, 1200)}\nPricing currency package inclusions booking conditions restrictions policies`,
    `${request.audience || "Target audience"}\nBrand voice communication guidelines marketing objectives ${platform}`,
  ] };
}
