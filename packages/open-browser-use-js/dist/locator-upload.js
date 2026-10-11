export function locatorUploadParams(params) {
    const args = params.args;
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "files"))
        throw new Error("setInputFiles requires only args.files");
    const files = args.files;
    if (!Array.isArray(files) || files.length > 1024)
        throw new Error("setInputFiles files must be an array of at most 1024 absolute paths");
    let total = 0;
    for (const path of files) {
        if (typeof path !== "string" || !path || path.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path) ||
            !(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path)))
            throw new Error("setInputFiles requires nonempty absolute UTF-8 paths without NUL");
        const bytes = Buffer.byteLength(path, "utf8");
        total += bytes;
        if (bytes > 131072 || total > 8 * 1024 * 1024)
            throw new Error("setInputFiles path byte limit exceeded");
    }
    const timeout = Object.hasOwn(params, "timeoutMs") ? params.timeoutMs : 10000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
        throw new Error("setInputFiles timeoutMs must be an integer from 1 to 120000");
}
export function requireLocatorUpload(result) {
    const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
    const engine = object(result) ? result.engine : undefined;
    if (!object(result) || !("value" in result) || !object(engine) || engine.name !== "playwright-crx" || typeof engine.version !== "string" ||
        typeof engine.playwrightVersion !== "string" || !object(engine.capabilities) || engine.capabilities.locatorFileUpload !== 1) {
        throw new Error("OBU_LOCATOR_FILE_UPLOAD_UNSUPPORTED: extension does not advertise engine.capabilities.locatorFileUpload 1");
    }
}
