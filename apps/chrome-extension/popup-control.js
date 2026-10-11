const validStates = new Set(["running", "pausing", "paused", "error"]);

function parseStatus(value) {
  if (!value || !validStates.has(value.state) || typeof value.inputBlocked !== "boolean" ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.cleanupComplete !== "boolean" ||
      value.inputBlocked !== (value.state !== "running")) {
    throw new Error("Automation control status is unavailable.");
  }
  return { ...value };
}

function errorText(error) {
  return String(error?.message ?? error ?? "Automation control is unavailable.").slice(0, 2000);
}

export function automationControlView(status, { pending = null, error = "", unavailable = false } = {}) {
  const state = pending === "pause" ? "pausing" : unavailable || !status ? "unknown" : status.state;
  const details = {
    running: ["Running", "Agents can control their assigned tabs.", "Pause all agents", "pause"],
    pausing: ["Pausing", "Blocking new actions and releasing browser control…", "Pausing…", null],
    paused: ["Paused", "Agent actions are blocked. Browser control has been released.", "Resume control", "resume"],
    error: ["Failed", "Agent actions remain blocked. Retry pause to finish releasing control.", "Retry pause", "pause"],
    unknown: [status || error ? "Unavailable" : "Checking", "Confirm control status before resuming automation.", "Check status", "refresh"]
  }[state];
  let [label, message, buttonText, action] = details;
  let hint = "After resuming, ask your agent to continue.";
  if (state === "paused" && !status.cleanupComplete) {
    message = "Agent actions are blocked. Cleanup still needs to finish.";
    buttonText = "Retry pause";
    action = "pause";
  }
  if (state === "error" || (state === "paused" && !status.cleanupComplete)) {
    if (status.inputRecovery?.action === "close-controlled-pages") {
      message = "Agent actions remain blocked. Save your work, close the pages that were being controlled, then choose Retry pause to check whether control has been released.";
    } else if (status.inputRecovery?.action === "restart-browser" && typeof status.inputRecovery.restartMayNeedRepeat === "boolean") {
      message = "Agent actions remain blocked. Save your work, fully quit this browser (including background processes), then reopen the same profile with this extension enabled and choose Retry pause.";
      hint = "Closing tabs or reloading the extension is not enough. " +
        (status.inputRecovery.restartMayNeedRepeat ? "An additional full restart may be needed to confirm recovery. " : "") + hint;
    }
  }
  if (pending === "resume") buttonText = "Resuming…";
  return { state, revision: status?.revision ?? null, label, message, buttonText, action, disabled: Boolean(pending) || action === null,
    error: error || status?.error || "", hint };
}

// The popup only sends user-control messages. Epoch invalidation and cleanup
// belong to the worker; no tab activation or browser input occurs here.
export function createAutomationControl({ sendMessage, render }) {
  let status = null, pending = null, error = "", unavailable = false;
  let generation = 0, sequence = 0, appliedSequence = 0;
  const emit = () => render(automationControlView(status, { pending, error, unavailable }));
  const accept = response => {
    const next = parseStatus(response?.status);
    if (status && next.revision < status.revision) return false;
    status = next;
    unavailable = false;
    error = response.ok === false ? errorText(response.error ?? next.error) : "";
    return true;
  };
  async function refresh() {
    if (pending) return;
    const requestGeneration = generation, requestSequence = ++sequence;
    try {
      const response = await sendMessage({ type: "GET_AUTOMATION_CONTROL_STATUS" });
      if (requestGeneration !== generation || requestSequence < appliedSequence) return;
      appliedSequence = requestSequence;
      accept(response);
    } catch (failure) {
      if (requestGeneration !== generation || requestSequence < appliedSequence) return;
      appliedSequence = requestSequence;
      unavailable = true;
      error = errorText(failure);
    }
    emit();
  }
  async function mutate(action) {
    if (pending) return;
    if (action === "resume" && (unavailable || status?.state !== "paused" || !status.cleanupComplete)) return;
    generation++;
    pending = action;
    error = "";
    emit();
    try {
      const response = await sendMessage(action === "pause"
        ? { type: "PAUSE_AUTOMATION" }
        : { type: "RESUME_AUTOMATION", expectedRevision: status.revision });
      accept(response);
    } catch (failure) {
      // A lost reply cannot prove whether the worker accepted the mutation.
      // Require a fresh status query instead of claiming Running or Paused.
      unavailable = true;
      error = errorText(failure);
    } finally {
      pending = null;
      emit();
    }
  }
  async function activate() {
    const { action, disabled } = automationControlView(status, { pending, error, unavailable });
    if (disabled) return;
    if (action === "refresh") return refresh();
    return mutate(action);
  }
  emit();
  return { refresh, activate };
}
