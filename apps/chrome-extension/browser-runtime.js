// MV3 service workers forbid dynamic import(). Keep the engine dependency graph
// static while leaving its dispatcher injectable for protocol/lifecycle tests.
import * as runtime from "./vendor/playwright-crx/index.mjs";
import { BrowserActionEngine } from "./browser-action-engine.js";
import * as aiSnapshot from "./browser-ai-snapshot.js";
import { readMediaSource } from "./browser-media-source.js";

export function createBrowserActionEngine(hooks) {
  return new BrowserActionEngine({ ...hooks, loadRuntime: async () => ({ ...runtime, ...aiSnapshot, readMediaSource }) });
}
