/**
 * Downloads a single file by navigating to our own server-side proxy
 * route, keyed by the file's mediaId — never a raw URL, since the
 * proxy is what actually enforces payment status server-side. A plain
 * page navigation, not a JS fetch of cross-origin bytes, so CORS is
 * never a factor here regardless of file-storage configuration.
 */
export async function downloadFile(mediaId: string) {
  const proxyUrl = `/api/download?mediaId=${encodeURIComponent(mediaId)}`;

  // A HEAD-style check first via a real GET so we can surface the
  // payment-required message clearly, rather than the browser just
  // downloading a JSON error file named after the request.
  const res = await fetch(proxyUrl);
  if (!res.ok) {
    if (res.status === 402) {
      throw new Error("Payment confirmation required before this file can be downloaded.");
    }
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `Download failed (${res.status})`);
  }

  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="(.+)"/);
  const filename = match?.[1] ?? "file";

  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

/**
 * Downloads several files bundled into a single .zip, each fetched
 * through the same mediaId-based proxy — so the payment check applies
 * uniformly whether someone downloads one file or all of them.
 *
 * Note: this happens entirely in the browser's memory. It's fine for
 * typical photo sets and a handful of short videos, but a very large
 * batch of multi-GB videos could strain a phone's or laptop's memory.
 * If that becomes a real problem, the proper fix is a server-side
 * streaming zip instead — worth revisiting if creators start hitting it.
 */
export async function downloadAllAsZip(
  items: { mediaId: string }[],
  zipFilename: string,
  onProgress?: (done: number, total: number) => void
) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();

  for (let i = 0; i < items.length; i++) {
    const { mediaId } = items[i];
    const res = await fetch(`/api/download?mediaId=${encodeURIComponent(mediaId)}`);
    if (!res.ok) {
      if (res.status === 402) {
        throw new Error("Payment confirmation required before these files can be downloaded.");
      }
      throw new Error(`Failed to fetch a file (${res.status})`);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="(.+)"/);
    const filename = match?.[1] ?? `file-${i + 1}`;
    const blob = await res.blob();
    zip.file(filename, blob);
    onProgress?.(i + 1, items.length);
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const blobUrl = URL.createObjectURL(zipBlob);

  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = zipFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}