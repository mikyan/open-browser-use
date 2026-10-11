import type { OpenBrowserUseLocatorStep } from "./index.js";
export declare function copyLocatorSteps(steps: readonly OpenBrowserUseLocatorStep[], nested?: boolean): readonly OpenBrowserUseLocatorStep[];
export declare function relativeLocatorSteps(outer: readonly OpenBrowserUseLocatorStep[], inner: readonly OpenBrowserUseLocatorStep[], relative: boolean): readonly OpenBrowserUseLocatorStep[];
export declare function assertCombinedLocatorBudget(...chains: readonly (readonly OpenBrowserUseLocatorStep[])[]): void;
