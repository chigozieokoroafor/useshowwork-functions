/** Application-authored diagnostics only; never include prompts/provider payloads. */
export class ContentGenerationError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = "ContentGenerationError"; }
}

