// The backend fixtures execute the readable worker in a VM with fake Chrome
// APIs. Keep its ownership and network registries real and share its clock.
import vm from "node:vm";
import { BrowserNetworkWaits } from "../browser-network-waits.js";
import { BrowserNavigationWaits } from "../browser-navigation-waits.js";
import { BrowserDownloads, downloadDeadline } from "../browser-downloads.js";
import { BROWSER_ENGINE_INFO, validateBrowserAction } from "../browser-action-engine.js";
import { AuxiliaryTabOwnership } from "../auxiliary-tab-ownership.js";

const sessionValuesByChrome = new WeakMap();
function extendLegacyFixture(chrome) {
  if (!chrome || typeof chrome !== "object") return;
  // Mutate the original fake so worker-restart fixtures keep the same session
  // store. Existing API members (including intentional failures) remain intact.
  if (!("storage" in chrome)) chrome.storage = {};
  if (chrome.storage && typeof chrome.storage === "object") {
    if (!("session" in chrome.storage)) chrome.storage.session = {};
    const session = chrome.storage.session;
    if (session && typeof session === "object") {
      let values = sessionValuesByChrome.get(chrome);
      if (!values) sessionValuesByChrome.set(chrome, values = new Map());
      if (!("get" in session)) session.get = async keys => {
        if (keys == null) return Object.fromEntries([...values].map(([key, value]) => [key, structuredClone(value)]));
        const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const result = {};
        for (const key of names) {
          if (values.has(key)) result[key] = structuredClone(values.get(key));
          else if (typeof keys === "object" && !Array.isArray(keys)) result[key] = structuredClone(keys[key]);
        }
        return result;
      };
      if (!("set" in session)) session.set = async items => {
        const copied = structuredClone(items);
        for (const [key, value] of Object.entries(copied)) values.set(key, value);
      };
      if (!("setAccessLevel" in session)) session.setAccessLevel = async () => {};
    }
  }
  if (!("windows" in chrome)) chrome.windows = {};
  if (chrome.windows && typeof chrome.windows === "object" && !("get" in chrome.windows)) {
    chrome.windows.get = async id => ({ id, type: "normal" });
  }
}

const source = code => code
  .replace('import { BrowserNetworkWaits } from "./browser-network-waits.js";', "")
  .replace('import { BrowserNavigationWaits } from "./browser-navigation-waits.js";', "")
  .replace('import { BrowserDownloads, downloadDeadline } from "./browser-downloads.js";', "")
  .replace('import { BROWSER_ENGINE_INFO, validateBrowserAction } from "./browser-action-engine.js";', "")
  .replace('import { AuxiliaryTabOwnership } from "./auxiliary-tab-ownership.js";', "");
const globals = sandbox => {
  extendLegacyFixture(sandbox?.chrome);
  return { BrowserNetworkWaits, BrowserNavigationWaits, BrowserDownloads, downloadDeadline, BROWSER_ENGINE_INFO, validateBrowserAction, performance, ...sandbox, AuxiliaryTabOwnership };
};

export default {
  createContext(sandbox, ...options) { return vm.createContext(globals(sandbox), ...options); },
  runInNewContext(code, sandbox, ...options) { return vm.runInNewContext(source(code), globals(sandbox), ...options); },
  runInContext(code, context, ...options) { return vm.runInContext(source(code), context, ...options); }
};
