import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { publishingFetch as fetch } from "@/lib/publishing/executionContext";
// ─────────────────────────────────────────────────────────────
// INSTAGRAM GRAPH API
//
// Facebook Login → Facebook Pages → Instagram Professional
// Accounts → Instagram Graph API publishing.
//
// SERVER-SIDE ONLY.
//
// Never expose:
// - INSTAGRAM_APP_SECRET
// - user access tokens
// - Facebook Page access tokens
// - Instagram access tokens
// to the browser.
// ─────────────────────────────────────────────────────────────

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const APP_ID = process.env.INSTAGRAM_APP_ID;
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

interface GraphApiError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
  instagram_business_account?: {
    id: string;
  };
}

export interface InstagramAccountConnection {
  instagramUserId: string;
  username: string;
  facebookPageId: string;
  facebookPageName: string;
  pageAccessToken: string;
}

interface MediaContainerResponse {
  id: string;
}

interface ContainerStatusResponse {
  status_code: string;
  status?: string;
}

export type InstagramVideoMediaType = "VIDEO" | "REELS";

// ─────────────────────────────────────────────────────────────
// APP CREDENTIALS
// ─────────────────────────────────────────────────────────────

function requireAppCredentials(): {
  APP_ID: string;
  APP_SECRET: string;
} {
  if (!APP_ID || !APP_SECRET) {
    throw new Error(
      "INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET are not set. Instagram publishing is not configured."
    );
  }

  return {
    APP_ID,
    APP_SECRET,
  };
}

// ─────────────────────────────────────────────────────────────
// OAUTH SCOPES
// ─────────────────────────────────────────────────────────────

const INSTAGRAM_BASE_OAUTH_SCOPES =
  "instagram_basic,instagram_content_publish,instagram_manage_messages,pages_read_engagement,pages_show_list,pages_manage_metadata";

// Only request this after `instagram_manage_insights` is enabled for the
// configured Meta app. Meta rejects the entire OAuth request as Invalid Scopes
// when the app has not been granted access to this permission.
export const INSTAGRAM_OAUTH_SCOPES =
  process.env.INSTAGRAM_REQUEST_INSIGHTS_SCOPE === "true"
    ? `${INSTAGRAM_BASE_OAUTH_SCOPES},instagram_manage_insights`
    : INSTAGRAM_BASE_OAUTH_SCOPES;

// ─────────────────────────────────────────────────────────────
// OAUTH URL
// ─────────────────────────────────────────────────────────────

export function buildInstagramAuthUrl({
  redirectUri,
  state,
}: {
  redirectUri: string;
  state: string;
}): string {
  const { APP_ID } = requireAppCredentials();

  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirectUri,
    scope: INSTAGRAM_OAUTH_SCOPES,
    state,
    response_type: "code",
  });

  return `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────
// GRAPH API GET
// ─────────────────────────────────────────────────────────────

async function graphGet<T>(
  path: string,
  params: Record<string, string>
): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const url = `${GRAPH_BASE}${path}?${query}`;

  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
  });

  const data = (await response.json()) as T & GraphApiError;

  if (!response.ok || data.error) {
    const message =
      data.error?.message ??
      `Instagram Graph API request failed (${response.status}).`;

    const details: string[] = [];

    if (data.error?.type) {
      details.push(`type=${data.error.type}`);
    }

    if (typeof data.error?.code === "number") {
      details.push(`code=${data.error.code}`);
    }

    if (typeof data.error?.error_subcode === "number") {
      details.push(`subcode=${data.error.error_subcode}`);
    }

    throw new Error(
      details.length > 0
        ? `${message} [${details.join(", ")}]`
        : message
    );
  }

  return data as T;
}

// ─────────────────────────────────────────────────────────────
// GRAPH API POST
// ─────────────────────────────────────────────────────────────

async function graphPost<T>(
  path: string,
  params: Record<string, string>
): Promise<T> {
  const url = `${GRAPH_BASE}${path}`;

  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });

  const data = (await response.json()) as T & GraphApiError;

  if (!response.ok || data.error) {
    const message =
      data.error?.message ??
      `Instagram Graph API request failed (${response.status}).`;

    const details: string[] = [];

    if (data.error?.type) {
      details.push(`type=${data.error.type}`);
    }

    if (typeof data.error?.code === "number") {
      details.push(`code=${data.error.code}`);
    }

    if (typeof data.error?.error_subcode === "number") {
      details.push(`subcode=${data.error.error_subcode}`);
    }

    throw new Error(
      details.length > 0
        ? `${message} [${details.join(", ")}]`
        : message
    );
  }

  return data as T;
}

// ─────────────────────────────────────────────────────────────
// TOKEN EXCHANGE
// ─────────────────────────────────────────────────────────────

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ access_token: string }> {
  const { APP_ID, APP_SECRET } = requireAppCredentials();

  return graphGet<{ access_token: string }>(
    "/oauth/access_token",
    {
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: redirectUri,
      code,
    }
  );
}

export async function exchangeForLongLivedToken(
  shortLivedToken: string
): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const { APP_ID, APP_SECRET } = requireAppCredentials();

  return graphGet<{
    access_token: string;
    expires_in: number;
  }>("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: APP_ID,
    client_secret: APP_SECRET,
    fb_exchange_token: shortLivedToken,
  });
}

// ─────────────────────────────────────────────────────────────
// FACEBOOK PAGES
// ─────────────────────────────────────────────────────────────

export async function listManagedPages(
  userAccessToken: string
): Promise<FacebookPage[]> {
  const result = await graphGet<{ data: FacebookPage[] }>(
    "/me/accounts",
    {
      access_token: userAccessToken,
      fields: "id,name,access_token,tasks,instagram_business_account",
    }
  );

  return result.data ?? [];
}

export async function listInstagramGrantedPermissions(userAccessToken: string): Promise<string[]> {
  const result = await graphGet<{ data?: { permission: string; status: string }[] }>(
    "/me/permissions",
    { access_token: userAccessToken },
  );
  return (result.data ?? [])
    .filter((permission) => permission.status === "granted")
    .map((permission) => permission.permission);
}

// ─────────────────────────────────────────────────────────────
// INSTAGRAM ACCOUNT
// ─────────────────────────────────────────────────────────────

export async function getInstagramUsername(
  igUserId: string,
  pageAccessToken: string
): Promise<string> {
  const result = await graphGet<{ username: string }>(
    `/${igUserId}`,
    {
      fields: "username",
      access_token: pageAccessToken,
    }
  );

  if (!result.username) {
    throw new Error(
      "Instagram account was found, but Meta did not return its username."
    );
  }

  return result.username;
}

// ─────────────────────────────────────────────────────────────
// FIND ALL CONNECTED INSTAGRAM ACCOUNTS
// ─────────────────────────────────────────────────────────────

export async function listConnectedInstagramAccounts(
  userAccessToken: string
): Promise<InstagramAccountConnection[]> {
  const pages = await listManagedPages(userAccessToken);

  const accounts: InstagramAccountConnection[] = [];

  for (const page of pages) {
    const instagramUserId =
      page.instagram_business_account?.id;

    if (!instagramUserId) {
      continue;
    }

    try {
      const username = await getInstagramUsername(
        instagramUserId,
        page.access_token
      );

      accounts.push({
        instagramUserId,
        username,
        facebookPageId: page.id,
        facebookPageName: page.name,
        pageAccessToken: page.access_token,
      });
    } catch (error) {
      console.error(
        `Unable to retrieve Instagram account for Facebook Page ${page.id}:`,
        error
      );
    }
  }

  return accounts;
}

// ─────────────────────────────────────────────────────────────
// CREATE MEDIA CONTAINER
// ─────────────────────────────────────────────────────────────

export async function createMediaContainer({
  igUserId,
  pageAccessToken,
  imageUrl,
  videoUrl,
  caption,
  isCarouselItem = false,
  mediaType,
}: {
  igUserId: string;
  pageAccessToken: string;
  imageUrl?: string;
  videoUrl?: string;
  caption?: string;
  isCarouselItem?: boolean;
  mediaType?: InstagramVideoMediaType;
}): Promise<string> {
  if (!imageUrl && !videoUrl) {
    throw new Error(
      "Instagram media requires either an image URL or video URL."
    );
  }

  if (imageUrl && videoUrl) {
    throw new Error(
      "Instagram media cannot contain both an image URL and video URL."
    );
  }

  const params: Record<string, string> = {
    access_token: pageAccessToken,
  };

  if (imageUrl) {
    params.image_url = imageUrl;
  }

  if (videoUrl) {
    params.video_url = videoUrl;

    params.media_type = isCarouselItem
      ? "VIDEO"
      : mediaType ?? "REELS";
  }

  if (caption && !isCarouselItem) {
    params.caption = caption;
  }

  if (isCarouselItem) {
    params.is_carousel_item = "true";
  }

  const result = await graphPost<MediaContainerResponse>(
    `/${igUserId}/media`,
    params
  );

  if (!result.id) {
    throw new Error(
      "Instagram did not return a media container ID."
    );
  }

  return result.id;
}

// ─────────────────────────────────────────────────────────────
// CREATE CAROUSEL CONTAINER
// ─────────────────────────────────────────────────────────────

export async function createCarouselContainer({
  igUserId,
  pageAccessToken,
  childContainerIds,
  caption,
}: {
  igUserId: string;
  pageAccessToken: string;
  childContainerIds: string[];
  caption?: string;
}): Promise<string> {
  if (childContainerIds.length < 2) {
    throw new Error(
      "An Instagram carousel requires at least two media items."
    );
  }

  if (childContainerIds.length > 10) {
    throw new Error(
      "An Instagram carousel cannot contain more than ten media items."
    );
  }

  const params: Record<string, string> = {
    access_token: pageAccessToken,
    media_type: "CAROUSEL",
    children: childContainerIds.join(","),
  };

  if (caption) {
    params.caption = caption;
  }

  const result = await graphPost<MediaContainerResponse>(
    `/${igUserId}/media`,
    params
  );

  if (!result.id) {
    throw new Error(
      "Instagram did not return a carousel container ID."
    );
  }

  return result.id;
}

// ─────────────────────────────────────────────────────────────
// WAIT FOR MEDIA PROCESSING
// ─────────────────────────────────────────────────────────────

export async function waitForContainerReady(
  containerId: string,
  pageAccessToken: string,
  maxAttempts = 5
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result =
      await graphGet<ContainerStatusResponse>(
        `/${containerId}`,
        {
          fields: "status_code,status",
          access_token: pageAccessToken,
        }
      );

    const status = result.status_code;

    if (
      status === "FINISHED" ||
      status === "PUBLISHED"
    ) {
      return;
    }

    if (status === "ERROR") {
      throw new Error(
        result.status ||
          "Instagram failed to process the media."
      );
    }

    if (status === "EXPIRED") {
      throw new Error(
        "The Instagram media container expired before publishing."
      );
    }

    if (attempt < maxAttempts - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 60_000);
      });
    }
  }

  throw new Error(
    "Timed out waiting for Instagram to finish processing the media."
  );
}

// ─────────────────────────────────────────────────────────────
// PUBLISH CONTAINER
// ─────────────────────────────────────────────────────────────

export async function publishContainer(
  igUserId: string,
  containerId: string,
  pageAccessToken: string
): Promise<string> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/instagram.ts#publishContainer@537"); } /* end-canonical-integration-boundary */

  const result = await graphPost<{ id: string }>(
    `/${igUserId}/media_publish`,
    {
      creation_id: containerId,
      access_token: pageAccessToken,
    }
  );

  if (!result.id) {
    throw new Error(
      "Instagram did not return the published media ID."
    );
  }

  return result.id;
}

// ─────────────────────────────────────────────────────────────
// GET PUBLISHED MEDIA PERMALINK
// ─────────────────────────────────────────────────────────────

export async function getMediaPermalink(
  mediaId: string,
  pageAccessToken: string
): Promise<string | null> {
  try {
    const result = await graphGet<{
      permalink?: string;
    }>(`/${mediaId}`, {
      fields: "permalink",
      access_token: pageAccessToken,
    });

    return result.permalink ?? null;
  } catch {
    return null;
  }
}
