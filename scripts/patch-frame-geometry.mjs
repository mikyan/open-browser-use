import { createFrameGeometryRuntime } from '../apps/chrome-extension/browser-frame-geometry.js';
export { createFrameGeometryRuntime };

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`CRX frame geometry patch: expected one ${label}`);
  return source.replace(before, after);
}

export function patchCrxFrameGeometry(source) {
  source = replaceOnce(source, "let ElementHandle$1 = class ElementHandle extends JSHandle$1 {",
    `const obuFrameGeometry = (${createFrameGeometryRuntime.toString()})();\nlet ElementHandle$1 = class ElementHandle extends JSHandle$1 {`, "element handle class");
  const clickableStart = source.indexOf("  async _clickablePoint() {");
  const offsetEnd = source.indexOf("  async _retryAction(", clickableStart);
  if (clickableStart < 0 || offsetEnd < 0) throw new Error("CRX frame geometry patch: point methods absent");
  source = source.slice(0, clickableStart) + `  async _clickablePoint(progress) { return obuFrameGeometry.clickable(this, progress); }
  async _offsetPoint(offset, progress) { return obuFrameGeometry.offset(this, offset, progress); }
` + source.slice(offsetEnd);
  const hitStart = source.indexOf("  async _checkFrameIsHitTarget(point) {");
  const hitEnd = source.indexOf("\n};\nfunction throwRetargetableDOMError", hitStart);
  if (hitStart < 0 || hitEnd < 0) throw new Error("CRX frame geometry patch: frame hit method absent");
  source = source.slice(0, hitStart) + `  async _checkFrameIsHitTarget(point, progress, position) { return obuFrameGeometry.hit(this, point, progress, position); }` + source.slice(hitEnd);
  source = replaceOnce(source, "const maybePoint = position ? await this._offsetPoint(position) : await this._clickablePoint();",
    "const maybePoint = position ? await this._offsetPoint(position, progress2) : await this._clickablePoint(progress2);", "point progress");
  source = replaceOnce(source, "const frameCheckResult = await this._checkFrameIsHitTarget(point);",
    "const frameCheckResult = await this._checkFrameIsHitTarget(point, progress2, position);", "frame hit progress");
  source = replaceOnce(source, "  async boundingBox() {\n    return this._page.delegate.getBoundingBox(this);\n  }",
    "  async boundingBox(progress) {\n    return progress ? obuFrameGeometry.bounding(this, progress) : this._page.delegate.getBoundingBox(this);\n  }", "server bounding box");
  source = replaceOnce(source, "      const boundingBox = await handle.boundingBox();",
    "      const boundingBox = await handle.boundingBox(progress2);", "element screenshot progress");
  source = replaceOnce(source, "scheme.ElementHandleBoundingBoxParams = tOptional(tObject({}));",
    "scheme.ElementHandleBoundingBoxParams = tOptional(tObject({ timeout: tOptional(tNumber) }));", "bounding box private timeout schema");
  source = replaceOnce(source, "  async boundingBox(params, metadata) {\n    const value = await this._elementHandle.boundingBox();\n    return { value: value || void 0 };\n  }",
    "  async boundingBox(params, metadata) {\n    const controller = new ProgressController(metadata, this._elementHandle);\n    const value = await controller.run(progress => this._elementHandle.boundingBox(progress), params?.timeout);\n    return { value: value || void 0 };\n  }", "bounding box dispatcher progress");
  source = replaceOnce(source, "  async boundingBox() {\n    const value = (await this._elementChannel.boundingBox()).value;\n    return value === void 0 ? null : value;\n  }",
    "  async boundingBox(options2 = {}) {\n    const value = (await this._elementChannel.boundingBox({ timeout: this._frame._timeout(options2) })).value;\n    return value === void 0 ? null : value;\n  }", "client bounding box timeout");
  return replaceOnce(source, '  async boundingBox(options2) {\n    return await this._withElement((h) => h.boundingBox(), { title: "Bounding box", timeout: options2 == null ? void 0 : options2.timeout });\n  }',
    '  async boundingBox(options2) {\n    const timeout = this._frame._timeout(options2);\n    return await this._withElement((h, remaining) => {\n      if (timeout && remaining <= 0) throw new TimeoutError2(`Timeout ${timeout}ms exceeded.`);\n      return h.boundingBox({ timeout: remaining });\n    }, { title: "Bounding box", timeout });\n  }', "locator bounding box remaining timeout");
}
