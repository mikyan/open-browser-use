import type { BrowserUseRequestParams, JsonValue } from "./index.js";

export type OpenBrowserUseExportFormat = "pdf" | "mhtml";
export type OpenBrowserUsePDFOptions = {
  landscape?: boolean; printBackground?: boolean; scale?: number;
  paperWidth?: number; paperHeight?: number;
  marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number;
  pageRanges?: string; preferCSSPageSize?: boolean;
  generateTaggedPDF?: boolean; generateDocumentOutline?: boolean;
};
export type OpenBrowserUseExportOptions = { maxBytes?: number; timeoutMs?: number; pdf?: OpenBrowserUsePDFOptions };
export type OpenBrowserUsePageExport = {
  format: OpenBrowserUseExportFormat; mimeType: "application/pdf" | "multipart/related";
  encoding: "base64"; data: string; byteLength: number;
};
export const MAX_PAGE_EXPORT_BYTES = 16 * 1024 * 1024;
const booleans = new Set(["landscape", "printBackground", "preferCSSPageSize", "generateTaggedPDF", "generateDocumentOutline"]);
const numbers = new Set(["scale", "paperWidth", "paperHeight", "marginTop", "marginBottom", "marginLeft", "marginRight"]);
const mimeTypes = { pdf: "application/pdf", mhtml: "multipart/related" } as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pageExportParams(format: OpenBrowserUseExportFormat, options: OpenBrowserUseExportOptions = {}): BrowserUseRequestParams {
  if (format !== "pdf" && format !== "mhtml") throw new Error("Invalid page export format");
  if (!object(options) || Object.keys(options).some(key => !["maxBytes", "timeoutMs", "pdf"].includes(key))) throw new Error("Invalid page export options");
  const maxBytes = options.maxBytes === undefined ? MAX_PAGE_EXPORT_BYTES : options.maxBytes;
  const timeoutMs = options.timeoutMs === undefined ? 10_000 : options.timeoutMs;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_EXPORT_BYTES) throw new Error("Page export maxBytes must be an integer from 1 to 16777216");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Page export timeoutMs must be an integer from 1 to 120000");
  const params: BrowserUseRequestParams = { format, maxBytes, timeoutMs };
  if (Object.hasOwn(options, "pdf")) {
    if (format !== "pdf" || !object(options.pdf)) throw new Error("PDF options require format pdf and an object");
    const pdf: BrowserUseRequestParams = {};
    for (const [key, value] of Object.entries(options.pdf)) {
      if (booleans.has(key)) {
        if (typeof value !== "boolean") throw new Error(`Invalid PDF option: ${key}`);
      } else if (numbers.has(key)) {
        const min = key === "scale" ? 0.1 : 0, max = key === "scale" ? 2 : 200;
        if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (key.startsWith("paper") && value === 0)) throw new Error(`Invalid PDF option: ${key}`);
      } else if (key === "pageRanges") {
        if (typeof value !== "string" || value.length > 1024 || /[^0-9,\- ]/.test(value)) throw new Error("Invalid PDF pageRanges");
      } else throw new Error(`Invalid PDF option: ${key}`);
      pdf[key] = value as JsonValue;
    }
    params.pdf = pdf;
  }
  return params;
}

export function validatePageExport(value: JsonValue, format: OpenBrowserUseExportFormat, maxBytes: number): OpenBrowserUsePageExport {
  const invalid = () => new Error("Invalid exportPage result");
  if (!object(value) || Object.keys(value).length !== 5 || value.format !== format || value.mimeType !== mimeTypes[format] || value.encoding !== "base64" ||
      typeof value.data !== "string" || !Number.isInteger(value.byteLength) || (value.byteLength as number) < 1 || (value.byteLength as number) > maxBytes ||
      value.data.length > 4 * Math.ceil(maxBytes / 3) || value.data.length !== 4 * Math.ceil((value.byteLength as number) / 3)) throw invalid();
  // Buffer's base64 decoder is intentionally permissive; a canonical roundtrip
  // also rejects whitespace, URL-safe spelling and nonzero unused padding bits.
  const decoded = Buffer.from(value.data, "base64");
  if (decoded.length !== value.byteLength || decoded.toString("base64") !== value.data) throw invalid();
  return { format, mimeType: mimeTypes[format], encoding: "base64", data: value.data, byteLength: decoded.length };
}
