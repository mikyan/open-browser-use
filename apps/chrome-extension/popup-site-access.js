const modes = new Set(["all", "allow", "block"]);

function errorText(error) {
  return String(error?.message ?? error ?? "Website access settings are unavailable.").slice(0, 2000);
}

function parsePolicy(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !modes.has(value.mode) || !Array.isArray(value.origins) || value.origins.length > 100 ||
      !value.origins.every(origin => typeof origin === "string" && origin.length > 0 && origin.length <= 2048) ||
      (value.mode === "all" && value.origins.length !== 0) ||
      !(value.ready === true || (value.ready === false && value.retryable === true))) {
    throw new Error(value?.error || "Website access settings are unavailable.");
  }
  return { ...value, origins: [...value.origins] };
}
const isCandidate = value => value?.ready === false && value.retryable === true;
const policyKey = value => JSON.stringify([value.revision, value.mode, value.origins]);

// Origin parsing and canonicalization belong to the worker. Preserve the user's
// draft so a rejected origin can be corrected without losing the other entries.
function draftPolicy(draft) {
  const origins = draft.mode === "all" ? [] : draft.originsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (origins.length > 100) throw new Error("Enter no more than 100 origins, one per line.");
  return { mode: draft.mode, origins };
}

export function createSiteAccessControl({ sendMessage, render, onApplied = () => {}, onSettled = () => {} }) {
  let policy = null, baseRevision = null, reviewedKey = null;
  let draft = { mode: "all", originsText: "" };
  let dirty = false, pending = null, unavailable = false, error = "", applied = false;
  let generation = 0, sequence = 0, appliedSequence = 0;

  const emit = () => {
    const candidate = isCandidate(policy);
    const conflict = policy !== null && (baseRevision !== policy.revision || (candidate && reviewedKey !== policyKey(policy)));
    const unknown = unavailable || !policy;
    let message = applied ? "Settings saved and agents paused. Use Resume control when you’re ready." : "Saved settings loaded.";
    if (dirty) message = "Unsaved changes.";
    if (conflict) message = "Saved settings changed. Your draft is preserved. Reload saved settings to review them.";
    if (candidate) message = dirty || conflict
      ? "These settings were not saved. Your draft is preserved. Review the unsaved settings before retrying."
      : "These settings were not saved. Review the settings shown, then retry saving. Agents remain paused.";
    if (unknown) message = "Check saved settings before applying changes.";
    if (pending === "save") message = "Applying settings and pausing agents…";
    if (pending === "retry") message = "Retrying save and keeping agents paused…";
    if (pending === "reload") message = "Loading saved settings…";
    render({ ...draft, revision: policy?.revision ?? null, dirty, pending, conflict,
      label: pending === "save" || pending === "retry" ? "Saving" : pending === "reload" ? "Checking" : unknown ? policy || error ? "Unavailable" : "Checking" : candidate ? "Not saved" : conflict ? "Changed" : dirty ? "Unsaved" : "Saved",
      message, error, listVisible: draft.mode !== "all", editingDisabled: Boolean(pending) || !policy || candidate,
      applyDisabled: Boolean(pending) || unknown || candidate || conflict || !dirty,
      reloadDisabled: Boolean(pending),
      reloadText: unknown ? "Check saved settings" : candidate ? "Review unsaved settings" : "Reload saved settings",
      applyText: pending === "save" ? "Applying…" : "Apply and pause agents",
      retryVisible: !unknown && candidate,
      retryDisabled: Boolean(pending) || unknown || !candidate || conflict || dirty,
      retryText: pending === "retry" ? "Retrying…" : "Retry save and keep paused"
    });
  };
  const accept = (response, { discardDraft = false } = {}) => {
    const next = parsePolicy(response?.policy);
    if (policy && next.revision < policy.revision) return false;
    const first = policy === null;
    policy = next;
    unavailable = false;
    // Polling may reveal a new failed candidate, but cannot count as the user's
    // review of it. Keep the displayed draft until an explicit reload. Initial
    // popup loading can display the candidate directly for review and retry.
    if (discardDraft || (!dirty && (first || next.ready || reviewedKey === policyKey(next)))) {
      draft = { mode: next.mode, originsText: next.origins.join("\n") };
      baseRevision = next.revision;
      reviewedKey = policyKey(next);
      dirty = false;
    }
    if (isCandidate(next)) error = errorText(next.error || "Website access settings could not be saved.");
    return true;
  };

  async function refresh() {
    if (pending) return;
    const requestGeneration = generation, requestSequence = ++sequence;
    try {
      const response = await sendMessage({ type: "GET_SITE_ACCESS_POLICY" });
      if (requestGeneration !== generation || requestSequence < appliedSequence) return;
      appliedSequence = requestSequence;
      if (response?.ok !== true) throw new Error(response?.error || "Website access settings are unavailable.");
      const wasUnavailable = unavailable;
      const wasCandidate = isCandidate(policy);
      if (accept(response) && (wasUnavailable || wasCandidate) && policy.ready) error = "";
    } catch (failure) {
      if (requestGeneration !== generation || requestSequence < appliedSequence) return;
      appliedSequence = requestSequence;
      unavailable = true;
      error = errorText(failure);
    }
    emit();
  }

  function edit(value) {
    if (pending || !policy || isCandidate(policy)) return;
    if (!modes.has(value.mode) || typeof value.originsText !== "string") return;
    draft = { mode: value.mode, originsText: value.originsText };
    dirty = true;
    applied = false;
    error = "";
    emit();
  }

  async function reload() {
    if (pending) return;
    generation++;
    pending = "reload";
    error = "";
    applied = false;
    emit();
    try {
      const response = await sendMessage({ type: "GET_SITE_ACCESS_POLICY" });
      if (response?.ok !== true) throw new Error(response?.error || "Website access settings are unavailable.");
      if (!accept(response, { discardDraft: true })) throw new Error("Saved settings changed. Check again before applying.");
    } catch (failure) {
      unavailable = true;
      error = errorText(failure);
    } finally {
      pending = null;
      emit();
    }
  }

  async function apply() {
    if (pending || unavailable || !policy?.ready || !dirty || baseRevision !== policy.revision) return;
    let value;
    try { value = draftPolicy(draft); }
    catch (failure) { error = errorText(failure); emit(); return; }
    generation++;
    pending = "save";
    error = "";
    applied = false;
    emit();
    let confirmedFailure = false;
    try {
      const response = await sendMessage({ type: "SET_SITE_ACCESS_POLICY", policy: value, expectedRevision: baseRevision });
      if (response?.ok !== true) {
        if (response?.policy) confirmedFailure = accept(response);
        throw new Error(response?.error || "Website access settings were not confirmed. Check saved settings before retrying.");
      }
      if (response.policy?.ready !== true || !accept(response, { discardDraft: true }))
        throw new Error("Saved settings changed. Check again before applying.");
      applied = true;
    } catch (failure) {
      // A rejected or lost reply is not proof of which policy was persisted.
      // Polling may verify it, but only another user action can submit again.
      if (!confirmedFailure) unavailable = true;
      error = errorText(failure);
    } finally {
      pending = null;
      emit();
      onSettled();
    }
    if (applied) onApplied();
  }

  async function retry() {
    if (pending || unavailable || !isCandidate(policy) || dirty || reviewedKey !== policyKey(policy)) return;
    const reviewed = policy;
    generation++;
    pending = "retry";
    error = "";
    applied = false;
    emit();
    let confirmedFailure = false;
    try {
      // The worker owns the frozen candidate. Do not submit the editable draft
      // or reconstruct a failed write from the popup's copy.
      const response = await sendMessage({ type: "RETRY_SITE_ACCESS_POLICY", expectedRevision: reviewed.revision });
      if (response?.ok !== true) {
        if (response?.policy) confirmedFailure = accept(response);
        throw new Error(response?.error || "Website access settings were not confirmed. Check saved settings before retrying.");
      }
      const next = parsePolicy(response.policy);
      if (!next.ready || next.revision !== reviewed.revision + 1 || next.mode !== reviewed.mode ||
          JSON.stringify(next.origins) !== JSON.stringify(reviewed.origins) || !accept(response, { discardDraft: true }))
        throw new Error("The retry was not confirmed. Check saved settings before retrying.");
      applied = true;
    } catch (failure) {
      if (!confirmedFailure) unavailable = true;
      error = errorText(failure);
    } finally {
      pending = null;
      emit();
      onSettled();
    }
    if (applied) onApplied();
  }
  emit();
  return { refresh, edit, reload, apply, retry };
}
