export type ContentReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** Content settings deliberately do not inherit OPENAI_MODEL (used by inbox/research). */
export function contentModelConfig() {
  const model = process.env.OPENAI_CONTENT_MODEL?.trim() || "gpt-6.1-sol";
  const reasoningModel = /^gpt-6\.1-sol(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
  if (!reasoningModel && !/^gpt-4\.1(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) {
    throw Error("Unsupported content model. Use gpt-6.1-sol or a GPT-4.1 model for rollback.");
  }
  const effort = process.env.OPENAI_CONTENT_REASONING_EFFORT?.trim() || "medium";
  if (reasoningModel && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw Error("Invalid content reasoning effort. Choose low, medium, high, xhigh or max.");
  const reserve = Number(process.env.OPENAI_CONTENT_REASONING_TOKENS ?? 8192);
  if (reasoningModel && (!Number.isInteger(reserve) || reserve < 2048 || reserve > 24000)) throw Error("Content reasoning token allowance must be an integer from 2048 to 24000.");
  return { model, reasoningEffort: reasoningModel ? effort as ContentReasoningEffort : undefined, reasoningTokens: reasoningModel ? reserve : 0, maxOutput: reasoningModel ? 128000 : 32768 };
}
export function knownModelContextWindow(model: string) {
  if (/^gpt-6\.1-sol(?:-|$)/.test(model)) return 1_050_000;
  if (model.startsWith("gpt-4.1")) return 1_047_576;
  return 0;
}
export function contentRequestSettings(visibleOutputTokens = 4096, requestedTimeout = 120000, stage: "planning" | "writing" | "review" = "planning") {
  const config = contentModelConfig();
  const stageEffort = stage === "planning" ? config.reasoningEffort : (process.env[stage === "review" ? "OPENAI_CONTENT_REVIEW_REASONING_EFFORT" : "OPENAI_CONTENT_WRITING_REASONING_EFFORT"]?.trim() || "low");
  if (config.reasoningEffort && !["low", "medium", "high", "xhigh", "max"].includes(stageEffort || "")) throw Error("Invalid content stage reasoning effort.");
  const reasoningTokens = stage !== "planning" && stageEffort === "low" ? Math.min(config.reasoningTokens, 4096) : config.reasoningTokens;
  const contentTimeout = Number(process.env.OPENAI_CONTENT_TIMEOUT_MS ?? 180000);
  if (!Number.isInteger(contentTimeout) || contentTimeout < 30000 || contentTimeout > 600000) throw Error("Content timeout must be an integer from 30000 to 600000 milliseconds.");
  return {
    model: config.model, reasoningEffort: config.reasoningEffort ? stageEffort as ContentReasoningEffort : undefined,
    // Responses counts both internal reasoning and visible output against this ceiling.
    maxOutputTokens: Math.min(config.maxOutput, visibleOutputTokens + reasoningTokens),
    timeoutMs: Math.max(requestedTimeout, config.reasoningEffort ? contentTimeout : requestedTimeout),
    attempts: 1,
  };
}

