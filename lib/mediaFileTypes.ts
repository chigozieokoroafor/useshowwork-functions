/** Shared browser/server media type detection, including files with missing MIME metadata. */
const IMAGE_TYPES: Record<string, string> = {
  jpg: "jpeg", jpeg: "jpeg", jpe: "jpeg", jfif: "jpeg", png: "png", apng: "apng",
  gif: "gif", webp: "webp", avif: "avif", svg: "svg+xml", svgz: "svg+xml",
  bmp: "bmp", dib: "bmp", tif: "tiff", tiff: "tiff", ico: "vnd.microsoft.icon",
  cur: "vnd.microsoft.icon", heic: "heic", heif: "heif", hif: "heif",
  heics: "heic-sequence", heifs: "heif-sequence", jxl: "jxl", jp2: "jp2",
  j2k: "jp2", jpf: "jpx", jpx: "jpx", jpm: "jpm", psd: "vnd.adobe.photoshop",
  raw: "x-raw", dng: "x-adobe-dng", cr2: "x-canon-cr2", cr3: "x-canon-cr3",
  nef: "x-nikon-nef", nrw: "x-nikon-nrw", arw: "x-sony-arw", sr2: "x-sony-sr2",
  orf: "x-olympus-orf", rw2: "x-panasonic-rw2", raf: "x-fuji-raf",
  pef: "x-pentax-pef", srw: "x-samsung-srw", exr: "x-exr", hdr: "vnd.radiance",
  ppm: "x-portable-pixmap", pgm: "x-portable-graymap", pbm: "x-portable-bitmap",
  pnm: "x-portable-anymap", tga: "x-tga", pcx: "x-pcx", eps: "x-eps",
};
const VIDEO_TYPES: Record<string, string> = {
  mp4: "mp4", m4v: "x-m4v", mov: "quicktime", qt: "quicktime", webm: "webm",
  avi: "x-msvideo", mkv: "x-matroska", mk3d: "x-matroska", wmv: "x-ms-wmv",
  asf: "x-ms-asf", flv: "x-flv", f4v: "mp4", mpg: "mpeg", mpeg: "mpeg",
  mpe: "mpeg", m1v: "mpeg", m2v: "mpeg", mpv: "mpeg", ogv: "ogg", ogm: "ogg",
  ogg: "ogg", '3gp': "3gpp", '3g2': "3gpp2", ts: "mp2t", mts: "mp2t",
  m2ts: "mp2t", m2t: "mp2t", vob: "mpeg", mxf: "mxf", rm: "vnd.rn-realvideo",
  rmvb: "vnd.rn-realvideo", divx: "x-msvideo", dv: "dv", nut: "x-nut",
};
export const IMAGE_FILE_ACCEPT = ["image/*", ...Object.keys(IMAGE_TYPES).map(ext => `.${ext}`)].join(",");
export const VIDEO_FILE_ACCEPT = ["video/*", ...Object.keys(VIDEO_TYPES).map(ext => `.${ext}`)].join(",");
export const MEDIA_FILE_ACCEPT = `${IMAGE_FILE_ACCEPT},${VIDEO_FILE_ACCEPT}`;

export function resolveFileContentType(filename: string, contentType: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/") || type.startsWith("video/")) return type;
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_TYPES[extension]) return `image/${IMAGE_TYPES[extension]}`;
  if (VIDEO_TYPES[extension]) return `video/${VIDEO_TYPES[extension]}`;
  return type || "application/octet-stream";
}
export function getFileContentType(file: { name?: string; type: string }): string {
  return resolveFileContentType(file.name ?? "", file.type);
}
