const safeTag = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.\[\]-]{1,160}$/.test(value) ? value : undefined;
export class AiProviderError extends Error {
    readonly code: string;
    readonly providerType?: string;
    readonly param?: string;
    readonly requestId?: string;
    constructor(readonly status: number, detail: unknown, requestId: string | null) {
        const error = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
        const code = safeTag(error.code) || "AI_PROVIDER_REJECTED";
        const message = code === "insufficient_quota" || code === "credit_balance_exhausted" || error.type === "insufficient_quota" ? "The AI service has no available API credit or quota. The administrator should check OpenAI billing and project limits."
            : status === 429 ? "The AI service is rate-limited. Wait briefly before trying again."
            : status === 401 || status === 403 ? "The AI service rejected the configured API credentials or access. The administrator should check this project's API configuration."
            : code === "model_not_found" ? "The configured content model is not available to this API project."
            : status === 400 ? "The AI service rejected the generation request settings. The administrator can identify the rejected setting from the safe provider diagnostic."
            : "The AI service could not complete this request. Please try again later.";
        super(message); this.name = "AiProviderError";
        this.code = code; this.providerType = safeTag(error.type); this.param = safeTag(error.param); this.requestId = safeTag(requestId);
    }
    diagnostic() { return { status: this.status, code: this.code, type: this.providerType, param: this.param, requestId: this.requestId }; }
}

