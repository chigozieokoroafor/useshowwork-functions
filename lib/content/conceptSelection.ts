/** One developed concept per publishing slot, checked before caption writing. */
export const CONCEPT_TREATMENTS = ["recognisable situation", "contradiction", "story", "demonstration", "comparison", "opinion", "observation", "practical teaching"] as const;
export interface CampaignConcept {
    situation: string;
    premise: string;
    treatment: typeof CONCEPT_TREATMENTS[number];
    evidenceAnchor: string;
}
export const campaignConceptSchema = {
    type: "object", additionalProperties: false,
    required: ["situation", "premise", "treatment", "evidenceAnchor"],
    properties: { situation: { type: "string" }, premise: { type: "string" }, treatment: { type: "string", enum: [...CONCEPT_TREATMENTS] }, evidenceAnchor: { type: "string" } },
};
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
export function validateCampaignConcepts(plans: { concept: CampaignConcept }[], evidence: string) {
    const seen = new Set<string>();
    for (const { concept } of plans) {
        if (!concept || !CONCEPT_TREATMENTS.includes(concept.treatment)
            || [concept.situation, concept.premise, concept.evidenceAnchor].some(value => typeof value !== "string" || !value.trim() || value.length > 400)) throw Error("Each post needs one complete creative concept.");
        const anchor = normalize(concept.evidenceAnchor), premise = normalize(concept.premise);
        if (anchor.length < 12 || !normalize(evidence).includes(anchor)) throw Error("A creative concept lacks source-grounded support. No captions were generated.");
        if (seen.has(premise)) throw Error("The campaign repeats a creative concept. No captions were generated.");
        seen.add(premise);
    }
}

