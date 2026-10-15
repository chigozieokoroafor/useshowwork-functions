import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed, publishingRetentionRequired } from "@/lib/publishing/applicationBoundary";
import { publishingFetch as fetch } from "@/lib/publishing/executionContext";
import type { SocialConnection } from "@prisma/client";
import { db } from "@/lib/db";

export function requireScopes(connection: Pick<SocialConnection, "tokenScopes" | "platform">, required: string[]) {
  const scopes = new Set((connection.tokenScopes || "").split(/[\s,]+/));
  const missing = required.filter(scope => !scopes.has(scope));
  if (missing.length) throw new Error(`${connection.platform} permission is missing (${missing.join(", ")}). Reconnect after enabling access in the developer app.`);
}
/* canonical-only-helper */
export {requestSocialTokenRefresh} from './publishing/nativeTokenServices';
/* end-canonical-only-helper */
export async function freshConnection(connection: SocialConnection, database: typeof db = db): Promise<SocialConnection> {
  /* canonical-integration-boundary */ if (publishingRetentionRequired()) { return await freshCanonicalAuxiliaryConnection(connection); } /* end-canonical-integration-boundary */

  if (connection.status !== "CONNECTED" || !connection.accessToken) throw new Error("Reconnect this account before continuing.");
  if (!connection.accessTokenExpiresAt || connection.accessTokenExpiresAt.getTime() > Date.now() + 60_000) return connection;
  if (!["X", "LINKEDIN"].includes(connection.platform) || !connection.refreshToken) throw new Error(`${connection.platform} connection has expired. Reconnect the account.`);
  if (connection.refreshTokenExpiresAt && connection.refreshTokenExpiresAt.getTime() <= Date.now()) throw new Error("Refresh token has expired. Reconnect the account.");
  const isX = connection.platform === "X";
  const clientId = isX ? process.env.X_CLIENT_ID : process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = isX ? process.env.X_CLIENT_SECRET : process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error(`${connection.platform} app credentials are missing.`);
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: connection.refreshToken, client_id: clientId });
  if (!isX) body.set("client_secret", clientSecret);
  const response = await fetch(isX ? "https://api.x.com/2/oauth2/token" : "https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(isX ? { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` } : {}) }, body, signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error(`${connection.platform} connection could not be renewed. Reconnect the account.`);
  // Compare-and-swap avoids resurrecting an account disconnected while refreshing.
  await database.socialConnection.updateMany({ where: { id: connection.id, status: "CONNECTED", refreshToken: connection.refreshToken }, data: {
    accessToken: result.access_token, accessTokenExpiresAt: new Date(Date.now() + result.expires_in * 1000),
    refreshToken: result.refresh_token ?? connection.refreshToken,
    ...(result.refresh_token_expires_in ? { refreshTokenExpiresAt: new Date(Date.now() + result.refresh_token_expires_in * 1000) } : {}),
    ...(result.scope ? { tokenScopes: result.scope } : {}),
  } });
  const updated = await database.socialConnection.findUniqueOrThrow({ where: { id: connection.id } });
  if (updated.status !== "CONNECTED" || !updated.accessToken) throw new Error("This account was disconnected.");
  return updated;
}
/* canonical-only-helper */
import {freshCanonicalAuxiliaryConnection} from "./publishing/auxiliaryAccountHost";
/* end-canonical-only-helper */
