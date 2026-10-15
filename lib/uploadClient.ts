"use client";

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
  attempt: number;
};

export type UploadResult = {
  status: number;
  etag: string | null;
};

type UploadOptions = {
  contentType?: string;
  retries?: number;
  timeoutMs?: number;
  onProgress?: (progress: UploadProgress) => void;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function putOnce(
  url: string,
  body: Blob,
  options: UploadOptions,
  attempt: number
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (options.contentType) xhr.setRequestHeader("Content-Type", options.contentType);
    xhr.timeout = options.timeoutMs ?? 0;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      options.onProgress?.({
        loaded: event.loaded,
        total: event.total,
        percent: Math.min(100, Math.floor((event.loaded / event.total) * 100)),
        attempt,
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.({ loaded: body.size, total: body.size, percent: 100, attempt });
        resolve({ status: xhr.status, etag: xhr.getResponseHeader("ETag") });
      } else {
        const error = new Error(`Upload failed (${xhr.status})`) as Error & { status?: number };
        error.status = xhr.status;
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.onabort = () => reject(new Error("Upload was interrupted"));
    xhr.send(body);
  });
}

/** PUTs directly to object storage, with real byte progress and bounded retry for transient failures. */
export async function putFileWithProgress(
  url: string,
  body: Blob,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const retries = Math.max(0, options.retries ?? 2);
  for (let attempt = 1; ; attempt += 1) {
    try {
      options.onProgress?.({ loaded: 0, total: body.size, percent: 0, attempt });
      return await putOnce(url, body, options, attempt);
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      const retryable = status === undefined || status === 0 || RETRYABLE_STATUS.has(status);
      if (!retryable || attempt > retries) throw error;
      options.onProgress?.({ loaded: 0, total: body.size, percent: 0, attempt: attempt + 1 });
      await wait(Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
    }
  }
}

export function getUploadPercent(loaded: number, total: number) {
  return total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
}

/** Sends a form payload through XHR so non-R2 import/upload APIs can expose byte progress too. */
export function postFormWithProgress(
  url: string,
  formData: FormData,
  onProgress: (percent: number) => void
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(getUploadPercent(event.loaded, event.total));
    };
    xhr.onload = () => {
      onProgress(100);
      resolve({ status: xhr.status, body: xhr.responseText });
    };
    xhr.onerror = () => reject(new Error("Network error while sending the file"));
    xhr.onabort = () => reject(new Error("File upload was interrupted"));
    xhr.send(formData);
  });
}
