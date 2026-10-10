const modes = new Set(["all", "allow", "block"]);

function errorText(error) {
  return String(error?.message ?? error ?? "Website access settings are unavailable.").slice(0, 2000);
}

function parsePolicy(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !modes.has(value.mode) || !Array.isArray(value.origins) || value.origins.length > 100 ||
      !value.origins.every(origin => typeof origin === "string" && origin.length > 0) || value.ready !== true) {
    throw new Error(value?.error || "Website access settings are unavailable.");
  }
  return { ...value, origins: [...value.origins] };
}

// Origin parsing and canonicalization belong to the worker. Preserve the user's
// draft so a rejected origin can be corrected without losing the other entries.
function draftPolicy(draft) {
  const origins = draft.mode === "all" ? [] : draft.originsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (origins.length > 100) throw new Error("Enter no more than 100 origins, one per line.");
  return { mode: draft.mode, origins };
}

export function createSiteAccessControl({ sendMessage, render, onApplied = () => {} }) {
  let policy = null, baseRevision = null;
  let draft = { mode: "all", originsText: "" };
  let dirty = false, pending = null, unavailable = false, error = "", applied = false;
  let generation = 0, sequence = 0, appliedSequence = 0;

  const emit = () => {
    const conflict = policy !== null && baseRevision !== policy.revision;
    const unknown = unavailable || !policy;
    let message = applied ? "Settings saved and agents paused. Use Resume control when you’re ready." : "Saved settings loaded.";
    if (dirty) message = "Unsaved changes.";
    if (conflict) message = "Saved settings changed. Your draft is preserved. Reload saved settings to review them.";
    if (unknown) message = "Check saved settings before applying changes.";
    if (pending === "save") message = "Applying settings and pausing agents…";
    if (pending === "reload") message = "Loading saved settings…";
    render({ ...draft, revision: policy?.revision ?? null, dirty, pending, conflict,
      label: pending === "save" ? "Saving" : pending === "reload" ? "Checking" : unknown ? policy || error ? "Unavailable" : "Checking" : conflict ? "Changed" : dirty ? "Unsaved" : "Saved",
      message, error, listVisible: draft.mode !== "all", editingDisabled: Boolean(pending) || !policy,
      applyDisabled: Boolean(pending) || unknown || conflict || !dirty,
      reloadDisabled: Boolean(pending),
      reloadText: unknown ? "Check saved settings" : "Reload saved settings",
      applyText: pending === "save" ? "Applying…" : "Apply and pause agents"
    });
  };
  const accept = (response, { discardDraft = false } = {}) => {
    const next = parsePolicy(response?.policy);
    if (policy && next.revision < policy.revision) return false;
    policy = next;
    unavailable = false;
    if (discardDraft || !dirty) {
      draft = { mode: next.mode, originsText: next.origins.join("\n") };
      baseRevision = next.revision;
      dirty = false;
    }
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
      if (accept(response) && wasUnavailable) error = "";
    } catch (failure) {
      if (requestGeneration !== generation || requestSequence < appliedSequence) return;
      appliedSequence = requestSequence;
      unavailable = true;
      error = errorText(failure);
    }
    emit();
  }

  function edit(value) {
    if (pending || !policy) return;
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
    if (pending || unavailable || !policy || !dirty || baseRevision !== policy.revision) return;
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
      if (!accept(response, { discardDraft: true })) throw new Error("Saved settings changed. Check again before applying.");
      applied = true;
    } catch (failure) {
      // A rejected or lost reply is not proof of which policy was persisted.
      // Polling may verify it, but only another user action can submit again.
      if (!confirmedFailure) unavailable = true;
      error = errorText(failure);
    } finally {
      pending = null;
      emit();
    }
    if (applied) onApplied();
  }
  emit();
  return { refresh, edit, reload, apply };
}
