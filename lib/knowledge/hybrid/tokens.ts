let getEncoding: ((name: string) => { encode: (text: string, allowed?: unknown[], disallowed?: unknown[]) => number[]; decode: (tokens: number[]) => string }) | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tiktoken = require("js-tiktoken");
  if (typeof tiktoken?.getEncoding === "function") {
    getEncoding = tiktoken.getEncoding;
  }
} catch {
  // js-tiktoken not installed, fallback approximation will be used
}

const encoders = new Map<string, any>();

export function tokenizer(name: "cl100k_base" | "o200k_base" = "o200k_base") {
  if (!getEncoding) return null;
  let encoder = encoders.get(name);
  if (!encoder) {
    try {
      encoder = getEncoding(name);
      encoders.set(name, encoder);
    } catch {
      return null;
    }
  }
  return encoder;
}

// Special-token-looking strings in untrusted documents remain ordinary text.
export const tokenCount = (text: string): number => {
  const enc = tokenizer();
  if (enc) {
    try {
      return enc.encode(text, [], []).length;
    } catch {
      // fallback
    }
  }
  return Math.ceil(text.length / 3.5);
};

export function truncateTokens(text: string, limit: number): string {
  const enc = tokenizer();
  if (enc) {
    try {
      return enc.decode(enc.encode(text, [], []).slice(0, Math.max(0, Math.floor(limit))));
    } catch {
      // fallback
    }
  }
  return text.slice(0, Math.floor(limit * 3.5));
}

