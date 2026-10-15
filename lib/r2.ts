import { publishingIntegrationInstalled, invokePublishingEntrypoint, assertLegacyPublishingAllowed } from "@/lib/publishing/applicationBoundary";
import {nativeApplicationContext} from '@/lib/publishing/nativeApplicationContext';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Cloudflare R2 is S3-compatible, so the standard AWS SDK works against it —
// you just point it at R2's endpoint instead of AWS's.
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  // R2 doesn't support the AWS SDK's newer default checksum behavior —
  // without this, presigned PUT uploads fail with 403 Forbidden.
  requestChecksumCalculation: "WHEN_REQUIRED",
  // R2 expects path-style addressing (endpoint/bucket/key), not the
  // virtual-hosted-style (bucket.endpoint/key) the AWS SDK defaults to.
  forcePathStyle: true,
});

const BUCKET = process.env.R2_BUCKET_NAME!;

// Accept every image/video MIME subtype, plus supported document categories.
export function isAllowedContentType(contentType: string) {
  if (typeof contentType !== "string") return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return /^(image|video)\/[a-z0-9][a-z0-9!#$&^_.+\-]*$/.test(type) ||
    type === "application/pdf" ||
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

/**
 * Generates a signed URL the browser can PUT a file to directly — the file
 * bytes never pass through your Next.js server. Only usable for files up
 * to R2's own hard ceiling for a single-part PUT (~5.37GB) — anything
 * larger has to go through the multipart functions below instead, since
 * R2 will reject a single PUT above that regardless of what this URL says.
 * 8 hours gives even a large file real headroom to finish on a slow
 * connection — a 5GB file at ~2Mbps upload can genuinely take hours.
 */
export async function getPresignedUploadUrl(key: string, contentType: string) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, command, { expiresIn: 28800 }); // 8 hours
}

// ─────────────────────────────────────────────
// MULTIPART UPLOAD — R2's real mechanism for files beyond what a
// single PUT can handle. A file gets split into chunks client-side;
// each chunk is uploaded independently via its own presigned URL, and
// a final "complete" call stitches every chunk into one real object.
// The genuine benefit beyond raw size support: if one chunk fails
// partway through a 10GB upload, only that chunk (not the whole file)
// needs retrying.
// ─────────────────────────────────────────────

/**
 * Starts a multipart upload session. Returns an uploadId that ties
 * every subsequent part, and the final completion call, back to this
 * same in-progress file — nothing is a real, readable object in the
 * bucket until completeMultipartUpload is called.
 */
export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const command = new CreateMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const result = await r2.send(command);
  if (!result.UploadId) throw new Error("R2 did not return an upload ID");
  return result.UploadId;
}

/**
 * A signed URL for exactly one chunk of a multipart upload — the
 * browser PUTs that specific chunk's bytes directly to this URL, the
 * same way a whole small file does via getPresignedUploadUrl above.
 * partNumber must be 1-indexed (R2/S3 convention, not 0-indexed) and
 * match whatever's later reported back in completeMultipartUpload.
 */
export async function getPresignedPartUploadUrl(
  key: string,
  uploadId: string,
  partNumber: number
): Promise<string> {
  const command = new UploadPartCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(r2, command, { expiresIn: 28800 }); // 8 hours, same as the single-part URL
}

/**
 * Stitches every uploaded chunk into the final, real object. The browser
 * reports which part numbers completed; ETags are read directly from R2
 * so bucket CORS settings do not need to expose them to browsers.
 */
export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[]
): Promise<void> {
/* canonical-only-helper */
  const applicationScope=nativeApplicationContext();
  if(applicationScope){if(!applicationScope.completeMultipartUpload)throw Error('EXPLICIT_MULTIPART_PORT_REQUIRED');await applicationScope.completeMultipartUpload(key,uploadId,parts.map(part=>({PartNumber:part.partNumber,ETag:part.etag})));return;}
/* end-canonical-only-helper */
  const requestedPartNumbers = [...new Set(parts.map((part) => part.partNumber))].sort((a, b) => a - b);
  if (
    requestedPartNumbers.length !== parts.length ||
    requestedPartNumbers.some((partNumber, index) => !Number.isInteger(partNumber) || partNumber < 1 || partNumber !== index + 1)
  ) {
    throw new Error("Multipart completion requires a complete, ordered part-number list");
  }

  // Read ETags from R2 itself. Browsers cannot always read the ETag
  // response header due to bucket CORS configuration, even when a part
  // upload succeeded. The storage service is the authoritative source.
  const uploadedParts: { PartNumber: number; ETag: string }[] = [];
  let partNumberMarker: string | undefined;
  do {
    const listed = await r2.send(new ListPartsCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumberMarker: partNumberMarker,
    }));
    for (const part of listed.Parts ?? []) {
      if (typeof part.PartNumber === "number" && part.ETag) {
        uploadedParts.push({ PartNumber: part.PartNumber, ETag: part.ETag });
      }
    }
    partNumberMarker = listed.IsTruncated && listed.NextPartNumberMarker !== undefined
      ? String(listed.NextPartNumberMarker)
      : undefined;
  } while (partNumberMarker !== undefined);

  uploadedParts.sort((a, b) => a.PartNumber - b.PartNumber);
  if (
    uploadedParts.length !== requestedPartNumbers.length ||
    uploadedParts.some((part, index) => part.PartNumber !== requestedPartNumbers[index])
  ) {
    throw new Error("The uploaded multipart chunks are incomplete. Please retry the missing chunks.");
  }

  const command = new CompleteMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: uploadedParts },
  });
  await r2.send(command);
}

/**
 * Cancels an in-progress multipart upload and tells R2 to discard
 * whatever chunks were already uploaded. Without ever calling this on
 * a genuinely abandoned upload, those partial chunks sit in the
 * bucket as billed, invisible dead storage forever — they were never
 * "completed" into a real object, so nothing in your normal delete
 * logic (which only ever knows about finished Media rows) would ever
 * find or clean them up.
 */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  const command = new AbortMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
  });
  await r2.send(command);
}

/**
 * Public URL for a file once uploaded. Assumes the bucket is connected to a
 * public R2.dev URL or a custom domain — set R2_PUBLIC_URL accordingly, e.g.
 * "https://media.yourproduct.com" or the default
 * "https://pub-xxxxxx.r2.dev"
 */
export function publicUrlFor(key: string) {
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

// TikTok-ready copies are temporary publishing artifacts; originals are kept.
export async function putTikTokPreparedFile(key: string, body: Buffer | import("node:stream").Readable, contentType: string, size: number) {
  if (!isTikTokPreparedKey(key)) throw new Error("Invalid prepared media key.");
  await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType, ContentLength: size }));
}

export function isTikTokPreparedKey(key: string) {
  return /(?:^|\/)tiktok-prepared-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|mp4)$/.test(key) || /^tiktok-prepared\/[0-9a-f-]{36}\.(jpg|mp4)$/.test(key);
}

export async function cleanupTikTokPreparedFiles() {
/* canonical-only-helper */
  // The intended VPS release retires age-only deletion even in standalone
  // Netlify storage functions, which do not install the Next composition.
  return {deleted:0,retired:true};
/* end-canonical-only-helper */
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let deleted = 0;
  // New copies stay alongside originals to retain verified URL prefixes.
  for (const prefix of ["calendars/", "tiktok-prepared/"]) {
    let cursor: string | undefined;
    do {
      const page = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: cursor, MaxKeys: 1000 }));
      const expired = (page.Contents || []).filter(item => item.Key?.startsWith(prefix) && isTikTokPreparedKey(item.Key) && item.LastModified && item.LastModified.getTime() < cutoff).map(item => ({ Key: item.Key! }));
      if (expired.length) {
        const result = await r2.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: expired } }));
        if (result.Errors?.length) throw new Error("Some temporary TikTok files could not be removed.");
        deleted += expired.length;
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
  }
  return { deleted };
}

/**
 * Builds the storage key/path for a piece of media within a project.
 * Keeping this in one place avoids path mismatches between upload and read.
 */
export function buildMediaKey(projectId: string, filename: string) {
  const safeName = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return `projects/${projectId}/${Date.now()}-${safeName}`;
}

/**
 * Returns the actual size of a completed R2 object.
 *
 * This is used by Content Workspace storage accounting so the server
 * never has to trust a file size supplied by the browser.
 */
export async function getObjectSize(key: string): Promise<number> {
  const result = await r2.send(
    new HeadObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );

  if (typeof result.ContentLength !== "number") {
    throw new Error("R2 did not return the object's content length");
  }

  if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength < 0) {
    throw new Error("R2 returned an invalid object size");
  }

  return result.ContentLength;
}

/**
 * Deletes a file from the bucket. Used when a creator uploads a revised
 * version — the old file is no longer referenced by anything, so we
 * clean it up rather than leaving it as dead storage.
 */
export async function deleteObject(key: string) {
  /* canonical-integration-boundary */ if (publishingIntegrationInstalled()) { const scoped=nativeApplicationContext();if(scoped?.deleteObject)return scoped.deleteObject(key);await assertLegacyPublishingAllowed("lib/r2.ts#deleteObject@264"); } /* end-canonical-integration-boundary */

  await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
}
