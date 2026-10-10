import type { BrowserUseRequestParams, JsonValue } from "./index.js";
export type OpenBrowserUseExportFormat = "pdf" | "mhtml";
export type OpenBrowserUsePDFOptions = {
    landscape?: boolean;
    printBackground?: boolean;
    scale?: number;
    paperWidth?: number;
    paperHeight?: number;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    pageRanges?: string;
    preferCSSPageSize?: boolean;
    generateTaggedPDF?: boolean;
    generateDocumentOutline?: boolean;
};
export type OpenBrowserUseExportOptions = {
    maxBytes?: number;
    timeoutMs?: number;
    pdf?: OpenBrowserUsePDFOptions;
};
export type OpenBrowserUsePageExport = {
    format: OpenBrowserUseExportFormat;
    mimeType: "application/pdf" | "multipart/related";
    encoding: "base64";
    data: string;
    byteLength: number;
};
export declare const MAX_PAGE_EXPORT_BYTES: number;
export declare function pageExportParams(format: OpenBrowserUseExportFormat, options?: OpenBrowserUseExportOptions): BrowserUseRequestParams;
export declare function validatePageExport(value: JsonValue, format: OpenBrowserUseExportFormat, maxBytes: number): OpenBrowserUsePageExport;
