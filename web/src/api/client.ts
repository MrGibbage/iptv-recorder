const API_KEY_STORAGE_KEY = "iptv-recorder-api-key";

// Plain localStorage + a window event, not React state, so this module has
// no dependency on React and any component can react to a key changing
// (including a 401 clearing it out from under an in-flight request) just by
// listening for "apikeychange" — see ../hooks/useApiKey.ts.
export function getStoredApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE_KEY);
}

export function storeApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE_KEY, key);
  window.dispatchEvent(new Event("apikeychange"));
}

export function clearStoredApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
  window.dispatchEvent(new Event("apikeychange"));
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const key = getStoredApiKey();
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  if (options.body !== undefined && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (res.status === 401) {
    clearStoredApiKey();
    throw new ApiError(401, "API key is missing, invalid, or revoked");
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") {
        message = body.error;
      }
    } catch {
      // Body wasn't JSON — fall back to statusText.
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export interface DownloadHandle {
  promise: Promise<void>;
  cancel: () => void;
}

// Downloads a file that requires auth (plain <a href> can't send the Bearer
// header) by fetching it and triggering a save via a throwaway <a>.
// Streaming in-page playback via <video src> would need the key in the URL
// (query param) instead, which leaks it into server logs and browser
// history — not worth that trade-off for v1, so download-only.
//
// Reads the response via its ReadableStream rather than the simpler
// `res.blob()` for two reasons that matter once a recording is a
// gigabyte-plus file: (1) `res.blob()` gives no way to report progress, so
// a slow fetch (large file, slow network, a browser that's just slow to
// buffer it) looks identical to a broken button — no feedback at all until
// it either finishes or errors; (2) `res.blob()` can't be aborted cleanly
// once in flight, so a misclick (or several) queues up multiple full-file
// fetches with no way to stop them short of reloading the page. `onProgress`
// and the returned `cancel()` fix both.
export function downloadFile(
  path: string,
  filename: string,
  onProgress?: (loadedBytes: number, totalBytes: number | null) => void,
): DownloadHandle {
  const controller = new AbortController();

  const promise = (async () => {
    const key = getStoredApiKey();
    const headers: Record<string, string> = {};
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    const res = await fetch(`/api${path}`, { headers, signal: controller.signal });
    if (res.status === 401) {
      clearStoredApiKey();
      throw new ApiError(401, "API key is missing, invalid, or revoked");
    }
    if (!res.ok) {
      throw new ApiError(res.status, res.statusText);
    }

    const totalBytes = Number(res.headers.get("Content-Length")) || null;
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loadedBytes += value.length;
      onProgress?.(loadedBytes, totalBytes);
    }

    const blob = new Blob(chunks as BlobPart[]);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    // Appended (and removed after) rather than clicked while detached —
    // some browsers won't reliably fire a synthetic click on an <a> that's
    // never been in the document.
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  })();

  return { promise, cancel: () => controller.abort() };
}
