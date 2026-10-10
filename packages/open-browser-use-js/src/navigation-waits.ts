export type OpenBrowserUseNavigationWaitOptions = { timeoutMs?: number };
export type OpenBrowserUseURLWaitOptions = OpenBrowserUseNavigationWaitOptions & { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" };
export type OpenBrowserUseLoadStateWaitOptions = OpenBrowserUseNavigationWaitOptions & { state?: "load" | "domcontentloaded" | "networkidle" };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function navigationWaitParams(event: "url" | "loadstate", url: string | undefined, options: OpenBrowserUseURLWaitOptions | OpenBrowserUseLoadStateWaitOptions): Record<string, string | number> {
  const allowed = event === "url" ? ["timeoutMs", "waitUntil"] : ["timeoutMs", "state"];
  if (!object(options) || Object.keys(options).some(key => !allowed.includes(key))) throw new Error("Invalid navigation wait options");
  const timeoutMs = navigationWaitTimeout({ timeoutMs: options.timeoutMs });
  if (event === "url") {
    const waitUntil = (options as OpenBrowserUseURLWaitOptions).waitUntil === undefined ? "load" : (options as OpenBrowserUseURLWaitOptions).waitUntil!;
    if (typeof url !== "string" || !url || Buffer.byteLength(url, "utf8") > 4096 || !["load", "domcontentloaded", "networkidle", "commit"].includes(waitUntil)) throw new Error("Invalid navigation URL or waitUntil");
    return { event, url, waitUntil, timeoutMs };
  }
  const state = (options as OpenBrowserUseLoadStateWaitOptions).state === undefined ? "load" : (options as OpenBrowserUseLoadStateWaitOptions).state!;
  if (!["load", "domcontentloaded", "networkidle"].includes(state)) throw new Error("Invalid navigation load state");
  return { event, state, timeoutMs };
}
export function navigationWaitTimeout(options: OpenBrowserUseNavigationWaitOptions = {}, fallback = 10000): number {
  if (!object(options) || Object.keys(options).some(key => key !== "timeoutMs")) throw new Error("Navigation wait options only accept timeoutMs");
  const timeout = options.timeoutMs === undefined ? fallback : options.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error("Navigation wait timeoutMs must be an integer from 1 to 120000");
  return timeout;
}
export function navigationWaitAck(value: unknown, timeout: number): { waiterId: string; remainingMs: number } {
  if (!object(value) || Object.keys(value).length !== 2 || typeof value.waiterId !== "string" || !value.waiterId || Buffer.byteLength(value.waiterId, "utf8") > 128 || typeof value.remainingMs !== "number" || !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > timeout) throw new Error("Invalid navigation wait ready acknowledgement");
  return { waiterId: value.waiterId, remainingMs: value.remainingMs };
}
/** A ready navigation observer. Trigger the page action before calling result(). */
export class OpenBrowserUseNavigationWait {
  readonly waiterId: string;
  readonly remainingMs: number;
  #call: (method: string, timeoutMs: number) => Promise<unknown>;
  constructor(ack: { waiterId: string; remainingMs: number }, call: (method: string, timeoutMs: number) => Promise<unknown>) {
    this.waiterId = ack.waiterId; this.remainingMs = ack.remainingMs; this.#call = call;
  }
  async result(options: OpenBrowserUseNavigationWaitOptions = {}): Promise<void> {
    this.#empty(await this.#call("collectNavigationWait", navigationWaitTimeout(options, 120000) + 1000));
  }
  async cancel(options: OpenBrowserUseNavigationWaitOptions = {}): Promise<void> {
    this.#empty(await this.#call("cancelNavigationWait", navigationWaitTimeout(options) + 1000));
  }
  #empty(value: unknown): void { if (!object(value) || Object.keys(value).length) throw new Error("Invalid navigation wait acknowledgement"); }
}
