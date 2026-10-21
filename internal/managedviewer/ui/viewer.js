"use strict";

(() => {
  // The one-use ticket never enters a request URL, cookie or persistent storage.
  const fragment = new URLSearchParams(location.hash.slice(1));
  let ticket = fragment.get("ticket") || "";
  history.replaceState(null, "", location.pathname);
  const el = Object.fromEntries(["connection", "indicator", "state", "detail", "refresh", "control", "stop", "error", "tabs", "watch", "freshness", "screen", "frame", "placeholder", "page-title", "dimensions", "human-begin", "human-end", "human-switch", "human-status", "human-input", "clipboard-status", "page-dialog", "dialog-title", "dialog-source", "dialog-message", "dialog-prompt-label", "dialog-prompt", "dialog-accept", "dialog-cancel", "dialog-status"].map(id => [id, document.getElementById(id)]));
  let ws, connected = false, authenticated = false, available = false, stopped = false;
  let status = null, worker = "", pendingAction = null, nextId = 0, appliedId = 0;
  let selected = null, selectedOnce = false, tabs = [], lastFrameAt = 0, imageURL = null;
  let selectedDeliveryId = "", selectionEpoch = 0;
  let selectedPageSelectionId = "", pageSelectionVersion, pageSelectionKnown = false, pageSwitch = null;
  let watching = null, pendingSelectTab = null, pendingSelectId = null;
  let viewerCleanupComplete = false;
  let controlSequence = -1, retiredSequence = -1, lastFrameEvent = -1, revoked = false;
  let stream = "", frameSequence = -1, imageGeneration = 0;
  let imageBusy = false, pendingFrame = null;
  let lastFrameTitle = "";
  let awaitingSelectionFrame = null;
  let view = null, awaitingViewFrame = null;
  let human = null, humanAction = null, humanOwner = "", humanEnding = false;
  // Status and frames may precede Begin. Only its original successful response
  // admits this UI epoch; navigation cannot replace that receipt.
  let humanAdmitted = false;
  let humanEpoch = 0;
  let displayedNotice = null;
  let humanSequence = 0, humanInputId = null, decodedHuman = null, awaitingHumanFrame = null;
  let acknowledgedSequence = 0, composing = false, compositionScope = null;
  let inputAnchor = null;
  let printableCandidate = null;
  let retiredHumanGeneration = -1;
  let humanEndAttempted = false;
  let pendingDialog = null, displayedDialog = "", claimedDialog = "";
  let pendingFileChooser = null;
  const dialogSources = new Map();
  const inputQueue = [], pressedButtons = new Set(), pressedKeys = new Set(), capturedPointers = new Set();
  const mouseHolds = new Map();
  let mouseClick = null;
  const maxQueuedInputs = 32;
  // Named DOM keys from Chromium 156.0.8078.12 ui/events/keycodes/dom/dom_key_data.inc
  // (SHA256 f5f43926d374272c151bdfd06b772898996f519dbccf1b8d8f15957bc3cfe4ed),
  // plus KeyStringToDomKey's Dead special case. Other multi-scalar keys
  // use confirmed text; they cannot be faithfully encoded as a CDP key.
  const namedDOMKeys = new Set(`
    .AltGraphLatch AVRInput AVRPower Accel Accept Again AllCandidates Alphanumeric Alt AltGraph AppSwitch
    ArrowDown ArrowLeft ArrowRight ArrowUp Attn AudioBalanceLeft AudioBalanceRight AudioBassBoostDown
    AudioBassBoostToggle AudioBassBoostUp AudioFaderFront AudioFaderRear AudioSurroundModeNext AudioTrebleDown
    AudioTrebleUp AudioVolumeDown AudioVolumeMute AudioVolumeUp Backspace BrightnessDown BrightnessUp
    BrowserBack BrowserFavorites BrowserForward BrowserHome BrowserRefresh BrowserSearch BrowserStop Call
    Camera CameraFocus Cancel CapsLock ChannelDown ChannelUp Clear Close ClosedCaptionToggle CodeInput
    ColorF0Red ColorF1Green ColorF2Yellow ColorF3Blue ColorF4Grey ColorF5Brown Compose ContextMenu Control
    Convert Copy CrSel Cut DVR Dead Delete Dimmer DisplaySwap Eisu Eject End EndCall Enter EraseEof Escape
    ExSel Execute Exit F1 F10 F11 F12 F13 F14 F15 F16 F17 F18 F19 F2 F20 F21 F22 F23 F24 F3 F4 F5 F6 F7 F8 F9
    FavoriteClear0 FavoriteClear1 FavoriteClear2 FavoriteClear3 FavoriteRecall0 FavoriteRecall1
    FavoriteRecall2 FavoriteRecall3 FavoriteStore0 FavoriteStore1 FavoriteStore2 FavoriteStore3 FinalMode Find
    Fn FnLock GoBack GoHome GroupFirst GroupLast GroupNext GroupPrevious Guide GuideNextDay GuidePreviousDay
    HangulMode HanjaMode Hankaku HeadsetHook Help Hibernate Hiragana HiraganaKatakana Home Hyper Info Insert
    InstantReplay JunjaMode KanaMode KanjiMode Katakana Key11 Key12 LastNumberRedial LaunchApplication1
    LaunchApplication2 LaunchAssistant LaunchCalendar LaunchContacts LaunchControlPanel LaunchMail
    LaunchMediaPlayer LaunchMusicPlayer LaunchPhone LaunchScreenSaver LaunchSpreadsheet LaunchWebBrowser
    LaunchWebCam LaunchWordProcessor Link ListProgram LiveContent Lock LogOff MailForward MailReply MailSend
    MannerMode MediaApps MediaAudioTrack MediaClose MediaFastForward MediaLast MediaPause MediaPlay
    MediaPlayPause MediaRecord MediaRewind MediaSkip MediaSkipBackward MediaSkipForward MediaStepBackward
    MediaStepForward MediaStop MediaTopMenu MediaTrackNext MediaTrackPrevious Meta MicrophoneToggle
    MicrophoneVolumeDown MicrophoneVolumeMute MicrophoneVolumeUp ModeChange NavigateIn NavigateNext
    NavigateOut NavigatePrevious New NextCandidate NextFavoriteChannel NextUserProfile NonConvert Notification
    NumLock OnDemand Open PageDown PageUp Pairing Paste Pause PinPDown PinPMove PinPToggle PinPUp Play
    PlaySpeedDown PlaySpeedReset PlaySpeedUp Power PowerOff PreviousCandidate Print PrintScreen Process Props
    RandomToggle RcLowBattery RecordSpeedNext Redo RfBypass Romaji STBInput STBPower Save ScanChannelsToggle
    ScreenModeNext ScrollLock Select Settings Shift ShiftLevel5 SingleCandidate Soft1 Soft2 Soft3 Soft4 Soft5
    Soft6 Soft7 Soft8 SpeechCorrectionList SpeechInputToggle SpellCheck SplitScreenToggle Standby Subtitle
    Super Symbol SymbolLock TV TV3DMode TVAntennaCable TVAudioDescription TVAudioDescriptionMixDown
    TVAudioDescriptionMixUp TVContentsMenu TVDataService TVInput TVInputComponent1 TVInputComponent2
    TVInputComposite1 TVInputComposite2 TVInputHDMI1 TVInputHDMI2 TVInputHDMI3 TVInputHDMI4 TVInputVGA1
    TVMediaContext TVNetwork TVNumberEntry TVPower TVRadioService TVSatellite TVSatelliteBS TVSatelliteCS
    TVSatelliteToggle TVTerrestrialAnalog TVTerrestrialDigital TVTimer Tab Teletext Undo Unidentified
    VideoModeNext VoiceDial WakeUp Wink Zenkaku ZenkakuHankaku ZoomIn ZoomOut ZoomToggle
  `.trim().split(/\s+/));
  const pending = new Map();
  // A real local write outlives input queue retirement. Rejecting its data is
  // not proof of native settlement, and resolved data cannot be retracted.
  let localClipboard = null, clipboardNotice = "";
  const clipboardInputs = new WeakMap();
  const clipboardKeys = new Set();
  const transferFailures = new Set(["UNSUPPORTED", "DENIED", "BUSY", "CANCELLED", "TIMEOUT", "CHANGED", "LIMIT", "READ_FAILED"]);
  const fileElements = Object.fromEntries(["file-chooser", "file-title", "file-source", "file-description", "file-choose", "file-cancel", "file-picker", "file-status"].map(id => [id, document.getElementById(id)]));
  const humanFiles = ManagedHumanFiles.create({
    elements: fileElements,
    request: (operation, fields) => new Promise((resolve, reject) => {
      if (send(operation, fields, { resolve, reject }) === undefined) reject(new Error("Viewer connection unavailable"));
    }),
    onFatal: message => endHuman(message),
    onChange: () => render(),
  });

  function renderClipboard() {
    const record = localClipboard;
    el["clipboard-status"].dataset.pending = String(Boolean(record?.writePending));
    el["clipboard-status"].dataset.dataState = record?.dataState || "";
    el["clipboard-status"].hidden = !clipboardNotice;
    el["clipboard-status"].textContent = clipboardNotice +
      (record?.writePending && record.dataState === "rejected" && !record.retired ? " 本地写入尚待结束。" : "");
  }
  function rejectClipboardData(record, message) {
    if (record.dataState !== "pending") return;
    record.dataState = "rejected";
    record.reject(new Error(message));
  }
  function retireClipboard() {
    const record = localClipboard;
    if (!record || !record.writePending) return;
    record.retired = true;
    rejectClipboardData(record, "Original human input retired");
    clipboardNotice = record.dataState === "resolved"
      ? "本地剪贴板写入仍待确认；内容已交给浏览器，不能撤回。"
      : "待传文字已取消；仍在等待本地剪贴板写入结束。";
    renderClipboard();
  }
  function cancelUnsentClipboard(record) {
    if (record !== localClipboard || record.requestId !== null || record.retired ||
        record.humanEpoch !== humanEpoch || record.leaseId !== humanOwner ||
        record.leaseId !== human?.leaseId || record.generation !== human.generation ||
        !humanAdmitted || humanEnding || revoked) return false;
    // The shortcut is still queued behind an original input. End discards that
    // queue and releases held modifiers; a late input ACK cannot revive it.
    record.retired = true;
    clipboardNotice = "本地剪贴板未就绪；本次复制或剪切未发送。";
    endHuman("本地剪贴板未就绪，正在释放人工控制。", false, "human-release");
    return true;
  }
  function startClipboard(operation, event) {
    if (localClipboard?.writePending) {
      clipboardNotice = "上一次本地剪贴板写入尚未结束；本次复制或剪切未发送。";
      renderClipboard(); return null;
    }
    if (event.isTrusted !== true || typeof ClipboardItem !== "function" ||
        typeof navigator === "undefined" || typeof navigator.clipboard?.write !== "function") {
      clipboardNotice = "当前浏览器不能接收剪贴板文字；本次复制或剪切未发送。";
      renderClipboard(); return null;
    }
    const record = { operation, humanEpoch, leaseId: human.leaseId, generation: human.generation,
      dataState: "pending", writePending: true, retired: false, requestId: null, sequence: null };
    const data = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    // Construction/write may fail before a browser consumes this promise.
    data.catch(() => {});
    try {
      const item = new ClipboardItem({ "text/plain": data });
      record.actual = navigator.clipboard.write([item]); // Still in the original trusted keydown.
      if (!record.actual || typeof record.actual.then !== "function") throw new Error("Missing native write promise");
    } catch {
      record.writePending = false;
      rejectClipboardData(record, "Local clipboard unavailable");
      clipboardNotice = "本地剪贴板未就绪；本次复制或剪切未发送。";
      renderClipboard(); return null;
    }
    localClipboard = record;
    clipboardNotice = "正在等待原复制或剪切结果写入本地剪贴板。";
    record.actual.then(() => {
      record.writePending = false;
      if (record.dataState === "resolved") clipboardNotice = "文字已写入本地剪贴板。";
      else {
        rejectClipboardData(record, "Local write settled without original data");
        if (cancelUnsentClipboard(record)) return;
        clipboardNotice = "本地剪贴板结果未确认；不会重试复制或剪切。";
      }
      renderClipboard();
    }, () => {
      record.writePending = false;
      const hadData = record.dataState === "resolved";
      rejectClipboardData(record, "Local clipboard write rejected");
      if (cancelUnsentClipboard(record)) return;
      if (hadData || !record.retired && record.notice === undefined)
        clipboardNotice = "本地剪贴板写入失败；网页按键不会重试，剪切不会回滚。";
      else if (record.retired) clipboardNotice = "本地剪贴板写入已结束；待传文字未提交。";
      else clipboardNotice = record.notice;
      renderClipboard();
    });
    renderClipboard();
    return record;
  }
  function completeClipboard(entry, id, receipt) {
    const record = clipboardInputs.get(entry.fields.input);
    if (!record || record.dataState !== "pending" || record.retired || !record.writePending) return;
    const current = record === localClipboard && record.requestId === id && record.sequence === receipt.sequence &&
      record.humanEpoch === humanEpoch && record.leaseId === humanOwner && record.leaseId === receipt.leaseId &&
      record.generation === receipt.generation && human?.generation === record.generation &&
      human.clipboardTransferVersion === 1 && !humanEnding && humanAdmitted && !revoked;
    const transfer = receipt.clipboardTransfer;
    const keys = transfer && typeof transfer === "object" && !Array.isArray(transfer) ? Object.keys(transfer).sort().join(",") : "";
    const ready = keys === "operation,status,text" && transfer.status === "ready" &&
      typeof transfer.text === "string" && transfer.text.length <= 65536 &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(transfer.text) &&
      new TextEncoder().encode(transfer.text).byteLength <= 65536;
    const unchanged = keys === "operation,status" && transfer.status === "unchanged";
    const failed = keys === "code,operation,status" && transfer.status === "failed" && transferFailures.has(transfer.code);
    if (!current || transfer?.operation !== record.operation || !(ready || unchanged || failed)) {
      record.notice = "剪贴板回执无法确认；不会重试原按键。";
    } else if (ready) {
      // No await between the original authority check and supplying native data.
      try {
        const blob = new Blob([transfer.text], { type: "text/plain" });
        record.dataState = "resolved";
        record.resolve(blob);
        clipboardNotice = "文字已交给浏览器，正在等待本地剪贴板写入确认。";
        renderClipboard(); return;
      } catch { record.notice = "本地剪贴板文字处理失败；原按键已确认，不会重试。"; }
    } else record.notice = unchanged ? "未观察到新的可复制文字；本地剪贴板未更新。" : "远端剪贴板文字未能传回；原按键已确认，不会重试。";
    rejectClipboardData(record, "Clipboard transfer unavailable");
    clipboardNotice = record.notice;
    renderClipboard();
  }

  const selectedTab = () => tabs.find(tab => tab.id === selected && (tab.deliveryId || "") === selectedDeliveryId && (tab.pageSelectionId || "") === selectedPageSelectionId);
  const userControlReady = () => status?.state === "running" || status?.state === "paused" && status.cleanupComplete && viewerCleanupComplete;
  const canUseTab = (tab, operation) => Boolean(tab && tab[operation] && (tab.kind === "task" ? status?.state === "running" : userControlReady()));
  const selectionFields = () => ({ tabId: selected, ...(selectedDeliveryId ? { deliveryId: selectedDeliveryId } : {}), ...(selectedPageSelectionId ? { pageSelectionId: selectedPageSelectionId } : {}) });
  const validSelectionId = value => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
  function normalizedTabs(values, next) {
    if (!Array.isArray(values) || values.length > 4096) throw new Error("标签页列表无效。");
    const seen = new Set();
    return values.map(tab => {
      if (!Number.isSafeInteger(tab.id) || tab.id < 1 || seen.has(tab.id) || typeof tab.title !== "string" || typeof tab.url !== "string") throw new Error("标签页身份无效。");
      seen.add(tab.id);
      const legacy = tab.kind === undefined && tab.watchable === undefined && tab.takeover === undefined && tab.deliveryId === undefined && tab.pageSelectionId === undefined;
      if (legacy) return { ...tab, kind: "task", watchable: next.state === "running", takeover: next.state === "running" };
      if (!["task", "result", "browser"].includes(tab.kind) || typeof tab.watchable !== "boolean" || typeof tab.takeover !== "boolean" ||
        tab.kind === "result" && (!validSelectionId(tab.deliveryId) || tab.pageSelectionId !== undefined) ||
        tab.kind === "browser" && (pageSelectionVersion !== 1 || !validSelectionId(tab.pageSelectionId) || tab.deliveryId !== undefined) ||
        tab.kind === "task" && (tab.deliveryId !== undefined || tab.pageSelectionId !== undefined)) throw new Error("页面选择身份无效。");
      return tab;
    });
  }
  function validView(value) {
    return !value || ["starting", "active", "navigating", "releasing", "released", "error"].includes(value.state) &&
      typeof value.leaseId === "string" && value.leaseId && Number.isSafeInteger(value.tabId) && value.tabId > 0 &&
      Number.isSafeInteger(value.generation) && value.generation >= 0 &&
      (value.state !== "navigating" || value.generation > 0 && value.viewport === null) &&
      (value.viewport === null ? value.state !== "active" || value.generation === 0 : Number.isFinite(value.viewport?.width) && value.viewport.width > 0 && Number.isFinite(value.viewport?.height) && value.viewport.height > 0);
  }

  function humanReserved() { return human && human.state !== "released"; }
  const admittedHumanState = value => value && ["preparing", "active", "navigating"].includes(value.state);
  function validHuman(value) {
    return value && ["starting", "preparing", "active", "navigating", "releasing", "released", "error"].includes(value.state) &&
      typeof value.leaseId === "string" && value.leaseId && Number.isSafeInteger(value.tabId) && value.tabId > 0 &&
      Number.isSafeInteger(value.generation) && value.generation >= 0 &&
      (!Object.hasOwn(value, "inputBudgetVersion") || value.inputBudgetVersion === 1) &&
      (!Object.hasOwn(value, "keyRepeatVersion") || value.keyRepeatVersion === 1) &&
      (!Object.hasOwn(value, "printableKeyVersion") || value.printableKeyVersion === 1) &&
      (!Object.hasOwn(value, "pointerClickCountVersion") || value.pointerClickCountVersion === 1) &&
      (!Object.hasOwn(value, "clipboardTransferVersion") || value.clipboardTransferVersion === 1) &&
      (!Object.hasOwn(value, "fileChooserVersion") || [1, 2].includes(value.fileChooserVersion)) &&
      (value.state !== "preparing" || value.viewport === null) &&
      (value.state !== "navigating" || value.generation > 0 && value.viewport === null) &&
      (value.viewport === null ? value.state !== "active" || value.generation === 0 :
        Number.isFinite(value.viewport?.width) && value.viewport.width > 0 && Number.isFinite(value.viewport?.height) && value.viewport.height > 0);
  }
  const dialogKey = value => value ? JSON.stringify([value.leaseId, value.generation, value.dialogId]) : "";
  function boundedText(value) {
    return typeof value === "string" && value.isWellFormed() && new TextEncoder().encode(value).length <= 8192;
  }
  function validDialogSource(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, "origin") || !Object.hasOwn(value, "frame") || !["top-level", "child"].includes(value.frame) ||
        typeof value.origin !== "string" || value.origin.length > 2048 || !/^[\x21-\x7e]+$/.test(value.origin)) return false;
    try { const url = new URL(value.origin); return ["http:", "https:"].includes(url.protocol) && url.origin === value.origin; }
    catch { return false; }
  }
  function rememberDialogSource(value) {
    if (!value) return;
    const key = dialogKey(value), source = value.source === undefined ? "" : JSON.stringify([value.source.origin, value.source.frame]);
    if (dialogSources.has(key)) {
      if (dialogSources.get(key) !== source) throw new Error("原网页弹窗的来源发生变化，已禁用回答。");
    } else {
      if (dialogSources.size >= 1024) throw new Error("网页弹窗记录已达上限，请结束后重新接管。");
      dialogSources.set(key, source);
    }
  }
  function validDialog(value, owner) {
    if (value === null) return true;
    return value && admittedHumanState(owner) && value.leaseId === owner.leaseId && value.generation === owner.generation &&
      Number.isSafeInteger(value.generation) && value.generation > 0 && typeof value.dialogId === "string" && value.dialogId.length > 0 && value.dialogId.length <= 128 &&
      !/[\x00-\x1f\x7f]/.test(value.dialogId) && ["alert", "confirm", "prompt", "beforeunload"].includes(value.type) && boundedText(value.message) &&
      (value.defaultPrompt === undefined || value.type === "prompt" && boundedText(value.defaultPrompt)) &&
      (!Object.hasOwn(value, "source") || validDialogSource(value.source));
  }
  function dialogReady() {
    return authenticated && available && !revoked && !stopped && !pendingAction && !humanAction && !humanEnding &&
      humanAdmitted && pendingDialog && admittedHumanState(human) && human.leaseId === humanOwner &&
      pendingDialog.leaseId === humanOwner && pendingDialog.generation === human.generation && dialogKey(pendingDialog) !== claimedDialog;
  }
  function renderDialog() {
    const key = dialogKey(pendingDialog), visible = Boolean(key && !humanEnding && !revoked && !stopped && authenticated && available);
    el["page-dialog"].hidden = !visible;
    el["page-dialog"].dataset.dialogId = visible ? pendingDialog.dialogId : "";
    if (key !== displayedDialog) {
      displayedDialog = key;
      el["dialog-prompt"].value = pendingDialog?.defaultPrompt ?? "";
    }
    const beforeunload = pendingDialog?.type === "beforeunload";
    el["dialog-title"].textContent = beforeunload ? "离开此页面？" : pendingDialog?.type === "prompt" ? "网页请求输入" : pendingDialog?.type === "confirm" ? "网页请求确认" : "网页提示";
    el["dialog-cancel"].textContent = beforeunload ? "留在页面" : "取消";
    el["dialog-accept"].textContent = beforeunload ? "离开页面" : "确定";
    const source = pendingDialog?.source;
    el["dialog-source"].textContent = !visible ? "" : source ? `来源：${source.frame === "child" ? "子页面" : "主页面"} · ${source.origin}` : "来源未提供";
    el["dialog-message"].textContent = pendingDialog?.message ?? "";
    el["dialog-prompt-label"].hidden = pendingDialog?.type !== "prompt";
    el["dialog-prompt"].disabled = !dialogReady();
    el["dialog-accept"].disabled = el["dialog-cancel"].disabled = !dialogReady();
    el["dialog-cancel"].hidden = pendingDialog?.type === "alert";
    const waiting = human?.inputBudgetVersion === 1 ?
      "以下内容来自网页。弹窗最多等待 5 分钟；同一操作中的多个弹窗共用这段等待时间。超时会结束接管，尚未回答的弹窗会取消。" :
      "以下内容来自网页。请及时处理；原操作超过 30 秒未确认时会结束接管。";
    el["dialog-status"].textContent = key && key === claimedDialog ? "正在等待网页确认…" :
      (beforeunload ? "离开后，未保存的更改可能丢失。" : "") + waiting;
  }
  function respondDialog(accept) {
    if (!dialogReady()) return;
    const original = pendingDialog;
    const promptText = original.type === "prompt" && accept ? el["dialog-prompt"].value : undefined;
    if (promptText !== undefined && !boundedText(promptText)) { error("输入内容需为有效文字，且不超过 8192 字节。"); return; }
    claimedDialog = dialogKey(original);
    error();
    send("humanDialogRespond", { leaseId: original.leaseId, generation: original.generation, dialogId: original.dialogId, accept,
      ...(promptText !== undefined ? { promptText } : {}) });
  }
  function humanReady(releasingHeldInput = false) {
    return authenticated && available && !revoked && !stopped && !pendingAction && !humanAction && !humanEnding &&
      (!(pendingDialog || pendingFileChooser) || releasingHeldInput) &&
      humanAdmitted && human?.state === "active" && human.leaseId === humanOwner && decodedHuman?.leaseId === humanOwner &&
      human.generation > retiredHumanGeneration && human.generation > 0 && human.viewport?.width > 0 && human.viewport?.height > 0 &&
      decodedHuman.generation === human.generation && decodedHuman.tabId === human.tabId;
  }

  function clearHumanInput() {
    humanFiles.retire();
    retireClipboard();
    decodedHuman = null;
    awaitingHumanFrame = null;
    inputQueue.length = 0;
    pressedKeys.clear();
    clipboardKeys.clear();
    pressedButtons.clear();
    mouseHolds.clear();
    mouseClick = null;
    retireComposition(true);
    for (const pointerId of capturedPointers) {
      if (el.frame.hasPointerCapture(pointerId)) el.frame.releasePointerCapture(pointerId);
    }
    capturedPointers.clear();
  }

  function blockHuman() {
    humanEnding = true;
    clearHumanInput();
  }

  function suspendHumanGeneration() {
    const waiting = awaitingHumanFrame;
    clearHumanInput();
    // Retire the UI lane only. Original requests remain in pending until their
    // actual response or local deadline; their old tuple cannot affect a successor.
    humanInputId = null;
    humanSequence = acknowledgedSequence = 0;
    clearFrame();
    return waiting;
  }

  function currentInput(entry, id) {
    return humanInputId === id && entry.fields.leaseId === humanOwner &&
      entry.fields.generation === human?.generation && entry.fields.generation > retiredHumanGeneration;
  }

  function endHuman(message = "", retryCleanup = false, noticeKind = "error") {
    const leaseId = human?.leaseId || humanOwner;
    blockHuman(); // Revoke admission before awaiting any original input or cleanup receipt.
    if (message) error(message, noticeKind, leaseId);
    if (humanAdmitted && leaseId === humanOwner && (!humanEndAttempted || retryCleanup) && humanAction !== "humanEnd" && pendingAction !== "stop" && authenticated && !stopped) {
      humanEndAttempted = true;
      return send("humanEnd", { leaseId });
    }
    render();
  }

  function error(message = "", kind = "error", leaseId = "") {
    // Release progress cannot replace an operation whose outcome is unknown.
    if (kind === "human-release" && displayedNotice?.kind === "error") return;
    displayedNotice = message ? { kind, leaseId, humanEpoch } : null;
    el.error.textContent = message;
    el.error.hidden = !message;
  }

  function render() {
    const state = stopped ? "stopped" : pendingAction === "stop" ? "stopping" : pendingAction === "pause" ? "pausing" : !available ? "unknown" : status.state === "paused" && !viewerCleanupComplete ? "error" : status.state;
    const descriptions = {
      running: ["正在运行", "Agent 可以操作其已分配的标签页。"],
      pausing: ["正在暂停", "已请求阻止新操作，正在等待控制释放确认。"],
      paused: ["已暂停", "Agent 操作已阻止；已交付结果可独立查看或操作。"],
      error: ["暂停未完成", "Agent 操作仍被阻止，请重试暂停以完成控制释放。"],
      unknown: ["状态未确认", "请刷新状态后再操作；浏览器连接失联时仍可停止会话。"],
      stopping: ["正在停止", "正在等待独立浏览器及其进程退出的确认。"],
      stopped: ["会话已停止", "已收到独立浏览器停止完成的确认。"]
    };
    const [label, detail] = descriptions[state];
    el.state.textContent = available && human?.state === "active" && !humanEnding ? "人工接管中" : label;
    el.detail.textContent = available && human?.state === "active" && !humanEnding ? "Agent 已暂停；人工控制只作用于当前接管的页面。" : detail;
    el.indicator.className = "indicator " + state;
    el.connection.textContent = stopped ? "已结束" : authenticated ? (available ? "已连接" : "控制状态不可用") : connected ? "正在验证" : "未连接";
    el.refresh.disabled = !authenticated || stopped || Boolean(pendingAction);
    const canResume = available && status.state === "paused" && status.cleanupComplete && viewerCleanupComplete;
    const retry = available && (status.state === "error" || status.state === "paused" && (!status.cleanupComplete || !viewerCleanupComplete));
    el.control.textContent = pendingAction === "pause" ? "正在暂停…" : pendingAction === "resume" ? "正在继续…" : canResume ? "继续操作" : retry ? "重试暂停" : "暂停操作";
    el.control.disabled = !authenticated || !available || stopped || Boolean(pageSwitch) || Boolean(pendingAction) || Boolean(humanAction) || Boolean(humanOwner) || Boolean(humanReserved()) || status.state === "pausing";
    el.stop.disabled = !authenticated || stopped || pendingAction === "stop";
    if (pendingAction === "stop") el.stop.textContent = "正在停止…";
    else el.stop.textContent = "停止会话";
    el.tabs.disabled = !authenticated || !available || !userControlReady() || Boolean(pendingAction) || Boolean(humanAction) || Boolean(humanReserved()) || pendingSelectId !== null || stopped || pageSwitch?.phase === "ending";
    el.watch.disabled = el.tabs.disabled || selected === null || watching !== selected && !canUseTab(selectedTab(), "watchable");
    el.watch.textContent = pendingSelectId !== null ? "正在确认…" : watching === selected && selected !== null ? "停止查看" : "开始查看";
    el["human-begin"].disabled = el.tabs.disabled || !canUseTab(selectedTab(), "takeover");
    el["human-begin"].textContent = selectedTab()?.kind === "result" ? "操作结果页" : "接管此页";
    el["human-begin"].hidden = Boolean(humanReserved()) || Boolean(humanAction) || Boolean(humanOwner);
    el["human-end"].hidden = !humanReserved() && !humanAction && !humanOwner;
    el["human-end"].disabled = !authenticated || stopped || pendingAction === "stop" || !humanAdmitted || !humanOwner || humanAction === "humanEnd";
    el["human-end"].textContent = humanAction === "humanEnd" || human?.state === "releasing" ? "正在释放接管…" : "完成接管";
    el["human-switch"].hidden = pageSelectionVersion !== 1 || !humanOwner && !pageSwitch;
    el["human-switch"].disabled = !authenticated || !available || stopped || Boolean(pendingAction) ||
      Boolean(pageSwitch && pageSwitch.phase !== "choosing") || !pageSwitch && (!humanAdmitted || humanEnding || Boolean(humanAction));
    el["human-switch"].textContent = pageSwitch?.phase === "ending" ? "正在释放原页面…" : pageSwitch?.phase === "selecting" ? "正在切换…" : pageSwitch?.phase === "choosing" ? "取消切换" : "切换页面";
    const ready = humanReady();
    el.frame.dataset.interactive = String(ready);
    // Retire before disabling: native focus changes may finish a composition.
    if (!ready) retireComposition();
    else positionHumanInput();
    el["human-input"].disabled = !ready;
    el["human-input"].dataset.enabled = String(ready);
    el["human-input"].dataset.pending = String(inputQueue.length + (humanInputId === null ? 0 : 1));
    el["human-input"].dataset.sequence = String(humanSequence);
    el["human-input"].dataset.acknowledgedSequence = String(acknowledgedSequence);
    el["human-status"].hidden = !humanReserved() && !humanAction && !humanOwner && !pageSwitch;
    el["human-status"].textContent = humanAction === "humanBegin" || human?.state === "starting" ? "正在暂停 Agent 并等待原控制释放…" : humanEnding || human?.state === "releasing" ? "人工输入已禁用，正在等待释放确认；不会重试网页操作。" : human?.state === "error" ? "人工控制未完成释放。请完成接管或停止会话；Agent 保持暂停。" : human?.state === "navigating" || human && human.generation <= retiredHumanGeneration ? "页面正在跳转，输入已暂停；等待新画面后可继续，旧输入不会重放。" : ready ? "你正在操作 · 点击画面后输入；切换查看窗口会结束接管。完成后 Agent 仍保持暂停。" : "你正在接管 · 等待当前画面解码，暂不接收输入。";
    if (pendingDialog && !humanEnding) el["human-status"].textContent = "网页弹窗等待处理，页面输入暂时暂停；Agent 保持暂停。";
    if (pendingFileChooser && !humanEnding) el["human-status"].textContent = "网页等待选择文件，页面输入暂时暂停；Agent 保持暂停。";
    if (pageSwitch?.phase === "choosing") el["human-status"].textContent = "原页面已释放。请在上方选择要接管的页面；Agent 保持暂停。";
    renderClipboard();
    renderDialog();
    humanFiles.update(Boolean(authenticated && available && !revoked && !stopped && !pendingAction && !humanAction && !humanEnding && !pendingDialog &&
      humanAdmitted && admittedHumanState(human) && human.leaseId === humanOwner && pendingFileChooser),
    !pressedKeys.size && !pressedButtons.size && !inputQueue.length && humanInputId === null);
    freshness();
  }

  function freshness() {
    if (!lastFrameAt) { el.freshness.textContent = "尚无画面"; return; }
    const seconds = Math.max(0, Math.floor((Date.now() - lastFrameAt) / 1000));
    const humanLive = human?.state === "active" && !humanEnding && decodedHuman?.leaseId === human.leaseId;
    const viewLive = view?.state === "active" && userControlReady() && el.frame.dataset.controlMode === "user-view" && el.frame.dataset.viewLeaseId === view.leaseId && Number(el.frame.dataset.generation) === view.generation;
    const frozen = !available || stopped || (!humanLive && !viewLive && (status?.state !== "running" || selected === null || (watching !== selected && pendingSelectTab !== selected)));
    el.freshness.textContent = (frozen ? "保留画面 · " : seconds < 3 ? "实时 · " : "等待更新 · ") + (seconds < 1 ? "刚刚" : `${seconds} 秒前`);
  }

  function clearFrame() {
    imageGeneration++;
    pendingFrame = null;
    awaitingSelectionFrame = null;
    awaitingViewFrame = null;
    decodedHuman = null;
    if (imageURL) URL.revokeObjectURL(imageURL);
    imageURL = null;
    el.frame.removeAttribute("src");
    el.frame.hidden = true;
    el.placeholder.hidden = false;
    el.dimensions.textContent = "";
    lastFrameAt = 0;
    stream = "";
    frameSequence = -1;
  }

  function renderTabs() {
    const options = [new Option("选择标签页", "")];
    for (const tab of tabs) options.push(new Option((tab.kind === "result" ? "已交付结果 · " : tab.kind === "browser" ? "浏览器页面 · " : "") + (tab.title || tab.url || `标签页 ${tab.id}`), String(tab.id)));
    el.tabs.replaceChildren(...options);
    el.tabs.value = selected === null ? "" : String(selected);
    const tab = tabs.find(t => t.id === selected);
    el["page-title"].textContent = tab ? `${tab.title || "未命名标签页"} · ${tab.url || ""}` : lastFrameAt ? `最后画面 · ${lastFrameTitle}` : "未选择标签页";
  }

  function acceptState(value, responseId = 0) {
    if (revoked) return;
    const next = value?.status;
    if (!next || !["running", "pausing", "paused", "error"].includes(next.state) || !Number.isSafeInteger(next.revision) || typeof value.workerBootId !== "string" || typeof value.viewerCleanupComplete !== "boolean" || !Number.isSafeInteger(value.eventSequence) || value.eventSequence < 0) throw new Error("状态格式无效。");
    if (worker && worker !== value.workerBootId) throw new Error("浏览器控制身份已改变，请获取新的查看链接。");
    retireThrough(value.retiredSequence);
    if (value.eventSequence < retiredSequence) return;
    if (value.eventSequence < controlSequence || status && next.revision < status.revision || responseId && responseId < appliedId) return;
    if (Object.hasOwn(value, "pageSelectionVersion") && value.pageSelectionVersion !== 1 ||
        pageSelectionKnown && value.pageSelectionVersion !== pageSelectionVersion) throw new Error("原查看连接的页面选择能力发生变化。请获取新的查看链接。");
    pageSelectionKnown = true; pageSelectionVersion = value.pageSelectionVersion;
    const nextHuman = value.human ?? null;
    if (nextHuman && Object.hasOwn(nextHuman, "inputBudgetVersion") && nextHuman.inputBudgetVersion !== 1) throw new Error("人工等待预算版本无效。");
    if (human && nextHuman?.leaseId === human.leaseId && nextHuman.inputBudgetVersion !== human.inputBudgetVersion) throw new Error("原人工接管的等待预算发生变化。");
    if (nextHuman && Object.hasOwn(nextHuman, "keyRepeatVersion") && nextHuman.keyRepeatVersion !== 1) throw new Error("人工重复按键版本无效。");
    if (human && nextHuman?.leaseId === human.leaseId && nextHuman.keyRepeatVersion !== human.keyRepeatVersion) throw new Error("原人工接管的重复按键能力发生变化。");
    if (nextHuman && Object.hasOwn(nextHuman, "printableKeyVersion") && nextHuman.printableKeyVersion !== 1) throw new Error("人工字符按键版本无效。");
    if (human && nextHuman?.leaseId === human.leaseId && nextHuman.printableKeyVersion !== human.printableKeyVersion) throw new Error("原人工接管的字符按键能力发生变化。");
    if (nextHuman && Object.hasOwn(nextHuman, "pointerClickCountVersion") && nextHuman.pointerClickCountVersion !== 1) throw new Error("人工多击版本无效。");
    if (human && nextHuman?.leaseId === human.leaseId && nextHuman.pointerClickCountVersion !== human.pointerClickCountVersion) throw new Error("原人工接管的多击能力发生变化。");
    if (nextHuman && Object.hasOwn(nextHuman, "clipboardTransferVersion") && nextHuman.clipboardTransferVersion !== 1) throw new Error("人工剪贴板传输版本无效。");
    if (human && nextHuman?.leaseId === human.leaseId && nextHuman.clipboardTransferVersion !== human.clipboardTransferVersion) throw new Error("原人工接管的剪贴板传输能力发生变化。");
    if (nextHuman && Object.hasOwn(nextHuman, "fileChooserVersion") && ![1, 2].includes(nextHuman.fileChooserVersion)) throw new Error("人工文件选择版本无效。");
    if (human && nextHuman?.leaseId === human.leaseId && nextHuman.fileChooserVersion !== human.fileChooserVersion) throw new Error("原人工接管的文件选择能力发生变化。");
    const nextChooser = value.pendingFileChooser ?? null;
    if (!ManagedHumanFiles.validPending(nextChooser, nextHuman)) throw new Error("文件选择请求身份无效。");
    const nextDialog = value.pendingDialog ?? null;
    if (!validDialog(nextDialog, nextHuman)) throw new Error("网页弹窗身份无效。");
    const nextView = value.view ?? null, nextTabs = normalizedTabs(value.tabs, next);
    if (nextView && Object.hasOwn(nextView, "inputBudgetVersion")) throw new Error("只读查看不能声明人工等待预算。");
    if (nextView && Object.hasOwn(nextView, "keyRepeatVersion")) throw new Error("只读查看不能声明人工重复按键。");
    if (nextView && Object.hasOwn(nextView, "printableKeyVersion")) throw new Error("只读查看不能声明人工字符按键。");
    if (nextView && Object.hasOwn(nextView, "pointerClickCountVersion")) throw new Error("只读查看不能声明人工多击。");
    if (nextView && Object.hasOwn(nextView, "clipboardTransferVersion")) throw new Error("只读查看不能声明人工剪贴板传输。");
    if (nextView && Object.hasOwn(nextView, "fileChooserVersion")) throw new Error("只读查看不能声明人工文件选择。");
    if (!validView(nextView) || nextView && nextHuman || nextView && (nextView.tabId !== value.selectedTabId || !nextTabs.some(tab => tab.id === nextView.tabId && tab.kind === "result"))) throw new Error("独立查看身份无效。");
    if (view && nextView && view.leaseId === nextView.leaseId && nextView.generation < view.generation) return;
    const waitingView = awaitingViewFrame;
    if (view && (!nextView || view.leaseId !== nextView.leaseId || view.generation !== nextView.generation || nextView.state !== "active") || !view && nextView) clearFrame();
    view = nextView;
    if (waitingView && view && waitingView.viewLeaseId === view.leaseId && waitingView.generation >= view.generation) awaitingViewFrame = waitingView;
    if (nextHuman && !validHuman(nextHuman)) throw new Error("人工控制状态格式无效。");
    if (humanAction === "humanBegin" && nextHuman && selected !== nextHuman.tabId) throw new Error("接管页面身份不匹配。");
    // Initial geometry (including legacy active/generation 0) is readiness,
    // not a successor document. It still cannot replace the Begin receipt.
    // Successor generations retire input without ending this lease.
    const initialGeometry = human && nextHuman && human.leaseId === nextHuman.leaseId && human.tabId === nextHuman.tabId &&
      human.generation === 0 && !decodedHuman && humanSequence === 0 && !humanEnding &&
      ["starting", "preparing", "active"].includes(human.state) && ["starting", "preparing", "active"].includes(nextHuman.state);
    const geometryChanged = human && nextHuman && (human.generation !== nextHuman.generation ||
      human.viewport?.width !== nextHuman.viewport?.width || human.viewport?.height !== nextHuman.viewport?.height);
    const sameHuman = human && nextHuman && human.leaseId === nextHuman.leaseId && human.tabId === nextHuman.tabId;
    if (sameHuman && nextHuman.generation < human.generation) return;
    rememberDialogSource(nextDialog);
    const navigation = sameHuman && !humanEnding && ["starting", "preparing", "active", "navigating"].includes(human.state) &&
      ["preparing", "active", "navigating"].includes(nextHuman.state) && !initialGeometry &&
      (nextHuman.generation > human.generation || nextHuman.state === "navigating");
    const firstGeometryReady = sameHuman && (["preparing", "navigating"].includes(human.state) || !humanAdmitted && human.state === "starting") &&
      human.viewport === null && nextHuman.state === "active" && nextHuman.generation === human.generation;
    if (navigation) {
      const waiting = suspendHumanGeneration();
      retiredHumanGeneration = Math.max(retiredHumanGeneration, nextHuman.generation - 1);
      if (waiting?.humanLeaseId === nextHuman.leaseId && waiting.tabId === nextHuman.tabId && waiting.generation >= nextHuman.generation)
        awaitingHumanFrame = waiting;
    } else if (human && (!nextHuman || !sameHuman || geometryChanged && !initialGeometry && !firstGeometryReady || human.state === "active" && nextHuman.state !== "active" || ["releasing", "released", "error"].includes(nextHuman.state))) {
      blockHuman();
      imageGeneration++;
      pendingFrame = null;
    }
    human = nextHuman;
    pendingDialog = nextDialog;
    pendingFileChooser = nextChooser;
    if (nextDialog || nextChooser) {
      mouseClick = null;
      for (const hold of mouseHolds.values()) hold.chorded = true;
    }
    humanFiles.accept(nextChooser);
    if (nextChooser) {
      // A chooser may open on down. Only original releases may follow; queued
      // moves have no remaining destination, and other queued actions require End.
      for (let index = inputQueue.length - 1; index >= 0; index--)
        if (inputQueue[index].type === "pointer" && inputQueue[index].action === "move") inputQueue.splice(index, 1);
      if (inputQueue.some(input => !["pointer", "key"].includes(input.type) || input.action !== "up"))
        endHuman("文件选择已打开，先前尚未发送的输入已取消；正在释放接管。");
    }
    if (humanAction === "humanBegin" && human && !humanOwner) {
      humanOwner = human.leaseId;
      // Blur can precede Begin's lease. Bind its progress only at the original
      // admission; a cleanup receipt or a later lease cannot supply this identity.
      if (displayedNotice?.kind === "human-release" && !displayedNotice.leaseId && displayedNotice.humanEpoch === humanEpoch) displayedNotice.leaseId = humanOwner;
    }
    if (humanOwner && human?.state !== "active" && value.humanCleanup?.leaseId === humanOwner && value.humanCleanup.cleanupConfirmed === true) {
      if (displayedNotice?.kind === "human-release" && displayedNotice.leaseId === humanOwner && displayedNotice.humanEpoch === humanEpoch) error();
      // A confirmed End joins native input too, including a reply whose local
      // timeout expired. Only this receipt may clear that outstanding marker.
      humanInputId = null;
      humanOwner = "";
      humanAdmitted = false;
      humanAction = null;
      humanEpoch++; // All original Begin/Input/End callbacks are now retired.
    }
    controlSequence = value.eventSequence;
    if (!humanReserved() && humanAction !== "humanBegin" && !view && (next.state !== "running" || value.selectedTabId === null)) retireThrough(Math.max(retiredSequence, value.eventSequence));
    if (view && view.state !== "active") retireThrough(Math.max(retiredSequence, value.eventSequence));
    if (responseId) appliedId = responseId;
    worker = value.workerBootId;
    if (next.state !== "running" && human?.state !== "active" && view?.state !== "active") { imageGeneration++; pendingFrame = null; }
    status = next;
    viewerCleanupComplete = value.viewerCleanupComplete;
    tabs = nextTabs;
    watching = value.selectedTabId ?? null;
    available = true;
    if (!selectedOnce) {
      selected = value.selectedTabId ?? null;
      selectedDeliveryId = tabs.find(tab => tab.id === selected)?.deliveryId || "";
      selectedPageSelectionId = tabs.find(tab => tab.id === selected)?.pageSelectionId || "";
      selectedOnce = true;
    }
    // A status may announce promotion before its original response. Preserve
    // the pending choice, but do not adopt the new delivery or enable Begin.
    const awaitingChoice = [...pending.values()].some(entry => ["select", "humanBegin"].includes(entry.operation) && entry.fields.tabId === selected && entry.fields.pageSelectionId === selectedPageSelectionId && selectedPageSelectionId);
    const deliveryChanged = !awaitingChoice && selected !== null && tabs.some(t => t.id === selected && ((t.deliveryId || "") !== selectedDeliveryId || (t.pageSelectionId || "") !== selectedPageSelectionId));
    if (selected !== null && (!tabs.some(t => t.id === selected) && human?.tabId !== selected && humanAction !== "humanBegin" || deliveryChanged)) {
      if (pageSwitch?.phase === "selecting") pageSwitch = null;
      selected = null;
      selectedDeliveryId = selectedPageSelectionId = ""; selectionEpoch++;
      pendingSelectId = pendingSelectTab = null;
      if (deliveryChanged) clearFrame();
      else { imageGeneration++; pendingFrame = null; }
    }
    renderTabs();
    render();
    const waiting = awaitingSelectionFrame;
    awaitingSelectionFrame = null;
    if (waiting && watching === waiting.tabId) frame(waiting);
    const waitingHuman = awaitingHumanFrame;
    awaitingHumanFrame = null;
    if (waitingHuman) frame(waitingHuman);
    const waitingReadOnly = awaitingViewFrame;
    awaitingViewFrame = null;
    if (waitingReadOnly) frame(waitingReadOnly);
    if (humanEnding && humanAdmitted && admittedHumanState(human) && !humanEndAttempted) endHuman();
    drainInput();
  }

  function retireThrough(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("画面退役状态无效。");
    if (sequence <= retiredSequence) return;
    retiredSequence = sequence;
    imageGeneration++;
    pendingFrame = null;
    if (decodedHuman && Number(el.frame.dataset.eventSequence) <= sequence) decodedHuman = null;
  }

  function send(operation, fields = {}, completion = null) {
    if (!authenticated || ws.readyState !== WebSocket.OPEN) return;
    const id = ++nextId;
    // Only the native owner accounts modal time. This immutable outer watchdog
    // cannot be extended by repeated state, a successor dialog or a new lease.
    const budgetedInput = operation === "humanInput" && human?.state === "active" && human.inputBudgetVersion === 1 &&
      fields.leaseId === humanOwner && fields.leaseId === human.leaseId && fields.generation === human.generation;
    const timeout = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (pageSwitch && (pageSwitch.endId === id || pageSwitch.selectId === id)) pageSwitch = null;
      entry.completion?.reject(new Error("Original command confirmation timed out"));
      if (entry.generationRetired || entry.selectionEpoch !== undefined && entry.selectionEpoch !== selectionEpoch || entry.humanEpoch !== undefined && entry.humanEpoch !== humanEpoch || entry.operation === "humanInput" && !currentInput(entry, id)) return;
      if (pendingSelectId === id) { pendingSelectId = null; pendingSelectTab = null; }
      if (pendingAction === operation) pendingAction = null;
      if (humanAction === operation) humanAction = null;
      if (operation.startsWith("human")) endHuman("人工操作确认超时，输入已禁用；不会自动重试。请等待释放确认或停止会话。");
      available = false;
      error("等待确认超时，不能据此判断操作是否完成。请刷新状态；不会自动重试操作。");
      render();
    }, operation === "stop" ? 55000 : budgetedInput ? 340000 : 35000);
    pending.set(id, { operation, timeout, fields, completion, ...(operation.startsWith("human") ? { humanEpoch } : {}), ...(operation === "select" ? { selectionEpoch } : {}) });
    if (operation === "select") { pendingSelectId = id; pendingSelectTab = fields.tabId; }
    if (["pause", "resume", "stop"].includes(operation)) pendingAction = operation;
    if (["humanBegin", "humanEnd"].includes(operation)) humanAction = operation;
    ws.send(JSON.stringify({ id, operation, ...fields }));
    render();
    return id;
  }

  function validFrameScope(value) {
    if (!available || revoked || stopped || value.eventSequence <= retiredSequence) return false;
    if (value.controlMode === "human") return human?.state === "active" && !humanEnding && human.generation > retiredHumanGeneration && human.leaseId === value.humanLeaseId && human.generation === value.generation && human.tabId === value.tabId;
    if (value.controlMode === "user-view") return !humanReserved() && !humanAction && userControlReady() && view?.state === "active" && view.leaseId === value.viewLeaseId && view.generation === value.generation && view.tabId === value.tabId && selected === value.tabId && selectedTab()?.kind === "result";
    return !view && !humanReserved() && !humanAction && selectedTab()?.kind === "task" && status.state === "running" && selected === value.tabId && (watching === value.tabId || pendingSelectTab === value.tabId);
  }

  function frame(value) {
    retireThrough(value.retiredSequence);
    if (revoked || stopped || !Number.isSafeInteger(value.eventSequence) || value.eventSequence <= retiredSequence ||
      typeof value.data !== "string" || value.data.length > 4 * Math.ceil(4 * 1024 * 1024 / 3) || value.mimeType !== "image/png") return;
    if (value.controlMode === "user-view" && !humanReserved() && !humanAction && selectedTab()?.kind === "result" && selected === value.tabId &&
      Number.isSafeInteger(value.generation) && value.generation > 0 &&
      (!view && pendingSelectTab === value.tabId || view?.leaseId === value.viewLeaseId && (value.generation > view.generation || value.generation === view.generation && ["starting", "navigating"].includes(view.state)))) {
      if (!awaitingViewFrame || value.eventSequence > awaitingViewFrame.eventSequence) awaitingViewFrame = value;
      return;
    }
    if (value.controlMode === "human" && !humanEnding && Number.isSafeInteger(value.generation) && value.generation > retiredHumanGeneration && value.generation > 0 &&
        (humanAction === "humanBegin" && !human && selected === value.tabId ||
         human?.leaseId === value.humanLeaseId && human.tabId === value.tabId && ["starting", "preparing", "active", "navigating"].includes(human.state) &&
           (value.generation > human.generation || ["preparing", "navigating"].includes(human.state) && value.generation === human.generation))) {
      if (!awaitingHumanFrame || value.eventSequence > awaitingHumanFrame.eventSequence) awaitingHumanFrame = value;
      return;
    }
    if (available && !revoked && selected === value.tabId && value.eventSequence > retiredSequence && pendingSelectId !== null && watching !== value.tabId && pendingSelectTab !== value.tabId) {
      awaitingSelectionFrame = value;
      return;
    }
    if (!validFrameScope(value) || !Number.isSafeInteger(value.eventSequence) || value.eventSequence <= lastFrameEvent || typeof value.data !== "string" || value.data.length > 4 * Math.ceil(4 * 1024 * 1024 / 3) || value.mimeType !== "image/png") return;
    lastFrameEvent = value.eventSequence;
    if (stream === value.streamId && value.sequence <= frameSequence) return;
    stream = value.streamId;
    frameSequence = value.sequence;
    if (imageBusy) { pendingFrame = value; return; }
    decodeFrame(value);
  }

  function decodeFrame(value) {
    const decoded = atob(value.data);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    const nextURL = URL.createObjectURL(new Blob([bytes], { type: value.mimeType }));
    const generation = imageGeneration;
    imageBusy = true;
    const image = new Image();
    const finish = () => {
      imageBusy = false;
      const next = pendingFrame;
      pendingFrame = null;
      if (next && validFrameScope(next)) decodeFrame(next);
    };
    image.onload = () => {
      if (generation !== imageGeneration || !validFrameScope(value)) { URL.revokeObjectURL(nextURL); finish(); return; }
      if (imageURL) URL.revokeObjectURL(imageURL);
      imageURL = nextURL;
      el.frame.src = imageURL;
      el.frame.hidden = false;
      el.frame.dataset.streamId = value.streamId;
      el.frame.dataset.frameSequence = String(value.sequence);
      el.frame.dataset.eventSequence = String(value.eventSequence);
      el.frame.dataset.renderGeneration = String(generation);
      el.frame.dataset.capturedAt = String(value.metadata?.timestamp ?? "");
      el.frame.dataset.controlMode = value.controlMode || "observe";
      el.frame.dataset.humanLeaseId = value.controlMode === "human" ? value.humanLeaseId : "";
      el.frame.dataset.viewLeaseId = value.controlMode === "user-view" ? value.viewLeaseId : "";
      el.frame.dataset.generation = ["human", "user-view"].includes(value.controlMode) ? String(value.generation) : "";
      decodedHuman = value.controlMode === "human" ? { leaseId: value.humanLeaseId, generation: value.generation, tabId: value.tabId, width: image.naturalWidth, height: image.naturalHeight } : null;
      el.placeholder.hidden = true;
      el.dimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
      lastFrameAt = Date.now();
      const tab = tabs.find(t => t.id === value.tabId);
      lastFrameTitle = tab ? `${tab.title || "未命名标签页"} · ${tab.url || ""}` : `标签页 ${value.tabId}`;
      render();
      finish();
    };
    image.onerror = () => { URL.revokeObjectURL(nextURL); finish(); };
    image.src = nextURL;
  }

  function drainInput() {
    const release = pendingFileChooser && ["pointer", "key"].includes(inputQueue[0]?.type) && inputQueue[0].action === "up";
    if (!humanReady(Boolean(release)) || pendingDialog || humanInputId !== null || !inputQueue.length) return;
    const input = inputQueue.shift();
    humanInputId = send("humanInput", { leaseId: human.leaseId, generation: human.generation, sequence: ++humanSequence, input });
    const clipboard = clipboardInputs.get(input);
    if (clipboard) { clipboard.requestId = humanInputId; clipboard.sequence = humanSequence; }
    render();
  }

  function enqueueInput(input, releasingHeldInput = false) {
    if (!humanReady(releasingHeldInput)) return false;
    const previous = inputQueue.at(-1);
    // Only an unsent move may be replaced; button/key transitions and text are never replayed or dropped.
    if (input.type === "pointer" && input.action === "move" && previous?.type === "pointer" && previous.action === "move") inputQueue[inputQueue.length - 1] = input;
    else if (inputQueue.length >= maxQueuedInputs) { endHuman("人工输入队列已满，已停止接收输入并请求释放；未发送的操作不会重放。"); return false; }
    else inputQueue.push(input);
    drainInput();
    render();
    return true;
  }

  const modifiers = event => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  const buttons = ["left", "middle", "right"];
  function frameContentRect() {
    if (!decodedHuman?.width || !decodedHuman.height) return null;
    const rect = el.frame.getBoundingClientRect();
    const scale = Math.min(rect.width / decodedHuman.width, rect.height / decodedHuman.height);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const width = decodedHuman.width * scale, height = decodedHuman.height * scale;
    const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
    return { width, height, left, top };
  }
  function retireComposition(clearAnchor = false) {
    printableCandidate = null;
    composing = false;
    compositionScope = null;
    el["human-input"].dataset.composing = "false";
    el["human-input"].value = "";
    if (clearAnchor) {
      inputAnchor = null;
      Object.assign(el["human-input"].style, { left: "0px", top: "0px", width: "1px", height: "1px" });
    } else positionHumanInput();
  }
  function positionHumanInput() {
    const content = frameContentRect();
    if (!content) return;
    const screen = el.screen.getBoundingClientRect();
    if (![screen.left, screen.top, screen.width, screen.height].every(Number.isFinite) || screen.width <= 0 || screen.height <= 0) return;
    const visibleLeft = Math.max(screen.left, 0), visibleTop = Math.max(screen.top, 0);
    const visibleWidth = Math.min(screen.left + screen.width, window.innerWidth) - visibleLeft;
    const visibleHeight = Math.min(screen.top + screen.height, window.innerHeight) - visibleTop;
    if (![visibleWidth, visibleHeight].every(value => Number.isFinite(value) && value > 0)) return;
    const anchor = inputAnchor?.leaseId === human?.leaseId && inputAnchor?.generation === human?.generation ? inputAnchor : null;
    const padding = Math.min(8, visibleWidth / 4, visibleHeight / 4);
    const width = Math.min(composing ? 280 : 1, visibleWidth - padding * 2);
    const height = Math.min(composing ? 48 : 1, visibleHeight - padding * 2);
    const minimumX = visibleLeft - screen.left + padding, minimumY = visibleTop - screen.top + padding;
    // This is the last admitted click, not a claim about the remote caret.
    const x = content.left - screen.left + (anchor?.x ?? 0) * content.width;
    const y = content.top - screen.top + (anchor?.y ?? 0) * content.height;
    Object.assign(el["human-input"].style, {
      left: `${Math.min(Math.max(minimumX, x), minimumX + visibleWidth - width - padding * 2)}px`,
      top: `${Math.min(Math.max(minimumY, y), minimumY + visibleHeight - height - padding * 2)}px`,
      width: `${width}px`, height: `${height}px`
    });
  }
  function anchorHumanInput(position) {
    // Retire the old local preedit before another remote field can receive focus.
    retireComposition();
    inputAnchor = { leaseId: human.leaseId, generation: human.generation,
      x: position.x / human.viewport.width, y: position.y / human.viewport.height };
    positionHumanInput();
  }
  function point(event, releasingHeldInput = false) {
    if (!humanReady(releasingHeldInput) || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    const content = frameContentRect();
    if (!content) return null;
    const { left, top, width, height } = content;
    if (event.clientX < left || event.clientX >= left + width || event.clientY < top || event.clientY >= top + height) return null;
    return { x: (event.clientX - left) * human.viewport.width / width, y: (event.clientY - top) * human.viewport.height / height };
  }

  function pointer(event, action) {
    if (human?.pointerClickCountVersion === 1) {
      // PointerEvent.detail is zero. Cancelling a mouse pointerdown would also
      // suppress the real mousedown carrying the browser's click count.
      if (event.isTrusted === true && event.pointerType && event.pointerType !== "mouse" && humanReady()) {
        event.preventDefault();
        endHuman("当前接管仅支持鼠标输入；已请求释放控制。");
      }
      return;
    }
    const button = buttons[event.button];
    const releasingHeldInput = Boolean(pendingDialog || pendingFileChooser) && action === "up" && pressedButtons.has(button);
    if (!humanReady(releasingHeldInput)) return;
    if (event.pointerType && event.pointerType !== "mouse") { endHuman("当前接管仅支持鼠标输入；已请求释放控制。"); return; }
    const position = point(event, releasingHeldInput);
    if (!position) { if (pressedButtons.size) endHuman("指针已离开当前画面，正在释放按键和人工控制。", false, "human-release"); return; }
    if (action !== "move" && !button) return;
    event.preventDefault();
    if (action === "down") {
      if (pressedButtons.has(button)) return;
      anchorHumanInput(position);
      el["human-input"].focus({ preventScroll: true });
      pressedButtons.add(button);
      el.frame.setPointerCapture(event.pointerId);
      capturedPointers.add(event.pointerId);
    } else if (action === "up") {
      if (!pressedButtons.delete(button)) return;
    }
    // A dialog may be opened by the original down. Retain its real up, but
    // drainInput will not dispatch it until the dialog and prior ACK settle.
    enqueueInput({ type: "pointer", action, ...position, ...(action === "move" ? {} : { button }), modifiers: modifiers(event) }, releasingHeldInput);
    if (action === "up" && !pressedButtons.size) {
      if (el.frame.hasPointerCapture(event.pointerId)) el.frame.releasePointerCapture(event.pointerId);
      capturedPointers.delete(event.pointerId);
    }
  }

  function mouseInput(event, action) {
    if (human?.pointerClickCountVersion !== 1 || event.isTrusted !== true) return;
    const button = buttons[event.button], hold = mouseHolds.get(button);
    const releasing = action === "up" && Boolean(hold) && Boolean(pendingDialog || pendingFileChooser);
    if (!humanReady(releasing)) return;
    // Window listeners retain real releases outside the image, while unrelated
    // idle mouse movement cannot become input to the controlled page.
    if (action !== "down" && event.target !== el.frame && !pressedButtons.size) return;
    const position = point(event, releasing);
    if (!position) {
      if (pressedButtons.size) endHuman("指针已离开当前画面，正在释放按键和人工控制。", false, "human-release");
      return;
    }
    if (action !== "move" && !button) return;
    event.preventDefault();
    let clickCount;
    if (action === "down") {
      if (pressedButtons.has(button)) return;
      if (!Number.isInteger(event.detail) || event.detail < 1 || event.detail > 2147483647) {
        endHuman("无法确认本次鼠标点击次数，正在释放人工控制。"); return;
      }
      const chorded = pressedButtons.size > 0;
      if (chorded) for (const held of mouseHolds.values()) held.chorded = true;
      // Browser detail owns the time/distance threshold. Only a complete local
      // sequence within this admitted generation can continue its count.
      clickCount = !chorded && mouseClick?.button === button && event.detail === mouseClick.detail + 1
        ? mouseClick.count + 1 : 1;
      mouseClick = null;
      mouseHolds.set(button, { detail: event.detail, count: clickCount, chorded });
      pressedButtons.add(button);
      anchorHumanInput(position);
      el["human-input"].focus({ preventScroll: true });
    } else if (action === "up") {
      if (!hold || !pressedButtons.delete(button)) return;
      mouseHolds.delete(button);
      clickCount = hold.count;
      mouseClick = !hold.chorded && !pressedButtons.size && !pendingDialog && !pendingFileChooser
        ? { button, detail: hold.detail, count: hold.count } : null;
    }
    enqueueInput({ type: "pointer", action, ...position,
      ...(action === "move" ? {} : { button, clickCount }), modifiers: modifiers(event) }, releasing);
  }

  function leaveMouse(event, leftWindow = false) {
    // Disabling the image for an original dialog/chooser also changes hit
    // testing and can emit mouseleave without the pointer physically moving.
    if (human?.pointerClickCountVersion === 1 && event.isTrusted === true && pressedButtons.size &&
        (leftWindow || !point(event, true)))
      endHuman("指针已离开当前画面，正在释放按键和人工控制。", false, "human-release");
  }

  function committedText(text) {
    printableCandidate = null;
    el["human-input"].value = "";
    if (typeof text !== "string" || !text) return;
    if (text.length > 4096) { endHuman("一次输入过长，已请求释放；文字未发送。请分段输入。"); return; }
    enqueueInput({ type: "text", text });
  }

  function keyboard(event, action) {
    const nativePrintable = human?.printableKeyVersion === 1;
    if (nativePrintable && event.isTrusted !== true) return;
    if (action === "down" || printableCandidate?.code === event.code) printableCandidate = null;
    const heldRelease = action === "up" && pressedKeys.has(event.code);
    const releasingHeldInput = Boolean(pendingDialog || pendingFileChooser) && heldRelease;
    if (!humanReady(releasingHeldInput) || !heldRelease && (event.isComposing || composing || nativePrintable && event.keyCode === 229 || ["Dead", "Process", "Unidentified"].includes(event.key))) return;
    if (nativePrintable && !heldRelease && (event.target !== el["human-input"] || document.activeElement !== el["human-input"])) return;
    // The browser supplies local clipboard text through paste. Forwarding this
    // shortcut would instead ask the controlled browser to use its clipboard.
    // A key already sent to that browser still owns its original real release.
    const localPaste = !event.altKey && (event.keyCode === 86 && (event.ctrlKey || event.metaKey) ||
      event.keyCode === 45 && event.shiftKey && !event.ctrlKey && !event.metaKey);
    if (localPaste) {
      if (!pressedKeys.has(event.code)) {
        if (displayedNotice?.kind === "held-paste") error();
        return;
      }
      // Adding a modifier to an existing hold (e.g. Insert then Shift) must
      // not turn its repeat into a remote clipboard shortcut. Preserve the
      // original up; local text cannot commit through a nonmodifier hold.
      if (action === "down") {
        event.preventDefault();
        error("请先松开当前按键，再使用粘贴快捷键。", "held-paste", humanOwner);
        return;
      }
    }
    const shortcut = event.ctrlKey || event.altKey || event.metaKey;
    const printable = Array.from(event.key || "").length === 1;
    if (nativePrintable && !shortcut && !heldRelease && typeof event.key === "string" && event.key.isWellFormed() &&
        !printable && !namedDOMKeys.has(event.key)) {
      // A layout change during an existing hold cannot switch to insertText,
      // which would bypass that hold. Still wait for local confirmation in
      // case this down instead starts an IME composition.
      if (action === "down" && pressedKeys.has(event.code))
        printableCandidate = { leaseId: human.leaseId, generation: human.generation, code: event.code };
      return;
    }
    if (nativePrintable && printable && !shortcut && action === "down") {
      if (!event.code || !Number.isInteger(event.keyCode) || event.keyCode < 1 || event.keyCode > 255 || !nativeKeyText(event.key)) return;
      const repeat = event.repeat === true;
      const rejected = clipboardKeys.has(event.code) || (repeat ? !pressedKeys.has(event.code) || human.keyRepeatVersion !== 1 : pressedKeys.has(event.code));
      printableCandidate = { leaseId: human.leaseId, generation: human.generation, code: event.code, rejected,
        input: { type: "key", action: "down", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode,
          modifiers: modifiers(event), ...(repeat ? { repeat: true } : {}) } };
      // A local IME can start after this down. Only its real non-composition
      // beforeinput may confirm a printable key; never guess text on keyup.
      if (rejected) event.preventDefault();
      return;
    }
    if (printable && !shortcut && !pressedKeys.has(event.code)) return; // Committed text has exactly one path below.
    if (!event.code || !Number.isInteger(event.keyCode) || event.keyCode < 1 || event.keyCode > 255) return;
    event.preventDefault();
    if (action === "down" && clipboardKeys.has(event.code)) return;
    const transferKey = (event.code === "KeyC" && event.keyCode === 67 && event.key?.toLowerCase() === "c") ||
      (event.code === "KeyX" && event.keyCode === 88 && event.key?.toLowerCase() === "x");
    const transferShortcut = transferKey && [2, 4].includes(modifiers(event)) && human.clipboardTransferVersion === 1;
    let clipboard = null;
    if (action === "down" && transferShortcut) {
      // Repeats never become additional copy/cut operations; original up remains.
      if (event.repeat === true || pressedKeys.has(event.code)) return;
      clipboard = startClipboard(event.code === "KeyC" ? "copy" : "cut", event);
      if (!clipboard) return;
      clipboardKeys.add(event.code);
    }
    let repeat = false;
    if (action === "down") {
      if (event.repeat === true) {
        // A real repeat retains the original physical hold and gets its own
        // queued receipt. It cannot create a hold after navigation or End.
        if (!pressedKeys.has(event.code) || human.keyRepeatVersion !== 1) return;
        repeat = true;
      } else {
        if (pressedKeys.has(event.code)) return;
        pressedKeys.add(event.code);
      }
    } else {
      clipboardKeys.delete(event.code);
      if (!pressedKeys.delete(event.code)) return;
    }
    const input = { type: "key", action, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: modifiers(event), ...(repeat ? { repeat: true } : {}), ...(clipboard ? { clipboardTransfer: clipboard.operation } : {}) };
    if (clipboard) clipboardInputs.set(input, clipboard);
    if (!enqueueInput(input, releasingHeldInput) && clipboard) retireClipboard();
  }

  function nativeKeyText(text) {
    // Chromium reserves one of four UTF-16 units for NUL. Never truncate a
    // layout result or manufacture a scalar key from a multi-scalar value.
    return typeof text === "string" && text.length > 0 && text.length <= 3 && text.isWellFormed() &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(text);
  }

  function beginSelectedHuman() {
    if (el["human-begin"].disabled) return;
    humanEpoch++;
    error(); clearFrame();
    human = null; humanOwner = ""; humanEnding = humanEndAttempted = composing = false;
    humanAdmitted = false;
    pendingDialog = null; displayedDialog = claimedDialog = "";
    pendingFileChooser = null; humanFiles.reset();
    dialogSources.clear();
    retiredHumanGeneration = -1;
    retireComposition(true);
    humanSequence = acknowledgedSequence = 0;
    inputQueue.length = 0; humanInputId = null;
    send("humanBegin", selectionFields());
  }
  el["human-begin"].addEventListener("click", beginSelectedHuman);
  el["human-end"].addEventListener("click", () => { if (!el["human-end"].disabled) { pageSwitch = null; endHuman("", true); } });
  // Keep the keyboard sink focused until the explicit click starts End. Its
  // normal blur guard remains unchanged for every other destination.
  for (const id of ["human-end", "human-switch", "stop"])
    el[id].addEventListener("mousedown", event => event.preventDefault());
  el["human-switch"].addEventListener("click", () => {
    if (el["human-switch"].disabled) return;
    if (pageSwitch) { pageSwitch = null; render(); return; }
    const original = { phase: "ending", leaseId: humanOwner, endId: null };
    pageSwitch = original;
    original.endId = endHuman();
    if (original.endId === undefined) pageSwitch = null;
    render();
  });
  el["dialog-accept"].addEventListener("click", () => respondDialog(true));
  el["dialog-cancel"].addEventListener("click", () => respondDialog(false));
  for (const action of ["down", "move", "up"]) el.frame.addEventListener(`pointer${action}`, event => pointer(event, action));
  el.frame.addEventListener("pointercancel", event => {
    if (pressedButtons.size && (human?.pointerClickCountVersion !== 1 || event.isTrusted === true))
      endHuman("指针控制已中断，正在释放人工控制。", false, "human-release");
  });
  el.frame.addEventListener("lostpointercapture", () => {
    if (human?.pointerClickCountVersion !== 1 && pressedButtons.size)
      endHuman("指针控制已中断，正在释放人工控制。", false, "human-release");
  });
  el.frame.addEventListener("mousedown", event => mouseInput(event, "down"));
  window.addEventListener("mousemove", event => mouseInput(event, "move"), true);
  window.addEventListener("mouseup", event => mouseInput(event, "up"), true);
  el.frame.addEventListener("mouseleave", leaveMouse);
  window.addEventListener("mouseout", event => { if (event.relatedTarget === null) leaveMouse(event, true); }, true);
  el.frame.addEventListener("contextmenu", event => { if (humanReady()) event.preventDefault(); });
  el.frame.addEventListener("wheel", event => {
    const position = point(event);
    if (!position) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? human.viewport.height : 1;
    const deltaX = event.deltaX * unit, deltaY = event.deltaY * unit;
    if (Number.isFinite(deltaX) && Number.isFinite(deltaY)) enqueueInput({ type: "wheel", ...position, deltaX, deltaY, modifiers: modifiers(event) });
  }, { passive: false });
  el["human-input"].addEventListener("keydown", event => keyboard(event, "down"));
  el["human-input"].addEventListener("keyup", event => keyboard(event, "up"));
  // Disabling the page textarea moves real DOM focus to the dialog card. The
  // original held key's release must still be observed there, once, before
  // ordinary textarea handlers. No new keydown is admitted through this path.
  window.addEventListener("keyup", event => {
    if ((pendingDialog || pendingFileChooser) && pressedKeys.has(event.code)) keyboard(event, "up");
  }, true);
  el["human-input"].addEventListener("paste", event => {
    event.preventDefault();
    if (!humanReady() || composing) return;
    // Read only this original event's plain text, synchronously. Never retain
    // its DataTransfer or perform a later navigator.clipboard read.
    const text = event.clipboardData?.getData("text/plain");
    if (typeof text === "string" && (!text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))) {
      el["human-input"].value = "";
      error("粘贴内容含不支持的字符，文字未发送。请检查后重新粘贴。");
      return;
    }
    committedText(text);
  });
  el["human-input"].addEventListener("beforeinput", event => {
    const nativePrintable = human?.printableKeyVersion === 1;
    if (nativePrintable && (event.isTrusted !== true || event.target !== el["human-input"] || document.activeElement !== el["human-input"])) return;
    if (!humanReady() || event.isComposing || composing || /Composition/.test(event.inputType)) return;
    event.preventDefault();
    const candidate = printableCandidate;
    if (candidate && (candidate.leaseId !== human.leaseId || candidate.generation !== human.generation)) { printableCandidate = null; return; }
    if (candidate?.rejected) return;
    printableCandidate = null;
    if (!["insertText", "insertReplacementText"].includes(event.inputType)) return;
    const text = event.data ?? event.dataTransfer?.getData("text/plain");
    if (candidate?.input && event.inputType === "insertText" && nativeKeyText(text)) {
      el["human-input"].value = "";
      if (enqueueInput({ ...candidate.input, text })) pressedKeys.add(candidate.code);
      return;
    }
    if (candidate && pressedKeys.has(candidate.code)) {
      endHuman("当前按键产生的文字超出原生按键限制，已请求释放；本次文字未发送。"); return;
    }
    committedText(text);
  });
  el["human-input"].addEventListener("compositionstart", () => {
    printableCandidate = null;
    composing = humanReady();
    compositionScope = composing ? { leaseId: human.leaseId, generation: human.generation } : null;
    el["human-input"].dataset.composing = String(composing);
    positionHumanInput();
  });
  el["human-input"].addEventListener("compositionend", event => {
    const current = composing && compositionScope?.leaseId === human?.leaseId && compositionScope?.generation === human?.generation;
    retireComposition();
    if (current && humanReady()) committedText(event.data);
  });
  window.addEventListener("resize", positionHumanInput);
  window.addEventListener("scroll", positionHumanInput, true);
  el["human-input"].addEventListener("blur", () => {
    // Navigating disables this focused textarea. That local blur is not a user
    // request to terminate the lease; window blur/End/Stop remain independent.
    if (humanReady())
      endHuman("输入区域已失焦，正在释放人工控制；Agent 保持暂停。", false, "human-release");
  });
  window.addEventListener("blur", () => { pageSwitch = null; if ((humanReserved() || humanAction === "humanBegin") && !humanEnding && !humanFiles.pickerActive()) endHuman("查看窗口已失焦，正在释放人工控制；Agent 保持暂停。", false, "human-release"); render(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pageSwitch = null; if (document.hidden && (humanReserved() || humanAction === "humanBegin") && !humanEnding) endHuman("查看窗口已隐藏，正在释放人工控制；Agent 保持暂停。", false, "human-release"); render(); });

  el.refresh.addEventListener("click", () => { error(); send("status"); });
  el.control.addEventListener("click", () => {
    if (el.control.disabled) return;
    error();
    if (status.state === "paused" && status.cleanupComplete && viewerCleanupComplete) send("resume", { expectedRevision: status.revision, expectedWorkerBootId: worker });
    else send("pause");
  });
  el.stop.addEventListener("click", () => { if (!el.stop.disabled) { pageSwitch = null; blockHuman(); error(); send("stop"); } });
  el.watch.addEventListener("click", () => {
    if (el.watch.disabled) return;
    error();
    selectionEpoch++;
    send("select", watching === selected ? { tabId: null } : selectionFields());
  });
  el.tabs.addEventListener("change", () => {
    if (el.tabs.disabled) return;
    selected = el.tabs.value === "" ? null : Number(el.tabs.value);
    selectedDeliveryId = tabs.find(tab => tab.id === selected)?.deliveryId || "";
    selectedPageSelectionId = tabs.find(tab => tab.id === selected)?.pageSelectionId || "";
    selectionEpoch++;
    selectedOnce = true;
    clearFrame();
    renderTabs();
    error();
    if (selected === null || canUseTab(selectedTab(), "watchable")) {
      const switching = pageSwitch?.phase === "choosing" && selected !== null;
      if (selected === null) pageSwitch = null;
      const fields = selectionFields(), id = send("select", fields);
      if (switching) pageSwitch = { phase: "selecting", selectId: id, tabId: selected, selectionEpoch };
      render();
    }
    else render();
  });

  render();
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    ticket = "";
    error("查看链接缺少有效的一次性凭据。请在终端运行 managed view，获取新的链接。");
    return;
  }
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener("open", () => {
    connected = true;
    ws.send(JSON.stringify({ type: "authenticate", token: ticket }));
    ticket = "";
    render();
  });
  ws.addEventListener("message", event => {
    try {
      const value = JSON.parse(event.data);
      if (value.type === "authenticated") {
        authenticated = true;
        send("status");
      } else if (value.type === "state") {
        acceptState(value);
      } else if (value.type === "frame") {
        frame(value);
      } else if (value.type === "clear") {
        if (!Number.isSafeInteger(value.eventSequence) || value.eventSequence < controlSequence) return;
        controlSequence = value.eventSequence;
        retireThrough(Math.max(value.eventSequence, value.retiredSequence));
        watching = null;
        view = null; awaitingViewFrame = null;
        pendingSelectTab = null;
        imageGeneration++;
        pendingFrame = null;
        awaitingSelectionFrame = null;
        if (humanReserved()) endHuman("当前接管画面已撤销，正在释放人工控制。", false, "human-release");
        render();
      } else if (value.type === "unavailable") {
        pageSwitch = null;
        available = false;
        revoked = true;
        imageGeneration++;
        pendingFrame = null;
        awaitingSelectionFrame = null;
        pendingSelectTab = null;
        blockHuman();
        error("浏览器控制连接已断开；仍可停止会话。");
        render();
      } else if (value.type === "response") {
        const entry = pending.get(value.id);
        if (!entry) return;
        clearTimeout(entry.timeout);
        pending.delete(value.id);
        if (pageSwitch?.phase === "ending" && pageSwitch.endId === value.id) {
          const original = pageSwitch, cleanup = value.result?.humanCleanup;
          if (value.error || entry.operation !== "humanEnd" || cleanup?.leaseId !== original.leaseId || cleanup.cleanupConfirmed !== true ||
              value.result?.viewerCleanupComplete !== true || value.result.human != null || value.result.view != null) {
            pageSwitch = null; throw new Error("原页面释放未确认。");
          }
          // The matching response is required even when a coalesced state has
          // already retired its human epoch. No state can stand in for this ACK.
          acceptState(value.result, value.id);
          if (!available || revoked || stopped || humanReserved() || humanOwner || !viewerCleanupComplete || status?.state !== "paused" || !status.cleanupComplete) {
            pageSwitch = null; throw new Error("原页面释放状态已变化。");
          }
          pageSwitch = { phase: "choosing" }; render(); return;
        }
        if (entry.completion) {
          // File receipts settle their original promise even after End or
          // navigation. Their callback cannot revive the retired transfer.
          if (value.error) entry.completion.reject(new Error(value.error.message || "File command failed"));
          else {
            try { acceptState(value.result); entry.completion.resolve(value.result); }
            catch (error) { entry.completion.reject(error); throw error; }
          }
          render();
          return;
        }
        if (entry.generationRetired || entry.selectionEpoch !== undefined && entry.selectionEpoch !== selectionEpoch || entry.humanEpoch !== undefined && entry.humanEpoch !== humanEpoch) return;
        if (!value.error && ["select", "humanBegin"].includes(entry.operation)) {
          const receipt = value.result?.pageSelectionReceipt, choice = entry.fields.pageSelectionId;
          if (choice !== undefined) {
            if (pageSelectionVersion !== 1 || !receipt || Object.keys(receipt).sort().join(",") !== "deliveryId,pageSelectionId,retained,tabId" ||
                receipt.tabId !== entry.fields.tabId || receipt.pageSelectionId !== choice || !validSelectionId(receipt.deliveryId) || receipt.retained !== true)
              throw new Error("原页面保留回执不匹配。");
            if (selected === entry.fields.tabId && selectedPageSelectionId === choice) {
              selectedDeliveryId = receipt.deliveryId; selectedPageSelectionId = "";
            }
          } else if (receipt !== undefined) throw new Error("未请求的页面保留回执。");
        }
        if (pendingSelectId === value.id) { pendingSelectId = null; pendingSelectTab = null; }
        if (pendingAction === entry.operation) pendingAction = null;
        if (entry.operation === "humanInput") {
          const current = currentInput(entry, value.id);
          if (humanInputId === value.id) humanInputId = null;
          if (!current) { render(); return; } // A retired lease's receipt cannot drain a successor input lane.
        }
        if (value.error && entry.operation === "humanInput" && value.error.code === "HUMAN_GENERATION_STALE") {
          // This typed rejection proves the old input was never dispatched.
          // Wait for an authoritative successor state; never retry it.
          retiredHumanGeneration = Math.max(retiredHumanGeneration, entry.fields.generation);
          suspendHumanGeneration();
        } else if (value.error && entry.operation === "humanDialogRespond" && ["HUMAN_DIALOG_STALE", "HUMAN_DIALOG_INVALID"].includes(value.error.code)) {
          // These typed failures prove no decision was sent. Read current state
          // without replaying the choice or revoking an unrelated successor.
          if (value.error.code === "HUMAN_DIALOG_INVALID" && dialogKey(pendingDialog) === dialogKey(entry.fields)) claimedDialog = "";
          error(value.error.message || "网页弹窗已变化，请确认当前弹窗后再操作。");
          send("status");
        } else if (value.error) {
          pageSwitch = null;
          if (entry.operation.startsWith("human")) {
            if (humanAction === entry.operation) humanAction = null;
            endHuman(value.error.message || "人工操作结果未确认，已禁用输入并请求释放。");
          }
          available = false;
          error(value.error.message || "操作结果未确认，请刷新状态。");
        } else if (entry.operation === "stop" && value.result?.stopped === true) {
          stopped = true;
          error();
        } else if (entry.operation === "humanDialogRespond") {
          const receipt = value.result?.dialogReceipt;
          if (!receipt || receipt.acknowledged !== true || receipt.leaseId !== entry.fields.leaseId || receipt.generation !== entry.fields.generation || receipt.dialogId !== entry.fields.dialogId) {
            endHuman("网页弹窗回执不匹配，已禁用输入并请求释放；不会重试。");
          } else {
            // Dialog acknowledgements may arrive after a successor opened. Only
            // the backend event sequence may update its state; input ACK is separate.
            acceptState(value.result);
          }
        } else if (entry.operation === "humanInput") {
          const receipt = value.result?.inputReceipt;
          if (!receipt || receipt.acknowledged !== true || receipt.leaseId !== entry.fields.leaseId || receipt.generation !== entry.fields.generation || receipt.sequence !== entry.fields.sequence) {
            endHuman("人工输入回执不匹配，已禁用输入并请求释放；不会重试。");
          } else {
            acceptState(value.result, value.id);
            if (!humanEnding && human?.state === "active" && human.leaseId === receipt.leaseId && human.generation === receipt.generation && human.generation > retiredHumanGeneration)
              acknowledgedSequence = receipt.sequence;
            completeClipboard(entry, value.id, receipt);
            drainInput();
          }
        } else {
          if (entry.operation === "humanBegin") {
            const original = value.result?.human;
            if (!validHuman(original) || !admittedHumanState(original) || original.tabId !== entry.fields.tabId ||
                humanOwner && original.leaseId !== humanOwner || human &&
                (original.inputBudgetVersion !== human.inputBudgetVersion || original.keyRepeatVersion !== human.keyRepeatVersion || original.printableKeyVersion !== human.printableKeyVersion || original.pointerClickCountVersion !== human.pointerClickCountVersion || original.clipboardTransferVersion !== human.clipboardTransferVersion || original.fileChooserVersion !== human.fileChooserVersion))
              throw new Error("原接管回执不匹配。");
          }
          acceptState(value.result, value.id);
          if (entry.operation === "humanBegin") {
            if (humanAction === "humanBegin") humanAction = null;
            const original = value.result.human;
            if (entry.humanEpoch === humanEpoch && admittedHumanState(human) && human.leaseId === original.leaseId && human.leaseId === humanOwner && human.generation >= original.generation) {
              humanAdmitted = true;
              if (humanEnding) endHuman();
            } else endHuman("接管尚未就绪，输入保持禁用。");
          } else if (entry.operation === "humanEnd") {
            if (humanAction === "humanEnd") humanAction = null;
            const cleanup = value.result?.humanCleanup;
            if (!cleanup || cleanup.leaseId !== entry.fields.leaseId || cleanup.cleanupConfirmed !== true) error("人工控制释放尚未确认；Agent 保持暂停，请刷新状态或停止会话。");
            else if (humanOwner === entry.fields.leaseId) humanOwner = "";
          }
        }
        render();
        if (pageSwitch?.phase === "selecting" && pageSwitch.selectId === value.id) {
          const original = pageSwitch; pageSwitch = null;
          const tab = selectedTab();
          if (!value.error && original.selectionEpoch === selectionEpoch && selected === original.tabId && watching === selected &&
              tab?.kind === "result" && validSelectionId(tab.deliveryId) && !humanOwner && !humanReserved() && viewerCleanupComplete && userControlReady()) beginSelectedHuman();
          else { error("所选页面已变化，请刷新列表后重新选择；不会自动重试。"); render(); }
        }
      }
    } catch {
      pageSwitch = null;
      if (humanReserved()) endHuman("人工控制状态无法确认，已禁用输入并请求释放。");
      available = false;
      error("未能读取浏览器状态。请刷新状态后再操作。");
      render();
    }
  });
  ws.addEventListener("close", () => {
    pageSwitch = null;
    connected = authenticated = available = false;
    blockHuman();
    pendingAction = null;
    pendingSelectId = pendingSelectTab = null;
    for (const { timeout, completion } of pending.values()) {
      clearTimeout(timeout);
      completion?.reject(new Error("Viewer connection closed"));
    }
    pending.clear();
    if (!stopped) error("查看连接已断开，不能据此判断会话已停止。运行 managed view 获取新链接，或使用 managed stop 停止会话。");
    render();
  });
  ws.addEventListener("error", () => { /* The close handler reports unconfirmed state. */ });
  setInterval(freshness, 1000);
  window.addEventListener("pagehide", () => { blockHuman(); ws.close(); clearFrame(); }, { once: true });
})();
