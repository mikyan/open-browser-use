import type { OpenBrowserUseTab } from "./index.js";
import type { JsonValue } from "./index.js";

export type OpenBrowserUsePageWaitOptions = { timeoutMs?: number };
export const pageWaitMethods = new Set(["armPageWait", "collectPageWait", "cancelPageWait"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 128;

export function pageWaitTimeout(options: OpenBrowserUsePageWaitOptions = {}): number {
  if (!object(options) || Object.keys(options).some(key => key !== "timeoutMs")) throw new Error("Page wait options only accept timeoutMs");
  const timeout = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error("Page wait timeoutMs must be an integer from 1 to 120000");
  return timeout;
}
export function pageWaitParams(method: string, params: Record<string, unknown>): void {
  const allowed = ["session_id", "turn_id", "control_epoch", "tabId", method === "armPageWait" ? "timeoutMs" : "waiterId"];
  if (!object(params) || Object.keys(params).some(key => !allowed.includes(key)) || !Number.isSafeInteger(params.tabId) || (params.tabId as number) < 0 ||
      (method !== "armPageWait" && !identifier(params.waiterId))) throw new Error("Invalid page wait parameters");
  for (const key of ["session_id", "turn_id"]) {
    const value = params[key];
    if (Object.hasOwn(params, key) && (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 4096)) throw new Error("Invalid page wait scope");
  }
  if (Object.hasOwn(params, "control_epoch") && (!Number.isSafeInteger(params.control_epoch) || (params.control_epoch as number) < 1)) throw new Error("Invalid page wait scope");
  if (method === "armPageWait") pageWaitTimeout({ timeoutMs: params.timeoutMs as number | undefined });
}
export function pageWaitAck(value: unknown, timeout: number): { waiterId: string; remainingMs: number } {
  if (!object(value) || Object.keys(value).length !== 2 || !identifier(value.waiterId) || typeof value.remainingMs !== "number" ||
      !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > timeout) throw new Error("Invalid page wait ready acknowledgement");
  return { waiterId: value.waiterId, remainingMs: value.remainingMs };
}
export function pageWaitCancelled(value: unknown): void {
  if (!object(value) || Object.keys(value).length) throw new Error("Invalid page wait cancellation acknowledgement");
}
export function assertPageWaitDeadline(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining < 1) throw new Error("Open Browser Use page wait timed out; request was not sent");
  return remaining;
}

/** Observes one native child. Cancelling this wait never closes that child. */
export class OpenBrowserUsePageWait {
  readonly waiterId: string;
  readonly remainingMs: number;
  #collecting = false;
  #finished = false;
  constructor(ack: { waiterId: string; remainingMs: number }, private readonly deadline: number,
      private readonly call: (method: string, timeoutMs: number, startBefore?: number) => Promise<JsonValue>,
      private readonly page: (id: number) => OpenBrowserUseTab) {
    this.waiterId = ack.waiterId; this.remainingMs = ack.remainingMs;
  }
  async result(): Promise<OpenBrowserUseTab> {
    if (this.#collecting) throw new Error("OBU_PAGE_WAIT_CONFLICT: result is already pending");
    if (this.#finished) throw new Error("OBU_PAGE_WAIT_INVALID: wait has already been consumed or cancelled");
    this.#collecting = true;
    try {
      const remaining = assertPageWaitDeadline(this.deadline);
      const id = pageWaitResult(await this.call("collectPageWait", remaining, this.deadline));
      assertPageWaitDeadline(this.deadline);
      this.#finished = true;
      return this.page(id);
    } finally { this.#collecting = false; }
  }
  async cancel(): Promise<void> {
    // Cleanup remains retryable after expiry, without extending the observation.
    pageWaitCancelled(await this.call("cancelPageWait", 10000));
    this.#finished = true;
  }
}

export function pageWaitResult(value: unknown): number {
  if (!object(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.tabId) || (value.tabId as number) < 0) throw new Error("Invalid page wait result");
  return value.tabId as number;
}
