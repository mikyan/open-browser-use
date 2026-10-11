import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const limits = Object.freeze({ lineBytes: 1024 * 1024, stdoutBytes: 4 * 1024 * 1024, stderrBytes: 64 * 1024 });
const hookBudgets = Object.freeze({ start: 4000, failure: 3500, finish: 2000 });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const errorText = error => String(error?.message ?? error).slice(0, 4096);
const sameItem = (a, b) => a.key === b.key && a.variant === b.variant && a.tabId === b.tabId;

// Only the explicit diagnostic caller uses this protocol. Ordinary Go callers
// keep their original stdout, stdin, requests, and browser deadlines.
export async function runChooserProcess(command, args, { onHook, env, timeoutMs = 120000 } = {}) {
  if (typeof onHook !== "function") throw new TypeError("Chooser process requires onHook");
  if (env?.OBU_GO_CHOOSER_DIAGNOSTIC !== "1") throw new Error("Chooser process requires OBU_GO_CHOOSER_DIAGNOSTIC=1");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid chooser process deadline");
  const startedAt = Date.now(), started = performance.now(), deadline = started + timeoutMs;
  const report = { result: null, process: { pid: null, startedAt, timeoutMs, exitCode: null, signal: null,
    exitObserved: false, closeObserved: false, terminationRequests: [], stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0,
    stdoutTruncated: false, stderrTruncated: false, limits }, protocolComplete: false, errors: [], hooks: [] };
  let child, closed = false, stopping = false, fatal = false, active = null, pendingHook = null, runningHook = null;
  let expectedId = 1, resultSeen = false, lineBytes = 0, stdoutRetained = 0, stderrRetained = 0;
  let totalTimer, forceTimer;
  const lineParts = [], stdout = [], stderr = [], seenKeys = new Set(), seenTabs = new Set(), seenVariants = new Set();
  const addError = (kind, error, extra = {}) => report.errors.push({ kind, error: errorText(error), at: Date.now(), ...extra });
  const stop = reason => {
    if (stopping || closed) return;
    stopping = true;
    pendingHook?.abort(new Error(reason));
    child?.stdin.destroy();
    const kill = signal => {
      if (closed) return;
      const record = { signal, requestedAt: Date.now(), reason }; report.process.terminationRequests.push(record);
      try { record.sent = child.kill(signal); } catch (error) { record.error = errorText(error); addError("termination", error); }
    };
    kill("SIGTERM");
    // A successful kill() only acknowledges sending a signal. The result is
    // returned after close (including pipe drain), never after kill or exit.
    forceTimer = setTimeout(() => kill("SIGKILL"), 1000);
  };
  const protocolError = message => {
    if (fatal) return;
    fatal = true; addError("protocol", message); stop(message);
  };
  const sendAck = (record, ok, error) => {
    if (!closed && !stopping && performance.now() >= deadline) {
      addError("timeout", "Chooser process exceeded total deadline"); stop("Chooser process exceeded total deadline");
    }
    if (closed || stopping || child.stdin.destroyed) { record.ackSkipped = true; return; }
    const ack = { type: "ack", version: 1, id: record.id, ok, ...(!ok ? { error: errorText(error) } : {}) };
    record.ack = ack; record.ackSubmittedAt = Date.now();
    try {
      child.stdin.write(JSON.stringify(ack) + "\n", writeError => {
        if (writeError) { record.ackError = errorText(writeError); if (!closed) protocolError(`Cannot write chooser ACK: ${errorText(writeError)}`); }
        else record.ackWrittenAt = Date.now();
      });
    } catch (writeError) { record.ackError = errorText(writeError); protocolError(`Cannot write chooser ACK: ${errorText(writeError)}`); }
  };
  const executeHook = async message => {
    const controller = new AbortController(), budgetMs = hookBudgets[message.kind];
    const began = performance.now(), expires = Math.min(deadline, began + budgetMs);
    const record = { ...message, receivedAt: Date.now(), budgetMs, deadlineAt: Date.now() + Math.max(0, expires - began) };
    report.hooks.push(record); pendingHook = controller;
    let timer, abortListener, failure;
    try {
      if (expires <= began) throw new Error("Chooser process deadline expired before hook");
      await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted || performance.now() >= expires) throw new Error("Chooser hook deadline expired before invocation");
          return onHook(message, { signal: controller.signal, budgetMs, deadlineAt: record.deadlineAt });
        }),
        new Promise((_, reject) => {
          abortListener = () => reject(controller.signal.reason ?? new Error("Chooser hook aborted"));
          controller.signal.addEventListener("abort", abortListener, { once: true });
          const expire = () => {
            const remaining = expires - performance.now();
            if (remaining > 0) { timer = setTimeout(expire, remaining); return; }
            controller.abort(new Error(`Chooser ${message.kind} hook exceeded ${budgetMs}ms budget`));
          };
          timer = setTimeout(expire, Math.max(0, expires - performance.now()));
        })
      ]);
      if (controller.signal.aborted || performance.now() >= expires) throw new Error(`Chooser ${message.kind} hook settled after its deadline`);
      record.status = "fulfilled";
    } catch (error) {
      failure = error; record.status = "rejected"; record.error = errorText(error);
      addError("hook", error, { id: message.id, hook: message.kind });
    } finally {
      clearTimeout(timer); if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      record.completedAt = Date.now();
      if (pendingHook === controller) pendingHook = null;
    }
    sendAck(record, !failure, failure);
  };
  const accept = message => {
    if (fatal || stopping || closed) return;
    if (resultSeen) return protocolError("Output after the unique chooser result");
    if (pendingHook) return protocolError("Chooser sent another message before the previous hook ACK");
    if (message?.type === "result") {
      if (!exact(message, ["type", "version", "result"]) || message.version !== 1 || !object(message.result)) return protocolError("Invalid chooser result envelope");
      if (active) return protocolError("Chooser result arrived before variant finish");
      resultSeen = true; report.result = message.result;
      // No more requests follow a result. EOF also lets a correct child drain
      // its stdin reader without a process.exit() that could truncate stdout.
      child.stdin.end();
      return;
    }
    if (!exact(message, ["type", "version", "id", "kind", "item"]) || message.type !== "hook" || message.version !== 1 ||
        !Number.isSafeInteger(message.id) || message.id !== expectedId || !Object.hasOwn(hookBudgets, message.kind) ||
        !exact(message.item, ["key", "variant", "tabId"]) || typeof message.item.key !== "string" || !message.item.key ||
        !["root", "oopif", "dynamic-oopif"].includes(message.item.variant) || !Number.isSafeInteger(message.item.tabId) || message.item.tabId < 0)
      return protocolError("Invalid chooser hook envelope, identity or sequence");
    const item = message.item;
    if (message.kind === "start") {
      if (active || seenKeys.has(item.key) || seenTabs.has(item.tabId) || seenVariants.has(item.variant)) return protocolError("Overlapping or repeated chooser variant");
      seenKeys.add(item.key); seenTabs.add(item.tabId); seenVariants.add(item.variant);
      active = { ...item, failed: false };
    } else {
      if (!active || !sameItem(active, item)) return protocolError("Chooser hook does not match the active variant");
      if (message.kind === "failure") {
        if (active.failed) return protocolError("Repeated chooser failure hook");
        active.failed = true;
      } else active = null;
    }
    expectedId++;
    runningHook = executeHook(message);
    // executeHook records callback failures itself. This guard is for an
    // unexpected runner error only; it must not leave the child waiting forever.
    runningHook.catch(error => protocolError(`Chooser hook runner failed: ${errorText(error)}`));
  };
  const finishLine = () => {
    const bytes = Buffer.concat(lineParts, lineBytes); lineParts.length = 0; lineBytes = 0;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!text.trim()) throw new Error("Empty chooser protocol line");
      accept(JSON.parse(text));
    } catch (error) { protocolError(`Invalid chooser JSONL: ${errorText(error)}`); }
  };
  const receive = chunk => {
    report.process.stdoutBytes += chunk.length;
    const retained = chunk.subarray(0, Math.max(0, limits.stdoutBytes - stdoutRetained));
    if (retained.length) { stdout.push(retained); stdoutRetained += retained.length; }
    if (report.process.stdoutBytes > limits.stdoutBytes) { report.process.stdoutTruncated = true; protocolError("Chooser stdout exceeded 4 MiB"); }
    if (fatal || stopping) return;
    let offset = 0;
    while (offset < chunk.length && !fatal && !stopping) {
      const newline = chunk.indexOf(10, offset), end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end); lineParts.push(part); lineBytes += part.length;
      if (lineBytes > limits.lineBytes) { protocolError("Chooser JSONL line exceeded 1 MiB"); break; }
      if (newline === -1) break;
      finishLine(); offset = newline + 1;
    }
  };
  try { child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env }); }
  catch (error) {
    addError("spawn", error); report.process.spawnError = errorText(error); report.process.completedAt = Date.now(); return report;
  }
  report.process.pid = child.pid ?? null;
  await new Promise(resolve => {
    totalTimer = setTimeout(() => { addError("timeout", "Chooser process exceeded total deadline"); stop("Chooser process exceeded total deadline"); }, timeoutMs);
    child.stdout.on("data", receive);
    child.stdout.once("error", error => protocolError(`Chooser stdout error: ${errorText(error)}`));
    child.stderr.on("data", chunk => {
      report.process.stderrBytes += chunk.length;
      const retained = chunk.subarray(0, Math.max(0, limits.stderrBytes - stderrRetained));
      if (retained.length) { stderr.push(retained); stderrRetained += retained.length; }
      if (report.process.stderrBytes > limits.stderrBytes) { report.process.stderrTruncated = true; protocolError("Chooser stderr exceeded 64 KiB"); }
    });
    child.stderr.once("error", error => protocolError(`Chooser stderr error: ${errorText(error)}`));
    child.stdin.once("error", error => { if (!closed && !stopping) protocolError(`Chooser stdin error: ${errorText(error)}`); });
    child.once("error", error => { addError("process", error); report.process.spawnError = errorText(error); stop("Chooser child process error"); });
    child.once("exit", (code, signal) => {
      report.process.exitObserved = true; report.process.exitedAt = Date.now(); report.process.exitCode = code; report.process.signal = signal;
    });
    child.once("close", (code, signal) => {
      closed = true; clearTimeout(totalTimer); clearTimeout(forceTimer);
      report.process.closeObserved = true; report.process.closedAt = Date.now(); report.process.exitCode = code; report.process.signal = signal;
      if (pendingHook) pendingHook.abort(new Error("Chooser process closed before hook acknowledgement"));
      resolve();
    });
  });
  await runningHook?.catch(error => addError("hook-runner", error));
  if (lineBytes) addError("protocol", "Chooser stdout ended with an incomplete JSONL line");
  if (active) addError("protocol", "Chooser process closed with an unfinished variant");
  if (!resultSeen) addError("protocol", "Chooser process closed without a result");
  report.process.stdout = Buffer.concat(stdout, stdoutRetained).toString("utf8");
  report.process.stderr = Buffer.concat(stderr, stderrRetained).toString("utf8");
  report.process.durationMs = performance.now() - started;
  report.protocolComplete = resultSeen && !active && lineBytes === 0 && report.errors.length === 0 && report.process.closeObserved;
  report.boundary = "Protocol collection only: exit code and the original task result remain independent. Hook Promise cancellation is cooperative; callbacks receive a signal and must guard late browser work. No browser action is issued by this process runner.";
  return report;
}
