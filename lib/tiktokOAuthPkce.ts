import { createHash, randomBytes } from "node:crypto";

export const TIKTOK_PKCE_COOKIE = "showwork_tiktok_pkce";

export function createTikTokPkce() {
  const verifier = randomBytes(32).toString("base64url");
  // TikTok documents hexadecimal SHA-256, rather than X's base64url.
  const challenge = createHash("sha256").update(verifier).digest("hex");
  return { verifier, challenge };
}

export function readTikTokVerifier(value: string | undefined, nonce: string | undefined) {
  if (!value || !nonce) return null;
  const [boundNonce, verifier, extra] = value.split(".");
  if (extra || boundNonce !== nonce || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier || "")) return null;
  return verifier;
}
