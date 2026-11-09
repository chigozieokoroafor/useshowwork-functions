/** Shared JSON contract. No provider/database imports: safe for browser editors. */
const LEGACY_FIELDS = ["title", "objective", "targetAudience", "coreIdea", "keyMessage", "creativeDirection", "desiredResponse", "brandConnection", "suggestedCta", "pillar"] as const;
export const BRIEF_FIELDS = [...LEGACY_FIELDS, "hook", "caption", "hashtags"] as const;
export type BriefField = typeof BRIEF_FIELDS[number];
export interface CreativeBrief extends Record<BriefField, string> {
    version: 1 | 2;
    format: string;
    reviewWarnings?: string[];
}
export const FORMATS = ["Reel", "Carousel", "Static graphic", "Story", "Text post", "Video"] as const;
export function parseCreativeBrief(value: unknown): CreativeBrief {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw Error("A structured creative brief is required.");
    const b = value as Record<string, unknown>;
    if (![1, 2].includes(b.version as number) || !FORMATS.includes(b.format as typeof FORMATS[number]))
        throw Error("Choose a supported brief format.");
    const result: Record<string, unknown> = { version: b.version, format: b.format };
    for (const key of b.version === 1 ? LEGACY_FIELDS : BRIEF_FIELDS) {
        if (typeof b[key] !== "string" || (b[key] as string).length > (key === "caption" ? 5000 : key === "creativeDirection" ? 1800 : 800))
            throw Error(`Invalid brief field: ${key}`);
        if (!["brandConnection", "hashtags", ...(b.version === 2 ? ["coreIdea", "keyMessage", "desiredResponse", "pillar"] : ["suggestedCta"])].includes(key) && !(b[key] as string).trim())
            throw Error(`Complete the brief field: ${key}`);
        result[key] = (b[key] as string).trim();
    }
    if (b.reviewWarnings !== undefined) {
        if (!Array.isArray(b.reviewWarnings) || b.reviewWarnings.length > 8 || b.reviewWarnings.some(value => typeof value !== "string" || value.length > 500)) throw Error("Invalid review warnings.");
        result.reviewWarnings = b.reviewWarnings;
    }
    return result as unknown as CreativeBrief;
}
export function briefSchema(version: 1 | 2 = 2) {
    return { type: "object", additionalProperties: false, required: ["version", "format", ...(version === 1 ? LEGACY_FIELDS : BRIEF_FIELDS)], properties: { version: { type: "integer", enum: [version] }, format: { type: "string", enum: [...FORMATS] }, ...Object.fromEntries((version === 1 ? LEGACY_FIELDS : BRIEF_FIELDS).map(key => [key, { type: "string" }])) } };
}
export const EXECUTION_KINDS = ["script", "caption", "carouselOutline", "visualApproaches", "productionNotes", "hashtags"] as const;
export type ExecutionKind = typeof EXECUTION_KINDS[number];
export interface DevelopmentArtifact {
    text: string;
    briefSnapshot: string;
    updatedAt: string;
    manuallyEdited: boolean;
}
export type CreativeDevelopment = Partial<Record<ExecutionKind, DevelopmentArtifact>>;
export function briefSnapshot(brief: CreativeBrief) { return JSON.stringify(parseCreativeBrief(brief)); }
export function briefContentProjection(brief: CreativeBrief) { return { postType: brief.format, category: brief.pillar, contentIdea: `${brief.title}\n\n${brief.coreIdea}\n\n${brief.creativeDirection}`, ...(brief.version === 2 ? { hook: brief.hook, caption: brief.caption, cta: brief.suggestedCta, hashtags: brief.hashtags } : {}) }; }
export function platformBriefFormats(platform: string): readonly string[] {
    const formats: Record<string, readonly string[]> = { INSTAGRAM: ["Reel", "Carousel", "Static graphic", "Story", "Video"], TIKTOK: ["Reel", "Carousel", "Static graphic", "Video"], YOUTUBE: ["Reel", "Video"], FACEBOOK: FORMATS, LINKEDIN: ["Carousel", "Static graphic", "Text post", "Video"], X: ["Static graphic", "Text post", "Video"] };
    return formats[platform] || [];
}

/** Adapt older posts for the same editor without guessing an objective or audience. */
export function editablePostBrief(post: {
    creativeBrief?: CreativeBrief | null; platform?: string; postType?: unknown; category?: unknown;
    hook?: unknown; caption?: unknown; cta?: unknown; hashtags?: unknown; contentIdea?: unknown;
}): CreativeBrief {
    const old = post.creativeBrief;
    const text = (value: unknown) => typeof value === "string" ? value : "";
    return {
        version: 2, ...(old?.reviewWarnings ? {reviewWarnings:old.reviewWarnings} : {}), format: old?.format || (FORMATS.includes(post.postType as typeof FORMATS[number]) ? String(post.postType) : platformBriefFormats(post.platform || "INSTAGRAM")[0] || "Static graphic"),
        title: old?.title || (text(post.hook) || text(post.caption) || text(post.contentIdea)).split("\n")[0].slice(0,120) || "Untitled post",
        objective: old?.objective || "", targetAudience: old?.targetAudience || "",
        hook: text(post.hook) || old?.hook || "",
        caption: text(post.caption) || old?.caption || "",
        creativeDirection: old?.creativeDirection || text(post.contentIdea),
        suggestedCta: text(post.cta) || old?.suggestedCta || "",
        hashtags: text(post.hashtags) || old?.hashtags || "",
        coreIdea: old?.coreIdea || text(post.contentIdea),
        keyMessage: old?.keyMessage || "", desiredResponse: old?.desiredResponse || "",
        brandConnection: old?.brandConnection || "", pillar: old?.pillar || text(post.category),
    };
}

/** Refresh server-owned fields without discarding unsaved edits to other fields. */
export function reconcileBrief(current: CreativeBrief, previous: CreativeBrief, incoming: CreativeBrief): CreativeBrief {
    return Object.fromEntries(Object.keys(incoming).map(key => [
        key, current[key as keyof CreativeBrief] === previous[key as keyof CreativeBrief]
            ? incoming[key as keyof CreativeBrief] : current[key as keyof CreativeBrief],
    ])) as unknown as CreativeBrief;
}

/** Validate explicit user edits before AI completes a legacy draft; required fields may still be empty. */
export function parseEditableBrief(value: unknown): CreativeBrief {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid editable brief.");
    const input=value as Record<string,unknown>;
    if(input.version!==2 || !FORMATS.includes(input.format as typeof FORMATS[number])) throw Error("Invalid brief format.");
    const clean:Record<string,unknown>={version:2,format:input.format};
    for(const name of BRIEF_FIELDS){const max=name==="caption"?5000:name==="creativeDirection"?1800:800;if(typeof input[name]!=="string" || (input[name] as string).length>max)throw Error(`Invalid brief field: ${name}`);clean[name]=input[name];}
    if (input.reviewWarnings !== undefined) {
        if (!Array.isArray(input.reviewWarnings) || input.reviewWarnings.length > 8 || input.reviewWarnings.some(value => typeof value !== "string" || value.length > 500)) throw Error("Invalid review warnings.");
        clean.reviewWarnings = input.reviewWarnings;
    }
    return clean as unknown as CreativeBrief;
}

