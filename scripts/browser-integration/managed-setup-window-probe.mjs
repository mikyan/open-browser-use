import assert from "node:assert/strict";

// Read-only subset of rendering-probe.mjs. No titles, foreground polling,
// focus/restore calls, or computer input. The original PID is supplied in env.
export const setupWindowProbe = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SetupWindowReadOnly {
 public delegate bool Callback(IntPtr window, IntPtr context);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr context);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int bytes);
 public static object[] ForProcess(uint desired) {
  var result = new List<object>();
  if (desired == 0) throw new ArgumentException("Original browser PID is required");
  if (!EnumWindows((window, unused) => {
   uint processId; GetWindowThreadProcessId(window, out processId);
   if (processId == desired) {
    Rect rect; bool hasRect = GetWindowRect(window, out rect);
    int cloaked; int dwmResult = DwmGetWindowAttribute(window, 14, out cloaked, 4);
    result.Add(new { handle = window.ToInt64().ToString(), processId, visible = IsWindowVisible(window), iconic = IsIconic(window), cloaked, dwmResult, hasRect, rect });
   }
   return true;
  }, IntPtr.Zero)) throw new InvalidOperationException("EnumWindows failed");
  return result.ToArray();
 }
}
'@
$originalBrowser = [uint32]$env:OBU_SETUP_OBSERVER_PID
[pscustomobject]@{ at = [DateTime]::UtcNow.ToString('o'); processId = $originalBrowser; windows = @([SetupWindowReadOnly]::ForProcess($originalBrowser)) } | ConvertTo-Json -Depth 6 -Compress
`;

export function assertVisibleSetupWindow(observation, browserPID) {
  assert.equal(observation.processId, browserPID); assert.ok(Number.isFinite(Date.parse(observation.at)));
  assert.ok(Array.isArray(observation.windows));
  assert.ok(observation.windows.every(value => value.processId === browserPID), "Window observation includes another process");
  const visible = observation.windows.filter(value => value.visible === true && value.iconic === false && value.dwmResult === 0 && value.cloaked === 0 && value.hasRect === true &&
    value.rect.Right > value.rect.Left && value.rect.Bottom > value.rect.Top);
  assert.ok(visible.length > 0, "Original setup browser has no observed visible, nonminimized, noncloaked window; no window was restored or focused");
  return { browserPID, at: observation.at, visibleHandles: visible.map(value => value.handle) };
}
