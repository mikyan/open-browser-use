export type OpenBrowserUseNetworkWaitEvent = "request" | "response";
export type OpenBrowserUseNetworkWaitMatch = {
  url: string; urlMatch?: "exact" | "contains"; method?: string; status?: number;
};
export type OpenBrowserUseNetworkWaitOptions = { timeoutMs?: number };
export type OpenBrowserUseNetworkWaitResult = {
  event: OpenBrowserUseNetworkWaitEvent; requestId: string; url: string; method: string; resourceType: string;
  frameUrl?: string; redirectedFrom?: string; status?: number; statusText?: string; truncated?: boolean;
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, limit: number, empty = false): value is string => typeof value === "string" && (empty || value.length > 0) && Buffer.byteLength(value, "utf8") <= limit;
export function networkWaitTimeout(options: OpenBrowserUseNetworkWaitOptions = {}, fallback = 10_000): number {
  if (!object(options) || Object.keys(options).some(key => key !== "timeoutMs")) throw new Error("Network wait options only accept timeoutMs");
  const timeout = options.timeoutMs === undefined ? fallback : options.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error("Network wait timeoutMs must be an integer from 1 to 120000");
  return timeout;
}
export function networkWaitMatch(event: OpenBrowserUseNetworkWaitEvent, match: OpenBrowserUseNetworkWaitMatch): OpenBrowserUseNetworkWaitMatch {
  if (!object(match) || Object.keys(match).some(key => !["url", "urlMatch", "method", "status"].includes(key)) ||
      !string(match.url, 4096) || (match.urlMatch !== undefined && !["exact", "contains"].includes(match.urlMatch)) ||
      (match.method !== undefined && !string(match.method, 128)) ||
      (match.status !== undefined && (event !== "response" || !Number.isInteger(match.status) || match.status < 100 || match.status > 599)))
    throw new Error("Invalid network wait match");
  return { ...match };
}
export function networkWaitAck(value: unknown, timeout: number): { waiterId: string; remainingMs: number } {
  if (!object(value) || Object.keys(value).some(key => !["waiterId", "remainingMs"].includes(key)) || !string(value.waiterId, 128) ||
      typeof value.remainingMs !== "number" || !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > timeout)
    throw new Error("Invalid network wait ready acknowledgement");
  return { waiterId: value.waiterId, remainingMs: value.remainingMs };
}
export function networkWaitResult(value: unknown, event: OpenBrowserUseNetworkWaitEvent): OpenBrowserUseNetworkWaitResult {
  if (!object(value) || Object.keys(value).some(key => !["event", "requestId", "url", "method", "resourceType", "frameUrl", "redirectedFrom", "status", "statusText", "truncated"].includes(key)) ||
      value.event !== event || !string(value.requestId, 128) || !string(value.url, 4096) || !string(value.method, 128) || !string(value.resourceType, 128) ||
      (value.frameUrl !== undefined && !string(value.frameUrl, 4096, true)) ||
      (value.redirectedFrom !== undefined && !string(value.redirectedFrom, 128)) ||
      (value.statusText !== undefined && !string(value.statusText, 1024, true)) ||
      (value.truncated !== undefined && typeof value.truncated !== "boolean") ||
      (event === "response" ? !Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599 : value.status !== undefined || value.statusText !== undefined) ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > 16384) throw new Error("Invalid network wait result");
  return value as OpenBrowserUseNetworkWaitResult;
}

/** An armed wait. Trigger the page action before calling result(). */
export class OpenBrowserUseNetworkWait {
  readonly waiterId: string;
  readonly remainingMs: number;
  #event: OpenBrowserUseNetworkWaitEvent;
  #call: (method: string, timeoutMs: number) => Promise<unknown>;
  constructor(ack: { waiterId: string; remainingMs: number }, event: OpenBrowserUseNetworkWaitEvent,
      call: (method: string, timeoutMs: number) => Promise<unknown>) {
    this.waiterId = ack.waiterId; this.remainingMs = ack.remainingMs;
    this.#event = event; this.#call = call;
  }
  async result(options: OpenBrowserUseNetworkWaitOptions = {}): Promise<OpenBrowserUseNetworkWaitResult> {
    const timeout = networkWaitTimeout(options, 120_000);
    return networkWaitResult(await this.#call("collectNetworkWait", timeout + 1000), this.#event);
  }
  async cancel(options: OpenBrowserUseNetworkWaitOptions = {}): Promise<void> {
    const value = await this.#call("cancelNetworkWait", networkWaitTimeout(options) + 1000);
    if (!object(value) || Object.keys(value).length) throw new Error("Invalid network wait cancellation acknowledgement");
  }
}
