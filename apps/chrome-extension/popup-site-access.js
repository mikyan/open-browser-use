const modes = new Set(["all", "allow", "block"]);
const validGeneration = value => typeof value === "string" && value.length > 0 && value.length <= 128;

function errorText(error) {
  return String(error?.message ?? error ?? "Website access settings are unavailable.").slice(0, 2000);
}

function parsePolicy(value) {
  if (!value || value.version !== 1 || !validGeneration(value.generation) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !modes.has(value.mode) || !Array.isArray(value.origins) || value.origins.length > 100 ||
      !value.origins.every(origin => typeof origin === "string" && origin.length > 0 && origin.length <= 2048) ||
      (value.mode === "all" && value.origins.length !== 0) ||
      value.recovery !== undefined || (value.stored !== undefined && typeof value.stored !== "boolean") ||
      (value.ready === true && value.stored === false && (value.revision !== 0 || value.mode !== "all")) ||
      !(value.ready === true || (value.ready === false && value.retryable === true))) {
    throw new Error(value?.error || "Website access settings are unavailable.");
  }
  return { ...value, origins: [...value.origins] };
}
function parseRecovery(value) {
  const recovery = value?.recovery;
  if (value?.ready !== false || !validGeneration(value.generation) || value.retryable === true || !recovery || typeof recovery !== "object" ||
      !["pending", "read-error", "invalid"].includes(recovery.state) ||
      Object.keys(recovery).some(key => key !== "state" && key !== "id") ||
      (recovery.state === "pending" && recovery.id !== undefined) ||
      (recovery.id !== undefined && (typeof recovery.id !== "string" || recovery.id.length === 0 || recovery.id.length > 128)))
    throw new Error("Website access recovery is unavailable. Check saved settings again.");
  return { ...recovery };
}
const isCandidate = value => value?.ready === false && value.retryable === true;
const policyKey = value => JSON.stringify([value.generation, value.revision, value.mode, value.origins]);

// Origin parsing and canonicalization belong to the worker. Preserve the user's
// draft so a rejected origin can be corrected without losing the other entries.
function draftPolicy(draft) {
  const origins = draft.mode === "all" ? [] : draft.originsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (origins.length > 100) throw new Error("Enter no more than 100 origins, one per line.");
  return { mode: draft.mode, origins };
}

function replacementEffect(draft) {
  if (!modes.has(draft.mode)) return "Choose the new website permissions. Nothing has been saved.";
  const count = draft.originsText.split(/\r?\n/).filter(line => line.trim()).length;
  if (draft.mode === "all") return "Replacement allows agents to use all websites.";
  if (draft.mode === "allow") return count === 0 ? "Replacement allows no websites."
    : `Replacement allows only the listed origins (${count} ${count === 1 ? "entry" : "entries"}).`;
  return count === 0 ? "Replacement allows all websites because no origins are blocked."
    : `Replacement allows all websites except the listed origins (${count} ${count === 1 ? "entry" : "entries"}).`;
}

export function createSiteAccessControl({ sendMessage, render, onApplied = () => {}, onSettled = () => {} }) {
  let policy = null, baseRevision = null, reviewedKey = null;
  let draft = { mode: "", originsText: "" }, recovery = null, recoveryGeneration = null, reloaded = false;
  let replacement = null, replacementNeedsConfirmation = false;
  let readConfirmationPending = false;
  let dirty = false, pending = null, unavailable = false, error = "", applied = false;
  let requestEpoch = 0, sequence = 0, appliedSequence = 0;

  const canReviewReplacement = () => recovery?.state === "invalid" && Boolean(recovery.id);
  const replacementAuthorized = () => canReviewReplacement() && replacement?.reviewed?.id === recovery.id &&
    replacement.reviewed.generation === recoveryGeneration;
  const revokeReplacement = () => { if (replacement) replacement.reviewed = null; };

  const emit = () => {
    const candidate = isCandidate(policy);
    const conflict = policy !== null && (baseRevision !== policy.revision || reviewedKey !== policyKey(policy));
    const unknown = unavailable || !policy;
    let message = applied ? "Settings saved and agents paused. Use Resume control when you’re ready." : "Saved settings loaded.";
    if (reloaded) message = "Saved settings reloaded. Agents remain paused.";
    if (policy?.ready && policy.stored === false)
      message = "No saved settings. The default allows all websites." + (reloaded ? " Agents remain paused." : "");
    if (dirty) message = "Unsaved changes.";
    if (conflict) message = "Saved settings changed. Your draft is preserved. Reload saved settings to review them.";
    if (candidate) message = dirty || conflict
      ? "These settings were not saved. Your draft is preserved. Review the unsaved settings before retrying."
      : "These settings were not saved. Review the settings shown, then retry saving. Agents remain paused.";
    if (unknown) message = "Check saved settings before applying changes.";
    if (recovery?.state === "pending") message = "Reading saved settings…";
    if (recovery?.state === "read-error") message = "Saved settings could not be read. Read them again when storage is available.";
    if (recovery?.state === "invalid") message = "Saved settings are invalid and their permissions are unknown. Read them again or explicitly choose replacement settings.";
    if (replacement) message = replacementAuthorized()
      ? "Choose new permissions to replace the invalid saved record. These are new settings, not the previous permissions."
      : "Settings changed or the replacement was not confirmed. Your replacement draft is preserved. Check settings and review before replacing.";
    if (pending === "save") message = "Applying settings and pausing agents…";
    if (pending === "retry") message = "Retrying save and keeping agents paused…";
    if (pending === "reload") message = "Loading saved settings…";
    if (pending === "recover") message = "Reading saved settings and keeping agents paused…";
    if (pending === "replace") message = "Replacing invalid settings and keeping agents paused…";
    const hiddenPolicy = recovery !== null || !policy;
    const shownDraft = replacement?.draft ?? draft;
    render({ ...shownDraft, mode: !replacement && hiddenPolicy ? "" : shownDraft.mode, originsText: !replacement && hiddenPolicy ? "" : shownDraft.originsText,
      revision: hiddenPolicy ? null : policy.revision, dirty, pending, conflict,
      label: pending === "save" || pending === "retry" || pending === "replace" ? "Saving" : pending === "reload" || pending === "recover" || recovery?.state === "pending" ? "Checking" : unknown ? policy || error || recovery ? "Unavailable" : "Checking" : candidate ? "Not saved" : conflict ? "Changed" : dirty ? "Unsaved" : policy.stored === false ? "Default" : "Saved",
      message, error, listVisible: Boolean(replacement || !hiddenPolicy) && modes.has(shownDraft.mode) && shownDraft.mode !== "all",
      editingDisabled: Boolean(pending) || (replacement ? !replacementAuthorized() : unknown || candidate),
      applyDisabled: Boolean(pending) || Boolean(replacement) || unknown || candidate || conflict || !dirty,
      reloadDisabled: Boolean(pending),
      reloadText: unknown ? "Check saved settings" : candidate ? "Review unsaved settings" : "Reload saved settings",
      applyText: pending === "save" ? "Applying…" : "Apply and pause agents",
      retryVisible: !replacement && !unknown && candidate,
      retryDisabled: Boolean(pending) || Boolean(replacement) || unknown || !candidate || conflict || dirty,
      retryText: pending === "retry" ? "Retrying…" : "Retry save and keep paused",
      recoverVisible: recovery !== null && (recovery.state !== "pending" || pending === "recover"),
      recoverDisabled: Boolean(pending) || Boolean(replacement) || !recovery?.id,
      recoverText: pending === "recover" ? "Reading…" : "Read settings again and keep paused",
      replacementActive: replacement !== null,
      modePlaceholder: replacement ? "Choose new website access" : "Saved settings not loaded",
      replacementEffect: replacement ? replacementEffect(replacement.draft) : "",
      replaceReviewVisible: canReviewReplacement() && !replacementAuthorized(),
      replaceReviewDisabled: Boolean(pending),
      replaceDisabled: Boolean(pending) || !replacementAuthorized() || !modes.has(replacement?.draft.mode),
      replaceText: pending === "replace" ? "Replacing…" : "Replace and keep paused",
      replaceCancelDisabled: Boolean(pending)
    });
  };
  const accept = (response, { discardDraft = false, recoveredRead = false } = {}) => {
    if (response?.policy?.recovery !== undefined) {
      recovery = parseRecovery(response.policy);
      recoveryGeneration = response.policy.generation;
      if (!replacementAuthorized()) revokeReplacement();
      if (recovery.state !== "pending") readConfirmationPending = false;
      unavailable = true;
      applied = false;
      reloaded = false;
      error = recovery.state === "pending" ? "" : errorText(response.policy.error || "Saved settings are unavailable.");
      return true;
    }
    const next = parsePolicy(response?.policy);
    // A confirmed explicit reread may come from a new worker after an external
    // repair or removal. If its reply was lost, a fresh GET can confirm that
    // authority once; ordinary GETs retain their revision/order protection.
    if (!recoveredRead && policy?.generation === next.generation && next.revision < policy.revision) return false;
    if (recoveredRead) readConfirmationPending = false;
    const first = policy === null;
    policy = next;
    recovery = null;
    recoveryGeneration = null;
    revokeReplacement();
    unavailable = false;
    const confirmingReplacement = replacementNeedsConfirmation;
    if (confirmingReplacement) { replacement = null; replacementNeedsConfirmation = false; }
    // Polling may reveal a new failed candidate, but cannot count as the user's
    // review of it. Keep the displayed draft until an explicit reload. Initial
    // popup loading can display the candidate directly for review and retry.
    if (discardDraft || (!dirty && (first || next.ready || reviewedKey === policyKey(next)))) {
      draft = { mode: next.mode, originsText: next.origins.join("\n") };
      baseRevision = next.revision;
      reviewedKey = policyKey(next);
      dirty = false;
    }
    // A failed replacement is a new frozen candidate, never an automatic
    // continuation of the invalid record's one-use replacement authority.
    if (confirmingReplacement && isCandidate(next)) reviewedKey = null;
    if (isCandidate(next)) error = errorText(next.error || "Website access settings could not be saved.");
    return true;
  };

  async function refresh() {
    if (pending) return;
    const requestGeneration = requestEpoch, requestSequence = ++sequence;
    try {
      const response = await sendMessage({ type: "GET_SITE_ACCESS_POLICY" });
      if (requestGeneration !== requestEpoch || requestSequence < appliedSequence) return;
      appliedSequence = requestSequence;
      if (response?.ok !== true) throw new Error(response?.error || "Website access settings are unavailable.");
      const wasUnavailable = unavailable;
      const wasCandidate = isCandidate(policy);
      if (accept(response, { recoveredRead: readConfirmationPending && response.policy?.ready === true }) &&
          (wasUnavailable || wasCandidate) && policy?.ready && !recovery) error = "";
    } catch (failure) {
      if (requestGeneration !== requestEpoch || requestSequence < appliedSequence) return;
      appliedSequence = requestSequence;
      unavailable = true;
      recovery = null;
      recoveryGeneration = null;
      revokeReplacement();
      error = errorText(failure);
    }
    emit();
  }

  function edit(value) {
    if (pending || (replacement ? !replacementAuthorized() : unavailable || !policy || isCandidate(policy))) return;
    if (!modes.has(value.mode) || typeof value.originsText !== "string") return;
    if (replacement) replacement.draft = { mode: value.mode, originsText: value.originsText };
    else { draft = { mode: value.mode, originsText: value.originsText }; dirty = true; }
    applied = false;
    reloaded = false;
    error = "";
    emit();
  }

  async function reload() {
    if (pending) return;
    const replacing = replacement !== null;
    replacement = null;
    requestEpoch++;
    pending = "reload";
    error = "";
    applied = false;
    reloaded = false;
    emit();
    try {
      const response = await sendMessage({ type: "GET_SITE_ACCESS_POLICY" });
      if (response?.ok !== true) throw new Error(response?.error || "Website access settings are unavailable.");
      if (!accept(response, { discardDraft: !replacing, recoveredRead: readConfirmationPending && response.policy?.ready === true }))
        throw new Error("Saved settings changed. Check again before applying.");
    } catch (failure) {
      unavailable = true;
      recovery = null;
      recoveryGeneration = null;
      error = errorText(failure);
    } finally {
      pending = null;
      emit();
    }
  }

  async function recover() {
    if (pending || replacement || !recovery?.id) return;
    const expectedRecoveryId = recovery.id;
    requestEpoch++;
    pending = "recover";
    recovery = { state: "pending" };
    readConfirmationPending = true;
    error = "";
    applied = false;
    reloaded = false;
    emit();
    let confirmedFailure = false;
    try {
      // Only the worker can retry the original settled read. No policy draft,
      // revision or replacement value is sent through this recovery path.
      const response = await sendMessage({ type: "RECOVER_SITE_ACCESS_POLICY", expectedRecoveryId });
      if (response?.ok !== true) {
        if (response?.policy) confirmedFailure = accept(response);
        throw new Error(response?.error || "Saved settings could not be read. Check their status before retrying.");
      }
      const next = parsePolicy(response.policy);
      if (!next.ready || !accept(response, { recoveredRead: true })) throw new Error("The read was not confirmed. Check saved settings again.");
      reloaded = true;
    } catch (failure) {
      if (!confirmedFailure) { unavailable = true; recovery = null; recoveryGeneration = null; }
      error = errorText(failure);
    } finally {
      pending = null;
      emit();
      onSettled();
    }
  }

  async function apply() {
    if (pending || replacement || unavailable || !policy?.ready || !dirty || baseRevision !== policy.revision || reviewedKey !== policyKey(policy)) return;
    let value;
    try { value = draftPolicy(draft); }
    catch (failure) { error = errorText(failure); emit(); return; }
    const expectedGeneration = policy.generation;
    requestEpoch++;
    pending = "save";
    error = "";
    applied = false;
    reloaded = false;
    emit();
    let confirmedFailure = false;
    try {
      const response = await sendMessage({ type: "SET_SITE_ACCESS_POLICY", policy: value, expectedRevision: baseRevision, expectedGeneration });
      if (response?.ok !== true) {
        if (response?.policy) confirmedFailure = accept(response);
        throw new Error(response?.error || "Website access settings were not confirmed. Check saved settings before retrying.");
      }
      if (response.policy?.ready !== true || response.policy.generation !== expectedGeneration || !accept(response, { discardDraft: true }))
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
    if (pending || replacement || unavailable || !isCandidate(policy) || dirty || reviewedKey !== policyKey(policy)) return;
    const reviewed = policy;
    requestEpoch++;
    pending = "retry";
    error = "";
    applied = false;
    reloaded = false;
    emit();
    let confirmedFailure = false;
    try {
      // The worker owns the frozen candidate. Do not submit the editable draft
      // or reconstruct a failed write from the popup's copy.
      const response = await sendMessage({ type: "RETRY_SITE_ACCESS_POLICY", expectedRevision: reviewed.revision, expectedGeneration: reviewed.generation });
      if (response?.ok !== true) {
        if (response?.policy) confirmedFailure = accept(response);
        throw new Error(response?.error || "Website access settings were not confirmed. Check saved settings before retrying.");
      }
      const next = parsePolicy(response.policy);
      if (!next.ready || next.generation !== reviewed.generation || next.revision !== reviewed.revision + 1 || next.mode !== reviewed.mode ||
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

  function reviewReplacement() {
    if (pending || !canReviewReplacement()) return;
    requestEpoch++;
    replacement ??= { draft: { mode: "", originsText: "" }, reviewed: null };
    replacement.reviewed = { id: recovery.id, generation: recoveryGeneration };
    replacementNeedsConfirmation = false;
    applied = false;
    reloaded = false;
    error = "";
    emit();
  }

  function cancelReplacement() {
    if (pending || !replacement) return;
    requestEpoch++;
    replacement = null;
    error = "";
    emit();
  }

  async function replace() {
    if (pending || !replacementAuthorized() || !modes.has(replacement.draft.mode)) return;
    let value;
    try { value = draftPolicy(replacement.draft); }
    catch (failure) { error = errorText(failure); emit(); return; }
    const reviewed = replacement.reviewed;
    requestEpoch++;
    pending = "replace";
    replacementNeedsConfirmation = true;
    revokeReplacement();
    recovery = { state: "pending" };
    readConfirmationPending = false;
    error = "";
    applied = false;
    reloaded = false;
    emit();
    let confirmedFailure = false;
    try {
      const response = await sendMessage({ type: "REPLACE_INVALID_SITE_ACCESS_POLICY", policy: value, expectedRecoveryId: reviewed.id });
      if (response?.ok !== true) {
        if (response?.policy) confirmedFailure = accept(response);
        throw new Error(response?.error || "Replacement was not confirmed. Check saved settings before another attempt.");
      }
      const next = parsePolicy(response.policy);
      // Validation remains in the worker. Compare its confirmed canonical
      // result to this submitted choice, not to the unrelated ordinary draft.
      const requestedOrigins = [...new Set(value.origins.map(origin => new URL(origin).origin))].sort();
      if (!next.ready || next.stored !== true || next.generation === reviewed.generation || next.revision !== 1 ||
          next.mode !== value.mode || JSON.stringify(next.origins) !== JSON.stringify(requestedOrigins) ||
          !accept(response))
        throw new Error("The replacement was not confirmed. Check saved settings before another attempt.");
      applied = true;
    } catch (failure) {
      if (!confirmedFailure) { unavailable = true; recovery = null; recoveryGeneration = null; }
      error = errorText(failure);
    } finally {
      pending = null;
      emit();
      onSettled();
    }
    if (applied) onApplied();
  }
  emit();
  return { refresh, edit, reload, apply, retry, recover, reviewReplacement, cancelReplacement, replace };
}
