import { getEncoding } from "js-tiktoken";
const encoders = new Map<string, ReturnType<typeof getEncoding>>();
export function tokenizer(name: "cl100k_base" | "o200k_base" = "o200k_base") {
  let encoder = encoders.get(name);
  if (!encoder) { encoder = getEncoding(name); encoders.set(name, encoder); }
  return encoder;
}
// Special-token-looking strings in untrusted documents remain ordinary text.
export const tokenCount = (text: string) => tokenizer().encode(text, [], []).length;
export function truncateTokens(text: string, limit: number) {
  return tokenizer().decode(tokenizer().encode(text, [], []).slice(0, Math.max(0, Math.floor(limit))));
}
