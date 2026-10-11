export type OpenBrowserUseFileChooserWaitOptions = { timeoutMs?: number };
export type OpenBrowserUseFileChooserWaitResult = { fileChooserId: string; isMultiple: boolean };
export const fileChooserWaitMethods = new Set(["armFileChooserWait", "collectFileChooserWait", "cancelFileChooserWait"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 128;

export function fileChooserWaitTimeout(options: OpenBrowserUseFileChooserWaitOptions = {}): number {
  if (!object(options) || Object.keys(options).some(key => key !== "timeoutMs")) throw new Error("File chooser wait options only accept timeoutMs");
  const timeout = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error("File chooser wait timeoutMs must be an integer from 1 to 120000");
  return timeout;
}
export function fileChooserWaitParams(method: string, params: Record<string, unknown>): void {
  const allowed = ["session_id", "turn_id", "control_epoch", "tabId", method === "armFileChooserWait" ? "timeoutMs" : "waiterId"];
  if (!object(params) || Object.keys(params).some(key => !allowed.includes(key)) || !Number.isSafeInteger(params.tabId) || (params.tabId as number) < 0 ||
      (method !== "armFileChooserWait" && !identifier(params.waiterId))) throw new Error("Invalid file chooser wait parameters");
  if (method === "armFileChooserWait") fileChooserWaitTimeout({ timeoutMs: params.timeoutMs as number | undefined });
}
export function fileChooserWaitAck(value: unknown, timeout: number): { waiterId: string; remainingMs: number } {
  if (!object(value) || Object.keys(value).length !== 2 || !identifier(value.waiterId) || typeof value.remainingMs !== "number" ||
      !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > timeout) throw new Error("Invalid file chooser wait ready acknowledgement");
  return { waiterId: value.waiterId, remainingMs: value.remainingMs };
}
export function fileChooserWaitResult(value: unknown): OpenBrowserUseFileChooserWaitResult {
  if (!object(value) || Object.keys(value).length !== 2 || !identifier(value.fileChooserId) || typeof value.isMultiple !== "boolean") throw new Error("Invalid file chooser wait result");
  return { fileChooserId: value.fileChooserId, isMultiple: value.isMultiple };
}
export function fileChooserWaitCancelled(value: unknown): void {
  if (!object(value) || Object.keys(value).length) throw new Error("Invalid file chooser wait cancellation acknowledgement");
}
export function assertFileChooserWaitDeadline(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new Error("Open Browser Use file chooser wait timed out; request was not sent");
  return remaining;
}

/** Ready before the triggering click. The original wait deadline never renews. */
export class OpenBrowserUseFileChooserWait {
  readonly waiterId: string;
  readonly remainingMs: number;
  #deadline: number;
  #collecting = false;
  #call: (method: string, timeoutMs: number, startBefore?: number) => Promise<unknown>;
  constructor(ack: { waiterId: string; remainingMs: number }, deadline: number,
      call: (method: string, timeoutMs: number, startBefore?: number) => Promise<unknown>) {
    this.waiterId = ack.waiterId; this.remainingMs = ack.remainingMs; this.#deadline = deadline; this.#call = call;
  }
  async result(): Promise<OpenBrowserUseFileChooserWaitResult> {
    if (this.#collecting) throw new Error("OBU_FILE_CHOOSER_WAIT_CONFLICT: result is already pending");
    this.#collecting = true;
    try {
      const remaining = assertFileChooserWaitDeadline(this.#deadline);
      return fileChooserWaitResult(await this.#call("collectFileChooserWait", remaining + 1000, this.#deadline));
    } finally { this.#collecting = false; }
  }
  async cancel(): Promise<void> {
    // Cleanup remains possible after expiry, without extending the wait.
    fileChooserWaitCancelled(await this.#call("cancelFileChooserWait", 10000));
  }
}
