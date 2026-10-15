import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import { publishingFetch as fetch } from "@/lib/publishing/executionContext";
import type { CalendarPost, CalendarPostAsset, SocialConnection } from "@prisma/client";
import { publicUrlFor } from "@/lib/r2";
import { requireScopes } from "@/lib/socialTokens";
import { buildCaption, validatePublishContent } from "./state";
import { linkedInHeaders, mediaBytes, pause, providerJson } from "./http";

type Post = CalendarPost & { assets: CalendarPostAsset[] };
type Result = { id: string; permalink?: string };
type Checkpoint = (id: string) => Promise<void>;

export async function publishFacebook(post: Post, connection: SocialConnection, checkpoint: Checkpoint = async () => {}): Promise<Result> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/providers.ts#publishFacebook@12"); } /* end-canonical-integration-boundary */

  requireScopes(connection, ["pages_manage_posts", "pages_read_engagement"]);
  const base = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || "v26.0"}`;
  const page = encodeURIComponent(connection.platformAccountId);
  const caption = buildCaption(post);
  validatePublishContent("FACEBOOK", post.assets, caption, post.postType);
  const send = (path: string, body: Record<string, unknown>) => providerJson<{ id?: string; post_id?: string }>(`${base}/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let result: { id?: string; post_id?: string };
  if (post.assets[0]?.mediaType === "VIDEO") {
    const reel = /reel/i.test(post.postType ?? "");
    let id = post.platformPostId;
    if (!id) {
      if (reel) {
        const initialized = await providerJson<{ video_id: string; upload_url: string }>(`${base}/${page}/video_reels`, { method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ upload_phase: "start" }) });
        if (!initialized.video_id || !initialized.upload_url) throw new Error("Facebook did not return a Reel upload session.");
        const uploadUrl = new URL(initialized.upload_url);
        if (uploadUrl.protocol !== "https:" || uploadUrl.hostname !== "rupload.facebook.com") throw new Error("Facebook returned an unexpected upload host.");
        await providerJson(uploadUrl.toString(), { method: "POST", headers: { Authorization: `OAuth ${connection.accessToken}`, file_url: publicUrlFor(post.assets[0].fileKey) } });
        await send(`${page}/video_reels`, { upload_phase: "finish", video_id: initialized.video_id, video_state: "PUBLISHED", description: caption });
        id = initialized.video_id;
      } else {
        const video = await providerJson<{ id: string }>(`${base.replace("graph.facebook", "graph-video.facebook")}/${page}/videos`, { method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ file_url: publicUrlFor(post.assets[0].fileKey), description: caption }) });
        id = video.id;
      }
      if (!id) throw new Error("Facebook did not return a video ID. Check the Page before retrying.");
      await checkpoint(id);
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await providerJson<{ status?: { video_status?: string; publishing_phase?: { status?: string } } }>(`${base}/${encodeURIComponent(id)}?fields=status`, { headers: { Authorization: `Bearer ${connection.accessToken}` } });
      if (response.status?.video_status === "error" || response.status?.publishing_phase?.status === "error") throw new Error("Facebook video processing failed. Check the Page before retrying.");
      if (response.status?.video_status === "ready" && (!reel || response.status?.publishing_phase?.status === "complete")) return { id, permalink: reel ? `https://www.facebook.com/reel/${id}` : `https://www.facebook.com/${id}` };
      await pause(3000);
    }
    throw new Error("Facebook is still processing this video. Retry to check the existing upload; do not create a second post.");
  } else if (post.assets.length) {
    const attached = [];
    for (const asset of post.assets) {
      const photo = await send(`${page}/photos`, { url: publicUrlFor(asset.fileKey), published: false });
      if (!photo.id) throw new Error("Facebook did not return an uploaded photo ID.");
      attached.push({ media_fbid: photo.id });
    }
    result = await send(`${page}/feed`, { message: caption, attached_media: attached });
  } else {
    result = await send(`${page}/feed`, { message: caption, ...(post.linkUrl ? { link: post.linkUrl } : {}) });
  }
  const id = result.post_id || result.id;
  if (!id) throw new Error("Facebook did not confirm a post ID. Check the Page before retrying.");
  return { id, permalink: `https://www.facebook.com/${id}` };
}

async function uploadXMedia(asset: CalendarPostAsset, token: string) {
  const url = publicUrlFor(asset.fileKey);
  const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
  const total = Number(head.headers.get("content-length"));
  const type = head.headers.get("content-type")?.split(";")[0];
  if (!head.ok || !total || !type) throw new Error("Could not determine media size/type for X.");
  const headers = { Authorization: `Bearer ${token}` };
  const initialized = await providerJson<{ data: { id: string } }>("https://api.x.com/2/media/upload/initialize", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ media_type: type, total_bytes: total, media_category: asset.mediaType === "VIDEO" ? "tweet_video" : type === "image/gif" ? "tweet_gif" : "tweet_image" }),
  });
  const id = initialized.data?.id;
  if (!id) throw new Error("X did not return a media upload ID.");
  const chunkSize = 4 * 1024 * 1024;
  for (let start = 0, segment = 0; start < total; start += chunkSize, segment++) {
    const { bytes } = await mediaBytes(url, start, Math.min(total - 1, start + chunkSize - 1));
    const form = new FormData(); form.set("segment_index", String(segment)); form.set("media", new Blob([bytes], { type }), "chunk");
    await providerJson(`https://api.x.com/2/media/upload/${id}/append`, { method: "POST", headers, body: form });
  }
  type Upload = { data: { processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } } } };
  let result = await providerJson<Upload>(`https://api.x.com/2/media/upload/${id}/finalize`, { method: "POST", headers });
  for (let attempt = 0; attempt < 40; attempt++) {
    const info = result.data?.processing_info;
    if (!info || info.state === "succeeded") return id;
    if (info.state === "failed") throw new Error(info.error?.message || "X could not process the media.");
    await pause(Math.min(10, Math.max(1, info.check_after_secs || 2)) * 1000);
    result = await providerJson<Upload>(`https://api.x.com/2/media/upload?command=STATUS&media_id=${id}`, { headers });
  }
  throw new Error("X media processing timed out. No post has been created.");
}
export async function publishX(post: Post, connection: SocialConnection): Promise<Result> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/providers.ts#publishX@94"); } /* end-canonical-integration-boundary */

  requireScopes(connection, ["tweet.write", ...(post.assets.length ? ["media.write"] : [])]);
  const text = buildCaption(post);
  validatePublishContent("X", post.assets, text, post.postType);
  const ids = [];
  for (const asset of post.assets) ids.push(await uploadXMedia(asset, connection.accessToken!));
  const result = await providerJson<{ data: { id: string } }>("https://api.x.com/2/tweets", {
    method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...(ids.length ? { media: { media_ids: ids } } : {}) }),
  });
  if (!result.data?.id) throw new Error("X did not confirm a post ID. Check X before retrying.");
  return { id: result.data.id, permalink: `https://x.com/i/web/status/${result.data.id}` };
}

async function uploadLinkedIn(asset: CalendarPostAsset, author: string, token: string) {
  const video = asset.mediaType === "VIDEO";
  const resource = video ? "videos" : "images";
  const headers = linkedInHeaders(token);
  const url = publicUrlFor(asset.fileKey);
  const result = await providerJson<{ value: { image?: string; video?: string; uploadUrl?: string; uploadToken?: string; uploadInstructions?: { uploadUrl: string; firstByte: number; lastByte: number }[] } }>(`https://api.linkedin.com/rest/${resource}?action=initializeUpload`, {
    method: "POST", headers, body: JSON.stringify({ initializeUploadRequest: { owner: author, ...(video ? { fileSizeBytes: Number(asset.sizeBytes), uploadCaptions: false, uploadThumbnail: false } : {}) } }),
  });
  const value = result.value;
  const id = video ? value.video : value.image;
  if (!id) throw new Error("LinkedIn did not return a media ID.");
  const parts = video ? value.uploadInstructions ?? [] : value.uploadUrl ? [{ uploadUrl: value.uploadUrl }] : [];
  if (!parts.length) throw new Error("LinkedIn did not return media upload instructions.");
  const partIds: string[] = [];
  for (const part of parts) {
    const bytes = "firstByte" in part ? await mediaBytes(url, part.firstByte, part.lastByte) : await mediaBytes(url);
    const response = await fetch(part.uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": bytes.type }, body: bytes.bytes, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`LinkedIn media upload failed (${response.status}).`);
    const etag = response.headers.get("etag");
    if (video && !etag) throw new Error("LinkedIn did not confirm the uploaded video part.");
    if (etag) partIds.push(etag.replace(/"/g, ""));
  }
  if (video) await providerJson(`https://api.linkedin.com/rest/videos?action=finalizeUpload`, { method: "POST", headers, body: JSON.stringify({ finalizeUploadRequest: { video: id, uploadToken: value.uploadToken ?? "", uploadedPartIds: partIds } }) });
  // Member image write access cannot GET versioned images. The successful
  // upload can be referenced directly; LinkedIn validates readiness on create.
  if (!video) return id;
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await providerJson<{ status: string }>(`https://api.linkedin.com/rest/${resource}/${encodeURIComponent(id)}`, { headers });
    if (status.status === "AVAILABLE") return id;
    if (["PROCESSING_FAILED", "WAITING_UPLOAD"].includes(status.status) && attempt > 3) throw new Error("LinkedIn could not process the uploaded media.");
    await pause(3000);
  }
  throw new Error("LinkedIn media processing timed out. No post has been created.");
}
export async function publishLinkedIn(post: Post, connection: SocialConnection): Promise<Result> {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { await assertLegacyPublishingAllowed("lib/publishing/providers.ts#publishLinkedIn@142"); } /* end-canonical-integration-boundary */

  const author = connection.platformAccountId.startsWith("urn:li:") ? connection.platformAccountId : `urn:li:person:${connection.platformAccountId}`;
  requireScopes(connection, [author.startsWith("urn:li:organization:") ? "w_organization_social" : "w_member_social"]);
  const commentary = buildCaption(post);
  validatePublishContent("LINKEDIN", post.assets, commentary, post.postType);
  const media = [];
  for (const asset of post.assets) media.push(await uploadLinkedIn(asset, author, connection.accessToken!));
  const content = media.length > 1 ? { multiImage: { images: media.map(id => ({ id })) } } : media.length ? { media: { id: media[0] } } : undefined;
  const response = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST", headers: linkedInHeaders(connection.accessToken!),
    body: JSON.stringify({ author, commentary, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, ...(content ? { content } : {}), lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false }), signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.message || `LinkedIn publishing failed (${response.status}).`); }
  const id = response.headers.get("x-restli-id");
  if (!id) throw new Error("LinkedIn accepted the request without a post ID. Check LinkedIn before retrying.");
  return { id, permalink: `https://www.linkedin.com/feed/update/${id}/` };
}
