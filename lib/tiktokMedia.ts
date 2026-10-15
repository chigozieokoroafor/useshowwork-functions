import {validateTikTokMediaProbe,convertTikTokImage,prepareTikTokImage,validateTikTokSourceVideo,tikTokConversionArgs,type MediaProbe} from './tiktokMediaPolicy';
export {validateTikTokMediaProbe,convertTikTokImage,prepareTikTokImage,validateTikTokSourceVideo,tikTokConversionArgs,type MediaProbe} from './tiktokMediaPolicy';
import { publishingFetch as fetch } from "@/lib/publishing/executionContext";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveTikTokProbe, resolveTikTokConverter, tikTokProbeError } from "@/lib/tiktokProbe";
import { publicUrlFor, putTikTokPreparedFile } from "@/lib/r2";
import type { TikTokCreator } from "@/lib/tiktokSettings";

const run = promisify(execFile);
export type PreparedTikTokMedia = { url: string; converted: boolean };
const VIDEO_FORMATS = "mov,matroska,webm,avi,asf,flv,mpeg,mpegvideo,mpegts,ogg,rm,mxf,dv,nut";
const IMAGE_FORMATS = "image2,image2pipe,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,tiff_pipe,jpeg2000_pipe,exr_pipe,psd_pipe,ico,gif,apng,mov,avif";



// Decode actual pixels, apply EXIF orientation and retain the entire image.
// Animated PHOTO uploads use the first frame; transparency becomes white.


async function probeVideo(url: string): Promise<MediaProbe> {
  const binary = await resolveTikTokProbe();
  try {
    const { stdout } = await run(binary, ["-v", "error", "-rw_timeout", "10000000", "-protocol_whitelist", "https,http,tls,tcp", "-format_whitelist", VIDEO_FORMATS, "-show_streams", "-show_format", "-of", "json", url], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const failure = error as { code?: string | number; killed?: boolean; stderr?: string };
    console.error("TikTok media inspection failed", { code: failure.code, killed: !!failure.killed, detail: (failure.stderr || "").replace(/https?:\/\/\S+/g, "[media URL]").slice(-600) });
    throw tikTokProbeError(error);
  }
}

async function readImage(url: string, size: number) {
  if (size > 100 * 1024 ** 2) throw new Error("This image is too large to prepare. Export a copy smaller than 100 MB.");
  const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("Could not read the uploaded image. Try uploading it again.");
  const chunks: Buffer[] = []; let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 100 * 1024 ** 2) throw new Error("This image is too large to prepare. Export a copy smaller than 100 MB.");
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}







async function prepareVideo(url: string, probe: MediaProbe, creator: TikTokCreator, sourceKey: string) {
  const binary = await resolveTikTokConverter();
  const directory = await mkdtemp(join(tmpdir(), "showwork-video-"));
  try {
    const output = join(directory, "video.mp4");
    await run(binary, tikTokConversionArgs(url, output, probe), { timeout: 8 * 60_000, maxBuffer: 1024 * 1024 });
    const size = (await stat(output)).size;
    const inspector = await resolveTikTokProbe();
    const { stdout } = await run(inspector, ["-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov", "-show_streams", "-show_format", "-of", "json", output], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const result: MediaProbe = JSON.parse(stdout);
    validateTikTokMediaProbe(result, size, "VIDEO", creator.max_video_post_duration_sec);
    const inputDuration = Number(probe.format?.duration || probe.streams?.find(s => s.codec_type === "video")?.duration);
    const outputDuration = Number(result.format?.duration);
    if (Math.abs(inputDuration - outputDuration) > Math.max(0.5, inputDuration * 0.002)) throw new Error("The converted video is incomplete. Export a smaller MP4 copy and try again.");
    const key = `${sourceKey.slice(0, sourceKey.lastIndexOf("/") + 1)}tiktok-prepared-${randomUUID()}.mp4`;
    try { await putTikTokPreparedFile(key, createReadStream(output), "video/mp4", size); }
    catch { throw new Error("The prepared video could not be stored. Try again or contact support."); }
    return { url: publicUrlFor(key), converted: true };
  } catch (error) {
    if (error instanceof Error && /incomplete|TikTok videos|duration|dimensions|frame rate|could not be stored/.test(error.message)) throw error;
    throw new Error("This video could not be converted for TikTok. Export a smaller playable MP4 copy and try again. The original has been preserved.");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Preflight decodes images and checks video duration without making a TikTok
// request. The background worker creates temporary JPEG/MP4 copies as needed.
export async function validateTikTokMedia(assets: { fileKey: string; mediaType: string }[], creator: TikTokCreator, options: { publish?: boolean } = {}): Promise<PreparedTikTokMedia[]> {
  async function inspect(asset: { fileKey: string; mediaType: string }): Promise<PreparedTikTokMedia> {
    const url = publicUrlFor(asset.fileKey);
    if (new URL(url).protocol !== "https:") throw new Error("TikTok media must use a public HTTPS URL.");
    const head = await fetch(url, { method: "HEAD", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const size = Number(head.headers.get("content-length"));
    if (!head.ok || !Number.isFinite(size) || size <= 0) throw new Error("This media file is not publicly accessible. Upload it again before publishing.");
    if (asset.mediaType === "PHOTO") {
      const jpeg = await prepareTikTokImage(await readImage(url, size), asset.fileKey);
      if (jpeg.length > 20 * 1024 ** 2) throw new Error("The prepared photo exceeds TikTok's 20 MB limit.");
      if (!options.publish) return { url, converted: true };
      const key = `${asset.fileKey.slice(0, asset.fileKey.lastIndexOf("/") + 1)}tiktok-prepared-${randomUUID()}.jpg`;
      await putTikTokPreparedFile(key, jpeg, "image/jpeg", jpeg.length);
      return { url: publicUrlFor(key), converted: true };
    }
    if (asset.mediaType !== "VIDEO") throw new Error("Only images and videos can be published to TikTok.");
    const probe = await probeVideo(url);
    validateTikTokSourceVideo(probe, size, creator.max_video_post_duration_sec);
    const contentType = (head.headers.get("content-type") || "").split(";")[0].toLowerCase();
    let compatible = ["video/mp4", "video/quicktime", "video/webm"].includes(contentType) &&
      (!(probe.format?.format_name || "").includes("matroska") || contentType === "video/webm");
    try { validateTikTokMediaProbe(probe, size, "VIDEO", creator.max_video_post_duration_sec); }
    catch { compatible = false; }
    if (compatible || !options.publish) return { url, converted: !compatible };
    return prepareVideo(url, probe, creator, asset.fileKey);
  }
  const results: PreparedTikTokMedia[] = [];
  // Serial video transcoding avoids exceeding serverless disk/CPU limits.
  const concurrency = assets.some(a => a.mediaType === "VIDEO") ? 1 : 4;
  for (let index = 0; index < assets.length; index += concurrency) results.push(...await Promise.all(assets.slice(index, index + concurrency).map(inspect)));
  return results;
}
