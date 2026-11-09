import { BRIEF_FIELDS, parseCreativeBrief, type CreativeBrief, platformBriefFormats } from "./brief";
export interface ReviewablePost { contentUnit: number; platform: string; brief: CreativeBrief }
const REVIEW_NEEDED = "Automated review could not approve the whole batch. Review this draft's facts, originality and creative direction before approving it.";
export function reviewWarning(brief: CreativeBrief, message = REVIEW_NEEDED): CreativeBrief {
    return { ...brief, reviewWarnings: [...new Set([...(brief.reviewWarnings || []), message])] };
}
/** Keep valid paid writing when an editorial pass rejects a batch or returns a bad replacement. */
export function applyBriefReview(posts: ReviewablePost[], value: unknown, streams: {platforms:string[]}[]) {
    const original = posts.map(post => ({...post, brief:{...post.brief}}));
    const warning = () => original.map(post=>({...post,brief:reviewWarning(post.brief)}));
    if (!value || typeof value !== "object") return warning();
    const result = value as {acceptable?:unknown;revisions?:unknown};
    if (typeof result.acceptable !== "boolean" || !Array.isArray(result.revisions) || result.revisions.length > 6) return warning();
    const replacements = new Map<number, CreativeBrief>();
    for (const candidate of result.revisions) {
        try {
            const change=candidate as {id:string;reason:string;brief?:unknown;changes?:{field:string;value:string}[]};
            if (!change || typeof change.id!=="string" || !/^\d+$/.test(change.id) || typeof change.reason!=="string" || change.reason.length>800) return warning();
            const index=Number(change.id), current=original[index];
            if (!current || replacements.has(index)) return warning();
            let candidateBrief = change.brief;
            if (change.changes !== undefined) {
                if (!Array.isArray(change.changes) || !change.changes.length || change.changes.length > BRIEF_FIELDS.length) return warning();
                const fields = new Set<string>();
                const patch: Record<string,string> = {};
                for (const edit of change.changes) {
                    if (!edit || !BRIEF_FIELDS.includes(edit.field as typeof BRIEF_FIELDS[number]) || typeof edit.value !== "string" || fields.has(edit.field)) return warning();
                    fields.add(edit.field); patch[edit.field] = edit.value;
                }
                candidateBrief = {...current.brief, ...patch};
            }
            const brief=parseCreativeBrief(candidateBrief);
            const stream=streams.find(stream=>stream.platforms[0]===current.platform);
            if (brief.version!==2 || !stream?.platforms.every(platform=>platformBriefFormats(platform).includes(brief.format))) return warning();
            replacements.set(index,brief);
        } catch { return warning(); }
    }
    return original.map((post,index)=>({...post,brief:result.acceptable===true ? replacements.get(index)||post.brief : reviewWarning(replacements.get(index)||post.brief)}));
}

