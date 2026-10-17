// Read-only, non-atomic CIM inventory evidence, never termination authority.
// ParentProcessId survives the parent's death and PID reuse. A child can only
// belong to the observed parent incarnation if it was created no earlier.
// Callers still check disappearance by the original PID + CreationDate pair.
function creationTime(row) {
  const value = row.CreationDate;
  // PowerShell emits ToUniversalTime().ToString('o'). Retain all seven digits;
  // Date.parse alone would truncate the ordering proof to milliseconds.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value)) {
    throw new Error("Process observation requires a UTC CreationDate with seven fractional digits");
  }
  const seconds = value.slice(0, 19), calendar = new Date(`${seconds}.000Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== seconds) {
    throw new Error("Process observation contains an invalid CreationDate");
  }
  return value; // Fixed-width UTC strings retain exact 100 ns ordering.
}

export function observedProcessDescendants(table, pid) {
  if (!Array.isArray(table) || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process observation root");
  const byPID = new Map(), children = new Map();
  for (const row of table) {
    if (!row || !Number.isSafeInteger(row.ProcessId) || !Number.isSafeInteger(row.ParentProcessId)) continue;
    if (!byPID.has(row.ProcessId)) byPID.set(row.ProcessId, []);
    byPID.get(row.ProcessId).push(row);
    if (!children.has(row.ParentProcessId)) children.set(row.ParentProcessId, []);
    children.get(row.ParentProcessId).push(row);
  }
  const roots = byPID.get(pid) ?? [];
  if (roots.length !== 1) throw new Error(roots.length ? "Ambiguous process observation root" : "Process observation root is missing");
  const root = roots[0], selected = new Set([root]), visited = new Set([pid]);
  const pending = [{ row: root, created: creationTime(root) }];
  for (let index = 0; index < pending.length; index++) {
    const parent = pending[index];
    for (const child of children.get(parent.row.ProcessId) ?? []) {
      if (visited.has(child.ProcessId)) continue;
      if (byPID.get(child.ProcessId).length !== 1) throw new Error("Ambiguous descendant process observation");
      const created = creationTime(child);
      if (created < parent.created) continue; // Break this old edge and its entire subtree.
      visited.add(child.ProcessId); selected.add(child); pending.push({ row: child, created });
    }
  }
  return table.filter(row => selected.has(row));
}
