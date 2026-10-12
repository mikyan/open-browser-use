import { OpenBrowserUseDownload, downloadID } from "./downloads.js";
import type { JsonValue } from "./index.js";

export type OpenBrowserUseDownloadWaitOptions = { timeoutMs?: number; requirePath?: boolean };
export const downloadWaitMethods = new Set(["armDownloadWait", "collectDownloadWait", "cancelDownloadWait"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 128;

export function downloadWaitTimeout(options: OpenBrowserUseDownloadWaitOptions = {}): number {
  if (!object(options) || Object.keys(options).some(key => key !== "timeoutMs" && key !== "requirePath")) throw new Error("Download wait options only accept timeoutMs and requirePath");
  if (Object.hasOwn(options, "requirePath") && typeof options.requirePath !== "boolean") throw new Error("Download wait requirePath must be boolean");
  const timeout = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error("Download wait timeoutMs must be an integer from 1 to 120000");
  return timeout;
}
export function downloadWaitParams(method: string, params: Record<string, unknown>): void {
  const allowed = ["session_id", "turn_id", "control_epoch", "tabId", method === "armDownloadWait" ? "timeoutMs" : "waiterId"];
  if (method === "armDownloadWait") allowed.push("requirePath");
  if (!object(params) || Object.keys(params).some(key => !allowed.includes(key)) || !Number.isSafeInteger(params.tabId) || (params.tabId as number) < 0 ||
      (method !== "armDownloadWait" && !identifier(params.waiterId))) throw new Error("Invalid download wait parameters");
  for (const key of ["session_id", "turn_id"]) {
    const value = params[key];
    if (Object.hasOwn(params, key) && (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 4096)) throw new Error("Invalid download wait scope");
  }
  if (Object.hasOwn(params, "control_epoch") && (!Number.isSafeInteger(params.control_epoch) || (params.control_epoch as number) < 1)) throw new Error("Invalid download wait scope");
  if (method === "armDownloadWait") downloadWaitTimeout({ timeoutMs: params.timeoutMs as number | undefined,
    ...(Object.hasOwn(params, "requirePath") ? { requirePath: params.requirePath as boolean } : {}) });
}
export function downloadWaitAck(value: unknown, timeout: number): { waiterId: string; remainingMs: number } {
  if (!object(value) || Object.keys(value).length !== 2 || !identifier(value.waiterId) || typeof value.remainingMs !== "number" ||
      !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > timeout) throw new Error("Invalid download wait ready acknowledgement");
  return { waiterId: value.waiterId, remainingMs: value.remainingMs };
}
export function downloadWaitCancelled(value: unknown): void {
  if (!object(value) || Object.keys(value).length) throw new Error("Invalid download wait cancellation acknowledgement");
}
export function assertDownloadWaitDeadline(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new Error("Open Browser Use download wait timed out; request was not sent");
  return remaining;
}

/** Observes one page download. Cancelling this wait does not cancel a transfer. */
export class OpenBrowserUseDownloadWait {
  readonly waiterId: string;
  readonly remainingMs: number;
  #collecting = false;
  #finished = false;
  constructor(ack: { waiterId: string; remainingMs: number }, private readonly deadline: number,
      private readonly call: (method: string, timeoutMs: number, startBefore?: number) => Promise<JsonValue>,
      private readonly download: (id: string) => OpenBrowserUseDownload) {
    this.waiterId = ack.waiterId; this.remainingMs = ack.remainingMs;
  }
  async result(): Promise<OpenBrowserUseDownload> {
    if (this.#collecting) throw new Error("OBU_DOWNLOAD_WAIT_CONFLICT: result is already pending");
    if (this.#finished) throw new Error("OBU_DOWNLOAD_WAIT_INVALID: wait has already been consumed or cancelled");
    this.#collecting = true;
    try {
      const remaining = assertDownloadWaitDeadline(this.deadline);
      const id = downloadID(await this.call("collectDownloadWait", remaining + 1000, this.deadline));
      this.#finished = true;
      return this.download(id);
    } finally { this.#collecting = false; }
  }
  async cancel(): Promise<void> {
    // Cleanup remains retryable after expiry, without extending the observation.
    downloadWaitCancelled(await this.call("cancelDownloadWait", 10000));
    this.#finished = true;
  }
}
