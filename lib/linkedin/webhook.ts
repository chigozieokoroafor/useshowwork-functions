import { createHmac, timingSafeEqual } from "node:crypto";
export function linkedInChallenge(challengeCode: string, secret: string) {
  return { challengeCode, challengeResponse: createHmac("sha256", secret).update(challengeCode).digest("hex") };
}
/** LinkedIn's shared webhook specification signs prefix + raw body; the
 * X-LI-Signature header itself contains the hex digest without a prefix. */
export function verifyLinkedInSignature(raw: string, signature: string | null, secret: string | undefined) {
  if (!secret || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update("hmacsha256=" + raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
