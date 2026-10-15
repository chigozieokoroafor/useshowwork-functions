import { getFileContentType } from "@/lib/mediaFileTypes";
/**
 * Computes width ÷ height for a local file the user just selected —
 * reading it straight from their own device via an object URL, never
 * touching the network. This is what lets the value be known at
 * upload time instead of needing every full file downloaded again
 * later just to learn its shape.
 *
 * Resolves to null (rather than rejecting) on any failure — an
 * upload should never be blocked just because this nice-to-have
 * measurement didn't work out for one particular file.
 */
export function detectLocalFileAspectRatio(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(objectUrl);

    if (getFileContentType(file).startsWith("video/")) {
      const vid = document.createElement("video");
      vid.preload = "metadata";
      vid.onloadedmetadata = () => {
        const ratio = vid.videoWidth && vid.videoHeight ? vid.videoWidth / vid.videoHeight : null;
        cleanup();
        resolve(ratio);
      };
      vid.onerror = () => {
        cleanup();
        resolve(null);
      };
      vid.src = objectUrl;
    } else {
      const img = new Image();
      img.onload = () => {
        const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null;
        cleanup();
        resolve(ratio);
      };
      img.onerror = () => {
        cleanup();
        resolve(null);
      };
      img.src = objectUrl;
    }
  });
}