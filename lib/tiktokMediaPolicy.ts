/** Existing TikTok media policy, shared by the legacy wrapper and canonical host. */
import sharp from 'sharp';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveTikTokConverter} from './tiktokProbe';
const run=promisify(execFile);
export type MediaProbe = { format?: { duration?: string; format_name?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }[] };
const VIDEO_FORMATS = "mov,matroska,webm,avi,asf,flv,mpeg,mpegvideo,mpegts,ogg,rm,mxf,dv,nut";
const IMAGE_FORMATS = "image2,image2pipe,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,tiff_pipe,jpeg2000_pipe,exr_pipe,psd_pipe,ico,gif,apng,mov,avif";
export function validateTikTokMediaProbe(probe: MediaProbe, size: number, type: string, maxDuration: number) {
  const stream = probe.streams?.find(s => s.codec_type === "video");
  if (!stream || !stream.width || !stream.height) throw new Error("Could not verify this file's dimensions. Upload a readable image or video.");
  if (type === "VIDEO") {
    const duration = Number(probe.format?.duration || stream.duration);
    const [numerator, denominator = "1"] = (stream.avg_frame_rate || "").split("/");
    const fps = Number(numerator) / Number(denominator);
    if (!Number.isFinite(duration) || duration <= 0 || duration > maxDuration) throw new Error(`This TikTok account supports videos up to ${maxDuration} seconds. Shorten the video before publishing.`);
    if (!Number.isFinite(fps) || fps < 23 || fps > 60) throw new Error("TikTok videos must have a frame rate between 23 and 60 FPS.");
    if (Math.min(stream.width, stream.height) < 360 || Math.max(stream.width, stream.height) > 4096) throw new Error("TikTok video dimensions must be between 360 and 4096 pixels on each side.");
    if (!["h264", "hevc", "vp8", "vp9"].includes(stream.codec_name || "") || !/(mov|mp4|matroska|webm)/.test(probe.format?.format_name || "")) throw new Error("Use an MP4, MOV or WebM video with H.264, H.265, VP8 or VP9 encoding.");
    if (size > 4 * 1024 ** 3) throw new Error("TikTok videos must be 4 GB or smaller.");
  } else {
    if (!["mjpeg", "webp"].includes(stream.codec_name || "")) throw new Error("The prepared TikTok photo must be JPEG or WebP.");
    if (Math.max(stream.width, stream.height) > 1920 || Math.min(stream.width, stream.height) > 1080) throw new Error("Resize TikTok photos to 1080p or smaller before publishing.");
    if (size > 20 * 1024 ** 2) throw new Error("Each TikTok photo must be 20 MB or smaller.");
  }
}

export async function convertTikTokImage(input: Buffer): Promise<Buffer> {
  const image = sharp(input, { animated: false, limitInputPixels: 100_000_000 });
  const metadata = await image.metadata();
  const rotated = (metadata.orientation || 1) >= 5;
  const width = rotated ? metadata.height : metadata.width;
  const height = rotated ? metadata.width : metadata.height;
  const landscape = (width || 0) > (height || 0);
  return image.rotate().flatten({ background: "#ffffff" })
    .resize({ width: landscape ? 1920 : 1080, height: landscape ? 1080 : 1920, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

export async function prepareTikTokImage(input: Buffer, filename = "") {
  try { return await convertTikTokImage(input); }
  catch {
    // Many Linux image builds decode AVIF but do not ship the HEVC decoder
    // needed by iPhone HEIC files. Use a portable HEIF decoder for those.
    const brands = input.subarray(8, 64).toString("ascii");
    if (input.subarray(4, 8).toString("ascii") === "ftyp" && /heic|heix|hevc|hevx|mif1|msf1/.test(brands)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const convert = require("heic-convert") as (options: { buffer: Buffer; format: "PNG" }) => Promise<ArrayBuffer>;
        return await convertTikTokImage(Buffer.from(await convert({ buffer: input, format: "PNG" })));
      } catch { throw new Error("This HEIC/HEIF image could not be decoded. Export a PNG or JPEG copy from your photo app and try again."); }
    }
    // FFmpeg covers additional image decoders, such as BMP/PSD/portable maps.
    const binary = await resolveTikTokConverter();
    const directory = await mkdtemp(join(tmpdir(), "showwork-image-"));
    try {
      const extension = filename.split(".").pop()?.toLowerCase();
      const source = join(directory, `source.${extension && /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin"}`); const output = join(directory, "frame.png");
      await writeFile(source, input);
      await run(binary, ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-format_whitelist", IMAGE_FORMATS, "-i", source, "-frames:v", "1", "-vf", "scale=1080:1080:force_original_aspect_ratio=decrease", output], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      const { readFile } = await import("node:fs/promises");
      return await convertTikTokImage(await readFile(output));
    } catch {
      throw new Error("This image could not be decoded for TikTok. Export it as PNG or JPEG and upload that copy. Proprietary camera/editor files may require their original software.");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

export function validateTikTokSourceVideo(probe: MediaProbe, size: number, maxDuration: number) {
  const stream = probe.streams?.find(s => s.codec_type === "video");
  const duration = Number(probe.format?.duration || stream?.duration);
  if (!stream || !stream.width || !stream.height || !Number.isFinite(duration) || duration <= 0) throw new Error("This video could not be decoded. Export a playable video and upload it again.");
  if (duration > maxDuration) throw new Error(`This TikTok account supports videos up to ${maxDuration} seconds. Shorten the video before publishing.`);
  if (size > 4 * 1024 ** 3) throw new Error("TikTok videos must be 4 GB or smaller.");
}

export function tikTokConversionArgs(url: string, output: string, probe: MediaProbe) {
  const stream = probe.streams?.find(s => s.codec_type === "video");
  const [n, d = "1"] = (stream?.avg_frame_rate || "30/1").split("/");
  const sourceFps = Number(n) / Number(d);
  const fps = Number.isFinite(sourceFps) && sourceFps >= 23 && sourceFps <= 60 ? sourceFps : 30;
  return ["-v", "error", "-nostdin", "-rw_timeout", "15000000", "-protocol_whitelist", "https,http,tls,tcp", "-format_whitelist", VIDEO_FORMATS,
    "-i", url, "-map", "0:v:0", "-map", "0:a:0?", "-vf", `scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=max(360\\,iw):max(360\\,ih):(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-threads", "2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    // Bound temporary disk use. Duration comparison below rejects truncation.
    "-fs", String(450 * 1024 ** 2), output];
}
