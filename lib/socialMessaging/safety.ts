/** Redact before retrieval queries, prompts and optional web search. Never log originals. */
export function maskSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\/-]{12,})/gi, "[REDACTED TOKEN]")
    .replace(/\b(password|passcode|otp|cvv|cvc|pin|security code|one[- ]time (?:code|password)|card number|account number|passport number|national id)\s*(?:is|:|=)?\s*[^\s,;]{3,}/gi, "$1 [REDACTED]")
    .replace(/(?:\d[ -]?){13,19}/g, "[REDACTED NUMBER]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
    .replace(/\+?\d[\d ()-]{8,}\d/g, "[REDACTED PHONE]");
}
export function maskSensitiveValue<T>(value: T): T {
  if (typeof value === "string") return maskSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map(maskSensitiveValue) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => [key, maskSensitiveValue(item)])) as T;
  return value;
}
export function isSensitiveMessage(text: string) {
  return /\b(password|passcode|one[- ]time (?:code|password)|otp|cvv|cvc|pin|card (?:number|details)|passport|national id|social security|private key)\b/i.test(text)
    || /(?:\d[ -]?){13,19}/.test(text);
}
/** Internet access is opt-in AND only for public/current-information questions. */
export function maySearchForReply(input: { enabled: boolean; text: string; handoff: boolean; sensitive: boolean }) {
  return input.enabled && !input.handoff && !input.sensitive
    && !/\b(pay|payment|bank|checkout|invoice|refund|deposit|transfer|card)\b/i.test(input.text)
    && /\b(latest|current|today|recent|news|weather|industry trend|market trend|public information)\b/i.test(input.text);
}

