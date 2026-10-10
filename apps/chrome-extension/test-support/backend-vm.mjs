// The backend fixtures execute the readable worker in a VM with fake Chrome
// APIs. Keep its network registry real and share its monotonic clock.
import vm from "node:vm";
import { BrowserNetworkWaits } from "../browser-network-waits.js";

const source = code => code.replace('import { BrowserNetworkWaits } from "./browser-network-waits.js";', "");
const globals = sandbox => ({ BrowserNetworkWaits, performance, ...sandbox });

export default {
  createContext(sandbox, ...options) { return vm.createContext(globals(sandbox), ...options); },
  runInNewContext(code, sandbox, ...options) { return vm.runInNewContext(source(code), globals(sandbox), ...options); },
  runInContext(code, context, ...options) { return vm.runInContext(source(code), context, ...options); }
};
