// The backend fixtures execute the readable worker in a VM with fake Chrome
// APIs. Keep its ownership and network registries real and share its clock.
import vm from "node:vm";
import { PassivePointerReads } from "../browser-pointer-feedback.js";
import { createNativePointerRoute } from "../browser-native-pointer-route.js";
import { NATIVE_POINTER_KERNEL_ABI } from "../browser-native-pointer-feedback.js";
import { PointerRealmIdentity } from "../browser-pointer-realm.js";
import { PrivateTargetRegistry } from "../browser-private-targets.js";
import { PrivateTargetStore } from "../browser-private-target-store.js";
import { VisualDeliveries } from "../browser-visual-deliveries.js";
import { BrowserNetworkWaits } from "../browser-network-waits.js";
import { BrowserDialogs } from "../browser-dialogs.js";
import { BrowserLifetime } from "../browser-lifetime.js";
import { BrowserNavigationWaits } from "../browser-navigation-waits.js";
import { BrowserFileChooserWaits } from "../browser-file-chooser-waits.js";
import { DirectoryUploadRegistry } from "../browser-directory-upload.js";
import { BrowserPageWaits } from "../browser-page-waits.js";
import { BrowserDownloadWaits } from "../browser-download-waits.js";
import { BrowserDownloads, downloadDeadline } from "../browser-downloads.js";
import { validateMediaDownload, MEDIA_CANCEL_FUNCTION } from "../browser-media-source.js";
import { MediaContextLifetimes } from "../browser-media-lifetime.js";
import { BrowserPageExports } from "../browser-page-exports.js";
import { BrowserClipboard } from "../browser-clipboard.js";
import { BrowserClipboardBroker } from "../clipboard-broker.js";
import { BROWSER_ENGINE_INFO, validateBrowserAction } from "../browser-action-engine.js";
import { AuxiliaryTabOwnership } from "../auxiliary-tab-ownership.js";
import { NativeMessageReceiver } from "../native-message-receiver.js";
import { NativePageDownloads } from "../native-page-downloads.js";
import { SiteAccessPolicy, normalizeSiteAccessPolicy } from "../site-access-policy.js";
import { assertSiteAccessFrames } from "../site-access-frames.js";
import managedConfig from "../managed-config.js";
import { resolveManagedNativeHost } from "../managed-native-host.js";
import { BrowserRendering } from "../browser-rendering.js";
import { installManagedUserBridge } from "../managed-user-bridge.js";

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
  .replace('import { installManagedUserBridge } from "./managed-user-bridge.js";', "")
  .replace('import { BrowserRendering } from "./browser-rendering.js";', "")
  .replace('import managedConfig from "./managed-config.js";', "")
  .replace('import { resolveManagedNativeHost } from "./managed-native-host.js";', "")
  .replace('import { VisualDeliveries } from "./browser-visual-deliveries.js";', "")
  .replace('import { PassivePointerReads } from "./browser-pointer-feedback.js";', "")
  .replace('import { createNativePointerRoute } from "./browser-native-pointer-route.js";', "")
  .replace('import { NATIVE_POINTER_KERNEL_ABI } from "./browser-native-pointer-feedback.js";', "")
  .replace('import { PointerRealmIdentity } from "./browser-pointer-realm.js";', "")
  .replace('import { PrivateTargetRegistry } from "./browser-private-targets.js";', "")
  .replace('import { PrivateTargetStore } from "./browser-private-target-store.js";', "")
  .replace('import { BrowserDialogs } from "./browser-dialogs.js";', "")
  .replace('import { BrowserPageWaits } from "./browser-page-waits.js";', "")
  .replace('import { NativePageDownloads } from "./native-page-downloads.js";', "")
  .replace('import { BrowserLifetime } from "./browser-lifetime.js";', "")
  .replace('import { BrowserClipboard } from "./browser-clipboard.js";', "")
  .replace('import { BrowserClipboardBroker } from "./clipboard-broker.js";', "")
  .replace('import { SiteAccessPolicy, normalizeSiteAccessPolicy } from "./site-access-policy.js";', "")
  .replace('import { assertSiteAccessFrames } from "./site-access-frames.js";', "")
  .replace('import { NativeMessageReceiver } from "./native-message-receiver.js";', "")
  .replace('import { BrowserNetworkWaits } from "./browser-network-waits.js";', "")
  .replace('import { BrowserNavigationWaits } from "./browser-navigation-waits.js";', "")
  .replace('import { BrowserFileChooserWaits } from "./browser-file-chooser-waits.js";', "")
  .replace('import { DirectoryUploadRegistry } from "./browser-directory-upload.js";', "")
  .replace('import { BrowserDownloadWaits } from "./browser-download-waits.js";', "")
  .replace('import { BrowserDownloads, downloadDeadline } from "./browser-downloads.js";', "")
  .replace('import { validateMediaDownload, MEDIA_CANCEL_FUNCTION } from "./browser-media-source.js";', "")
  .replace('import { MediaContextLifetimes } from "./browser-media-lifetime.js";', "")
  .replace('import { BrowserPageExports } from "./browser-page-exports.js";', "")
  .replace('import { BROWSER_ENGINE_INFO, validateBrowserAction } from "./browser-action-engine.js";', "")
  .replace('import { AuxiliaryTabOwnership } from "./auxiliary-tab-ownership.js";', "");
const globals = sandbox => {
  extendLegacyFixture(sandbox?.chrome);
  return { BrowserRendering, installManagedUserBridge, NATIVE_POINTER_KERNEL_ABI, PointerRealmIdentity, VisualDeliveries, PassivePointerReads, createNativePointerRoute, PrivateTargetRegistry, PrivateTargetStore, crypto: globalThis.crypto, TextEncoder, BrowserLifetime, structuredClone, BrowserNetworkWaits, BrowserDialogs, BrowserNavigationWaits, BrowserFileChooserWaits, DirectoryUploadRegistry, BrowserDownloadWaits, BrowserPageWaits, BrowserDownloads, validateMediaDownload, MEDIA_CANCEL_FUNCTION, MediaContextLifetimes, BrowserPageExports, BrowserClipboard, BrowserClipboardBroker, downloadDeadline, BROWSER_ENGINE_INFO, validateBrowserAction, performance, NativeMessageReceiver, NativePageDownloads, SiteAccessPolicy, normalizeSiteAccessPolicy, assertSiteAccessFrames, managedConfig, resolveManagedNativeHost, ...sandbox, AuxiliaryTabOwnership };
};

export default {
  createContext(sandbox, ...options) { return vm.createContext(globals(sandbox), ...options); },
  runInNewContext(code, sandbox, ...options) { return vm.runInNewContext(source(code), globals(sandbox), ...options); },
  runInContext(code, context, ...options) { return vm.runInContext(source(code), context, ...options); }
};
