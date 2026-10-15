import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export type FacebookPageOption = {
  id: string;
  name: string;
  accessToken: string;
};

type FacebookPageSelectionPayload = {
  calendarId: string;
  pages: FacebookPageOption[];
  grantedPermissions: string[];
  userTokenExpiresAt: number | null;
  expiresAt: number;
};

const SELECTION_TTL_SECONDS = 10 * 60;
const COOKIE_NAME = "showwork_facebook_page_selection";
const ALGORITHM = "aes-256-gcm";

function encryptionKey() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      "JWT_SECRET is required to create a secure Facebook Page selection.",
    );
  }

  return createHash("sha256").update(secret).digest();
}

export function createFacebookPageSelection({
  calendarId,
  pages,
  grantedPermissions,
  userTokenExpiresAt,
}: {
  calendarId: string;
  pages: FacebookPageOption[];
  grantedPermissions: string[];
  userTokenExpiresAt: number | null;
}) {
  const payload: FacebookPageSelectionPayload = {
    calendarId,
    pages,
    grantedPermissions,
    userTokenExpiresAt,
    expiresAt: Math.floor(Date.now() / 1000) + SELECTION_TTL_SECONDS,
  };

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  const value = [
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");

  return {
    value,
    cookieName: COOKIE_NAME,
    maxAge: SELECTION_TTL_SECONDS,
  };
}

export function verifyFacebookPageSelection(
  value: string | undefined,
): FacebookPageSelectionPayload | null {
  if (!value) return null;

  const [ivPart, authTagPart, encryptedPart, extra] = value.split(".");

  if (!ivPart || !authTagPart || !encryptedPart || extra) {
    return null;
  }

  try {
    const iv = Buffer.from(ivPart, "base64url");
    const authTag = Buffer.from(authTagPart, "base64url");
    const encrypted = Buffer.from(encryptedPart, "base64url");

    if (iv.length !== 12 || authTag.length !== 16 || encrypted.length === 0) {
      return null;
    }

    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      iv,
    );

    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    const payload = JSON.parse(
      decrypted.toString("utf8"),
    ) as FacebookPageSelectionPayload;

    if (
      !payload.calendarId ||
      !Array.isArray(payload.pages) ||
      !Array.isArray(payload.grantedPermissions) ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    const validPages = payload.pages.every(
      (page) =>
        typeof page?.id === "string" &&
        page.id.length > 0 &&
        typeof page?.name === "string" &&
        page.name.length > 0 &&
        typeof page?.accessToken === "string" &&
        page.accessToken.length > 0,
    );

    if (!validPages) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function facebookPageSelectionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export function facebookPageSelectionCookieName() {
  return COOKIE_NAME;
}