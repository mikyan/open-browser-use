import type { BrowserUseRequestParams, JsonValue } from "./index.js";

export type OpenBrowserUseDownloadOptions = { timeoutMs?: number };
export type OpenBrowserUseDownloadURLOptions = OpenBrowserUseDownloadOptions & { filename?: string };
export type OpenBrowserUseMediaDownloadOptions = OpenBrowserUseDownloadURLOptions;

function validateOptions(options: unknown, keys: string[]): asserts options is Record<string, unknown> {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !keys.includes(key))) throw new Error("Invalid download options: unexpected field");
}

export function downloadTimeout(options: OpenBrowserUseDownloadOptions = {}): number {
  validateOptions(options, ["timeoutMs"]);
  const timeout = options.timeoutMs === undefined ? 10_000 : options.timeoutMs;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error("Download timeoutMs must be an integer from 1 to 120000");
  return timeout;
}

export function downloadURLParams(url: string, options: OpenBrowserUseDownloadURLOptions = {}): BrowserUseRequestParams {
  const params = downloadFileParams(options);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid download URL"); }
  if (typeof url !== "string" || !url || Buffer.byteLength(url, "utf8") > 8192 || /[\x00-\x1f\x7f]/.test(url) || url !== url.trim() || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid download URL: require HTTP(S) without credentials");
  return { ...params, url };
}

export function downloadFileParams(options: OpenBrowserUseMediaDownloadOptions = {}): BrowserUseRequestParams {
  validateOptions(options, ["timeoutMs", "filename"]);
  const params: BrowserUseRequestParams = { timeoutMs: downloadTimeout({ timeoutMs: options.timeoutMs }) };
  if (options.filename !== undefined) {
    const name = options.filename;
    if (typeof name !== "string" || !name || Buffer.byteLength(name, "utf8") > 255 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("Invalid download filename: require a single portable basename");
    params.filename = name;
  }
  return params;
}

export function downloadID(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.downloadId !== "string" || !value.downloadId || Buffer.byteLength(value.downloadId, "utf8") > 256 || Object.keys(value).length !== 1) throw new Error("Invalid download acknowledgement");
  return value.downloadId;
}

/** A download bound to the start request's session, turn and control epoch. */
export class OpenBrowserUseDownload {
  constructor(readonly downloadId: string, private readonly call: (method: string, timeoutMs: number) => Promise<JsonValue>) {}

  async path(options: OpenBrowserUseDownloadOptions = {}): Promise<string> {
    const value = await this.call("downloadPath", downloadTimeout(options));
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.path !== "string" || !value.path || value.path.includes("\0") || Object.keys(value).length !== 1) throw new Error("Invalid download path acknowledgement");
    return value.path;
  }

  async cancel(options: OpenBrowserUseDownloadOptions = {}): Promise<void> {
    const value = await this.call("cancelDownload", downloadTimeout(options));
    if (!value || typeof value !== "object" || Array.isArray(value) || value.cancelled !== true || Object.keys(value).length !== 1) throw new Error("Invalid download cancellation acknowledgement");
  }
}
