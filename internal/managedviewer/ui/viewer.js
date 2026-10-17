"use strict";

(() => {
  // The one-use ticket never enters a request URL, cookie or persistent storage.
  const fragment = new URLSearchParams(location.hash.slice(1));
  let ticket = fragment.get("ticket") || "";
  history.replaceState(null, "", location.pathname);
  const el = Object.fromEntries(["connection", "indicator", "state", "detail", "refresh", "control", "stop", "error", "tabs", "watch", "freshness", "frame", "placeholder", "page-title", "dimensions", "human-begin", "human-end", "human-status", "human-input"].map(id => [id, document.getElementById(id)]));
  let ws, connected = false, authenticated = false, available = false, stopped = false;
  let status = null, worker = "", pendingAction = null, nextId = 0, appliedId = 0;
  let selected = null, selectedOnce = false, tabs = [], lastFrameAt = 0, imageURL = null;
  let selectedDeliveryId = "", selectionEpoch = 0;
  let watching = null, pendingSelectTab = null, pendingSelectId = null;
  let viewerCleanupComplete = false;
  let controlSequence = -1, retiredSequence = -1, lastFrameEvent = -1, revoked = false;
  let stream = "", frameSequence = -1, imageGeneration = 0;
  let imageBusy = false, pendingFrame = null;
  let lastFrameTitle = "";
  let awaitingSelectionFrame = null;
  let view = null, awaitingViewFrame = null;
  let human = null, humanAction = null, humanOwner = "", humanEnding = false;
  let humanEpoch = 0;
  let humanSequence = 0, humanInputId = null, decodedHuman = null, awaitingHumanFrame = null;
  let acknowledgedSequence = 0, composing = false, compositionScope = null;
  let retiredHumanGeneration = -1;
  let humanEndAttempted = false;
  const inputQueue = [], pressedButtons = new Set(), pressedKeys = new Set(), capturedPointers = new Set();
  const maxQueuedInputs = 32;
  const pending = new Map();

  const selectedTab = () => tabs.find(tab => tab.id === selected && (tab.deliveryId || "") === selectedDeliveryId);
  const userControlReady = () => status?.state === "running" || status?.state === "paused" && status.cleanupComplete && viewerCleanupComplete;
  const canUseTab = (tab, operation) => Boolean(tab && tab[operation] && (tab.kind === "task" ? status?.state === "running" : userControlReady()));
  const selectionFields = () => ({ tabId: selected, ...(selectedDeliveryId ? { deliveryId: selectedDeliveryId } : {}) });
  function normalizedTabs(values, next) {
    if (!Array.isArray(values) || values.length > 4096) throw new Error("标签页列表无效。");
    const seen = new Set();
    return values.map(tab => {
      if (!Number.isSafeInteger(tab.id) || tab.id < 1 || seen.has(tab.id) || typeof tab.title !== "string" || typeof tab.url !== "string") throw new Error("标签页身份无效。");
      seen.add(tab.id);
      const legacy = tab.kind === undefined && tab.watchable === undefined && tab.takeover === undefined && tab.deliveryId === undefined;
      if (legacy) return { ...tab, kind: "task", watchable: next.state === "running", takeover: next.state === "running" };
      if (!["task", "result"].includes(tab.kind) || typeof tab.watchable !== "boolean" || typeof tab.takeover !== "boolean" ||
        tab.kind === "result" && (typeof tab.deliveryId !== "string" || !tab.deliveryId || tab.deliveryId.length > 128 || /[\x00-\x1f\x7f]/.test(tab.deliveryId)) ||
        tab.kind === "task" && tab.deliveryId !== undefined) throw new Error("结果页身份无效。");
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
  function humanReady() {
    return authenticated && available && !revoked && !stopped && !pendingAction && !humanAction && !humanEnding &&
      human?.state === "active" && human.leaseId === humanOwner && decodedHuman?.leaseId === humanOwner &&
      human.generation > retiredHumanGeneration && human.generation > 0 && human.viewport?.width > 0 && human.viewport?.height > 0 &&
      decodedHuman.generation === human.generation && decodedHuman.tabId === human.tabId;
  }

  function clearHumanInput() {
    decodedHuman = null;
    awaitingHumanFrame = null;
    inputQueue.length = 0;
    pressedKeys.clear();
    pressedButtons.clear();
    composing = false;
    compositionScope = null;
    el["human-input"].value = "";
    for (const pointerId of capturedPointers) {
      if (el.frame.hasPointerCapture(pointerId)) el.frame.releasePointerCapture(pointerId);
    }
    capturedPointers.clear();
  }

  function blockHuman() {
    humanEnding = true;
    clearHumanInput();
  }

  function suspendHumanGeneration(retireBegin = false) {
    const waiting = awaitingHumanFrame;
    clearHumanInput();
    // Retire the UI lane only. Original requests remain in pending until their
    // actual response or local deadline; their old tuple cannot affect a successor.
    humanInputId = null;
    humanSequence = acknowledgedSequence = 0;
    clearFrame();
    if (retireBegin && humanAction === "humanBegin") {
      for (const entry of pending.values()) {
        if (entry.operation === "humanBegin" && entry.humanEpoch === humanEpoch) entry.generationRetired = true;
      }
      humanAction = null;
    }
    return waiting;
  }

  function currentInput(entry, id) {
    return humanInputId === id && entry.fields.leaseId === humanOwner &&
      entry.fields.generation === human?.generation && entry.fields.generation > retiredHumanGeneration;
  }

  function endHuman(message = "", retryCleanup = false) {
    const leaseId = human?.leaseId || humanOwner;
    blockHuman(); // Revoke admission before awaiting any original input or cleanup receipt.
    if (message) error(message);
    if (leaseId && (!humanEndAttempted || retryCleanup) && humanAction !== "humanEnd" && pendingAction !== "stop" && authenticated && !stopped) {
      humanEndAttempted = true;
      send("humanEnd", { leaseId });
    }
    render();
  }

  function error(message = "") {
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
    el.control.disabled = !authenticated || !available || stopped || Boolean(pendingAction) || Boolean(humanAction) || Boolean(humanOwner) || Boolean(humanReserved()) || status.state === "pausing";
    el.stop.disabled = !authenticated || stopped || pendingAction === "stop";
    if (pendingAction === "stop") el.stop.textContent = "正在停止…";
    else el.stop.textContent = "停止会话";
    el.tabs.disabled = !authenticated || !available || !userControlReady() || Boolean(pendingAction) || Boolean(humanAction) || Boolean(humanReserved()) || pendingSelectId !== null || stopped;
    el.watch.disabled = el.tabs.disabled || selected === null || watching !== selected && !canUseTab(selectedTab(), "watchable");
    el.watch.textContent = pendingSelectId !== null ? "正在确认…" : watching === selected && selected !== null ? "停止查看" : "开始查看";
    el["human-begin"].disabled = el.tabs.disabled || !canUseTab(selectedTab(), "takeover");
    el["human-begin"].textContent = selectedTab()?.kind === "result" ? "操作结果页" : "接管此页";
    el["human-begin"].hidden = Boolean(humanReserved()) || Boolean(humanAction) || Boolean(humanOwner);
    el["human-end"].hidden = !humanReserved() && !humanAction && !humanOwner;
    el["human-end"].disabled = !authenticated || stopped || pendingAction === "stop" || !(human?.leaseId || humanOwner) || humanAction === "humanEnd";
    el["human-end"].textContent = humanAction === "humanEnd" || human?.state === "releasing" ? "正在释放接管…" : "完成接管";
    const ready = humanReady();
    el.frame.dataset.interactive = String(ready);
    el["human-input"].disabled = !ready;
    el["human-input"].dataset.enabled = String(ready);
    el["human-input"].dataset.pending = String(inputQueue.length + (humanInputId === null ? 0 : 1));
    el["human-input"].dataset.sequence = String(humanSequence);
    el["human-input"].dataset.acknowledgedSequence = String(acknowledgedSequence);
    el["human-status"].hidden = !humanReserved() && !humanAction && !humanOwner;
    el["human-status"].textContent = humanAction === "humanBegin" || human?.state === "starting" ? "正在暂停 Agent 并等待原控制释放…" : humanEnding || human?.state === "releasing" ? "人工输入已禁用，正在等待释放确认；不会重试网页操作。" : human?.state === "error" ? "人工控制未完成释放。请完成接管或停止会话；Agent 保持暂停。" : human?.state === "navigating" || human && human.generation <= retiredHumanGeneration ? "页面正在跳转，输入已暂停；等待新画面后可继续，旧输入不会重放。" : ready ? "你正在操作 · 点击画面后输入；切换查看窗口会结束接管。完成后 Agent 仍保持暂停。" : "你正在接管 · 等待当前画面解码，暂不接收输入。";
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
    for (const tab of tabs) options.push(new Option((tab.kind === "result" ? "已交付结果 · " : "") + (tab.title || tab.url || `标签页 ${tab.id}`), String(tab.id)));
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
    const nextHuman = value.human ?? null;
    const nextView = value.view ?? null, nextTabs = normalizedTabs(value.tabs, next);
    if (!validView(nextView) || nextView && nextHuman || nextView && (nextView.tabId !== value.selectedTabId || !nextTabs.some(tab => tab.id === nextView.tabId && tab.kind === "result"))) throw new Error("独立查看身份无效。");
    if (view && nextView && view.leaseId === nextView.leaseId && nextView.generation < view.generation) return;
    const waitingView = awaitingViewFrame;
    if (view && (!nextView || view.leaseId !== nextView.leaseId || view.generation !== nextView.generation || nextView.state !== "active") || !view && nextView) clearFrame();
    view = nextView;
    if (waitingView && view && waitingView.viewLeaseId === view.leaseId && waitingView.generation >= view.generation) awaitingViewFrame = waitingView;
    if (nextHuman && (!["starting", "active", "navigating", "releasing", "released", "error"].includes(nextHuman.state) || typeof nextHuman.leaseId !== "string" || !nextHuman.leaseId || !Number.isSafeInteger(nextHuman.tabId) || nextHuman.tabId < 1 || !Number.isSafeInteger(nextHuman.generation) || nextHuman.generation < 0 ||
      nextHuman.state === "navigating" && (nextHuman.generation < 1 || nextHuman.viewport !== null) ||
      nextHuman.state === "active" && nextHuman.generation > 0 && nextHuman.viewport === null ||
      nextHuman.viewport !== null && (!Number.isFinite(nextHuman.viewport?.width) || nextHuman.viewport.width <= 0 || !Number.isFinite(nextHuman.viewport?.height) || nextHuman.viewport.height <= 0))) throw new Error("人工控制状态格式无效。");
    if (humanAction === "humanBegin" && nextHuman && selected !== nextHuman.tabId) throw new Error("接管页面身份不匹配。");
    // The first native frame supplies generation 1 after Begin may already
    // have returned active/generation 0. This is readiness, not a successor
    // document. Successor generations retire input without ending this lease.
    const initialGeometry = human && nextHuman && human.leaseId === nextHuman.leaseId && human.tabId === nextHuman.tabId &&
      human.generation === 0 && !decodedHuman && humanSequence === 0 && !humanEnding &&
      ["starting", "active"].includes(human.state) && ["starting", "active"].includes(nextHuman.state);
    const geometryChanged = human && nextHuman && (human.generation !== nextHuman.generation ||
      human.viewport?.width !== nextHuman.viewport?.width || human.viewport?.height !== nextHuman.viewport?.height);
    const sameHuman = human && nextHuman && human.leaseId === nextHuman.leaseId && human.tabId === nextHuman.tabId;
    if (sameHuman && nextHuman.generation < human.generation) return;
    const navigation = sameHuman && !humanEnding && ["starting", "active", "navigating"].includes(human.state) &&
      ["active", "navigating"].includes(nextHuman.state) && !initialGeometry &&
      (nextHuman.generation > human.generation || nextHuman.state === "navigating");
    const navigationReady = sameHuman && human.state === "navigating" && nextHuman.state === "active" && nextHuman.generation === human.generation;
    if (navigation) {
      const waiting = suspendHumanGeneration(true);
      retiredHumanGeneration = Math.max(retiredHumanGeneration, nextHuman.generation - 1);
      if (waiting?.humanLeaseId === nextHuman.leaseId && waiting.tabId === nextHuman.tabId && waiting.generation >= nextHuman.generation)
        awaitingHumanFrame = waiting;
    } else if (human && (!nextHuman || !sameHuman || geometryChanged && !initialGeometry && !navigationReady || human.state === "active" && nextHuman.state !== "active" || ["releasing", "released", "error"].includes(nextHuman.state))) {
      blockHuman();
      imageGeneration++;
      pendingFrame = null;
    }
    human = nextHuman;
    if (humanAction === "humanBegin" && human && !humanOwner) humanOwner = human.leaseId;
    if (humanOwner && human?.state !== "active" && value.humanCleanup?.leaseId === humanOwner && value.humanCleanup.cleanupConfirmed === true) {
      // A confirmed End joins native input too, including a reply whose local
      // timeout expired. Only this receipt may clear that outstanding marker.
      humanInputId = null;
      humanOwner = "";
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
      selectedOnce = true;
    }
    const deliveryChanged = selected !== null && tabs.some(t => t.id === selected && (t.deliveryId || "") !== selectedDeliveryId);
    if (selected !== null && (!tabs.some(t => t.id === selected) && human?.tabId !== selected && humanAction !== "humanBegin" || deliveryChanged)) {
      selected = null;
      selectedDeliveryId = ""; selectionEpoch++;
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
    if (humanEnding && human?.state === "active" && !humanEndAttempted) endHuman();
  }

  function retireThrough(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("画面退役状态无效。");
    if (sequence <= retiredSequence) return;
    retiredSequence = sequence;
    imageGeneration++;
    pendingFrame = null;
    if (decodedHuman && Number(el.frame.dataset.eventSequence) <= sequence) decodedHuman = null;
  }

  function send(operation, fields = {}) {
    if (!authenticated || ws.readyState !== WebSocket.OPEN) return;
    const id = ++nextId;
    const timeout = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (entry.generationRetired || entry.selectionEpoch !== undefined && entry.selectionEpoch !== selectionEpoch || entry.humanEpoch !== undefined && entry.humanEpoch !== humanEpoch || entry.operation === "humanInput" && !currentInput(entry, id)) return;
      if (pendingSelectId === id) { pendingSelectId = null; pendingSelectTab = null; }
      if (pendingAction === operation) pendingAction = null;
      if (humanAction === operation) humanAction = null;
      if (operation.startsWith("human")) endHuman("人工操作确认超时，输入已禁用；不会自动重试。请等待释放确认或停止会话。");
      available = false;
      error("等待确认超时，不能据此判断操作是否完成。请刷新状态；不会自动重试操作。");
      render();
    }, operation === "stop" ? 55000 : 35000);
    pending.set(id, { operation, timeout, fields, ...(operation.startsWith("human") ? { humanEpoch } : {}), ...(operation === "select" ? { selectionEpoch } : {}) });
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
         human?.leaseId === value.humanLeaseId && human.tabId === value.tabId && ["starting", "active", "navigating"].includes(human.state) &&
           (value.generation > human.generation || human.state === "navigating" && value.generation === human.generation))) {
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
    if (!humanReady() || humanInputId !== null || !inputQueue.length) return;
    const input = inputQueue.shift();
    humanInputId = send("humanInput", { leaseId: human.leaseId, generation: human.generation, sequence: ++humanSequence, input });
    render();
  }

  function enqueueInput(input) {
    if (!humanReady()) return false;
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
  function point(event) {
    if (!humanReady() || !decodedHuman?.width || !decodedHuman.height) return null;
    const rect = el.frame.getBoundingClientRect();
    const scale = Math.min(rect.width / decodedHuman.width, rect.height / decodedHuman.height);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const width = decodedHuman.width * scale, height = decodedHuman.height * scale;
    const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
    if (event.clientX < left || event.clientX >= left + width || event.clientY < top || event.clientY >= top + height) return null;
    return { x: (event.clientX - left) * human.viewport.width / width, y: (event.clientY - top) * human.viewport.height / height };
  }

  function pointer(event, action) {
    if (!humanReady()) return;
    if (event.pointerType && event.pointerType !== "mouse") { endHuman("当前接管仅支持鼠标输入；已请求释放控制。"); return; }
    const position = point(event);
    if (!position) { if (pressedButtons.size) endHuman("指针已离开当前画面，正在释放按键和人工控制。"); return; }
    const button = buttons[event.button];
    if (action !== "move" && !button) return;
    event.preventDefault();
    if (action === "down") {
      if (pressedButtons.has(button)) return;
      el["human-input"].focus({ preventScroll: true });
      pressedButtons.add(button);
      el.frame.setPointerCapture(event.pointerId);
      capturedPointers.add(event.pointerId);
    } else if (action === "up") {
      if (!pressedButtons.delete(button)) return;
    }
    enqueueInput({ type: "pointer", action, ...position, ...(action === "move" ? {} : { button }), modifiers: modifiers(event) });
    if (action === "up" && !pressedButtons.size) {
      if (el.frame.hasPointerCapture(event.pointerId)) el.frame.releasePointerCapture(event.pointerId);
      capturedPointers.delete(event.pointerId);
    }
  }

  function committedText(text) {
    el["human-input"].value = "";
    if (typeof text !== "string" || !text) return;
    if (text.length > 4096) { endHuman("一次输入过长，已请求释放；文字未发送。请分段输入。"); return; }
    enqueueInput({ type: "text", text });
  }

  function keyboard(event, action) {
    if (!humanReady() || event.isComposing || composing || ["Dead", "Process", "Unidentified"].includes(event.key)) return;
    const shortcut = event.ctrlKey || event.altKey || event.metaKey;
    const printable = Array.from(event.key || "").length === 1;
    if (printable && !shortcut && !pressedKeys.has(event.code)) return; // Committed text has exactly one path below.
    if (!event.code || !Number.isInteger(event.keyCode) || event.keyCode < 1 || event.keyCode > 255) return;
    event.preventDefault();
    if (action === "down") {
      if (pressedKeys.has(event.code)) return;
      pressedKeys.add(event.code);
    } else if (!pressedKeys.delete(event.code)) return;
    enqueueInput({ type: "key", action, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: modifiers(event) });
  }

  el["human-begin"].addEventListener("click", () => {
    if (el["human-begin"].disabled) return;
    humanEpoch++;
    error(); clearFrame();
    human = null; humanOwner = ""; humanEnding = humanEndAttempted = composing = false;
    retiredHumanGeneration = -1;
    compositionScope = null;
    humanSequence = acknowledgedSequence = 0;
    inputQueue.length = 0; humanInputId = null;
    send("humanBegin", selectionFields());
  });
  el["human-end"].addEventListener("click", () => { if (!el["human-end"].disabled) endHuman("", true); });
  for (const action of ["down", "move", "up"]) el.frame.addEventListener(`pointer${action}`, event => pointer(event, action));
  for (const event of ["pointercancel", "lostpointercapture"]) el.frame.addEventListener(event, () => { if (pressedButtons.size) endHuman("指针控制已中断，正在释放人工控制。"); });
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
  el["human-input"].addEventListener("beforeinput", event => {
    if (!humanReady() || event.isComposing || composing || /Composition/.test(event.inputType)) return;
    event.preventDefault();
    if (["insertText", "insertFromPaste", "insertReplacementText"].includes(event.inputType)) committedText(event.data ?? event.dataTransfer?.getData("text/plain"));
  });
  el["human-input"].addEventListener("compositionstart", () => {
    composing = humanReady();
    compositionScope = composing ? { leaseId: human.leaseId, generation: human.generation } : null;
  });
  el["human-input"].addEventListener("compositionend", event => {
    const current = composing && compositionScope?.leaseId === human?.leaseId && compositionScope?.generation === human?.generation;
    composing = false; compositionScope = null;
    if (current && humanReady()) committedText(event.data); else el["human-input"].value = "";
  });
  el["human-input"].addEventListener("blur", () => {
    // Navigating disables this focused textarea. That local blur is not a user
    // request to terminate the lease; window blur/End/Stop remain independent.
    if (humanReady())
      endHuman("输入区域已失焦，正在释放人工控制；Agent 保持暂停。");
  });
  window.addEventListener("blur", () => { if ((humanReserved() || humanAction === "humanBegin") && !humanEnding) endHuman("查看窗口已失焦，正在释放人工控制；Agent 保持暂停。"); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && (humanReserved() || humanAction === "humanBegin") && !humanEnding) endHuman("查看窗口已隐藏，正在释放人工控制；Agent 保持暂停。"); });

  el.refresh.addEventListener("click", () => { error(); send("status"); });
  el.control.addEventListener("click", () => {
    if (el.control.disabled) return;
    error();
    if (status.state === "paused" && status.cleanupComplete && viewerCleanupComplete) send("resume", { expectedRevision: status.revision, expectedWorkerBootId: worker });
    else send("pause");
  });
  el.stop.addEventListener("click", () => { if (!el.stop.disabled) { blockHuman(); error(); send("stop"); } });
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
    selectionEpoch++;
    selectedOnce = true;
    clearFrame();
    renderTabs();
    error();
    if (selected === null || canUseTab(selectedTab(), "watchable")) send("select", selectionFields());
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
        if (humanReserved()) endHuman("当前接管画面已撤销，正在释放人工控制。");
        render();
      } else if (value.type === "unavailable") {
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
        if (entry.generationRetired || entry.selectionEpoch !== undefined && entry.selectionEpoch !== selectionEpoch || entry.humanEpoch !== undefined && entry.humanEpoch !== humanEpoch) return;
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
        } else if (value.error) {
          if (entry.operation.startsWith("human")) {
            if (humanAction === entry.operation) humanAction = null;
            endHuman(value.error.message || "人工操作结果未确认，已禁用输入并请求释放。");
          }
          available = false;
          error(value.error.message || "操作结果未确认，请刷新状态。");
        } else if (entry.operation === "stop" && value.result?.stopped === true) {
          stopped = true;
          error();
        } else if (entry.operation === "humanInput") {
          const receipt = value.result?.inputReceipt;
          if (!receipt || receipt.acknowledged !== true || receipt.leaseId !== entry.fields.leaseId || receipt.generation !== entry.fields.generation || receipt.sequence !== entry.fields.sequence) {
            endHuman("人工输入回执不匹配，已禁用输入并请求释放；不会重试。");
          } else {
            acceptState(value.result, value.id);
            if (!humanEnding && human?.state === "active" && human.leaseId === receipt.leaseId && human.generation === receipt.generation && human.generation > retiredHumanGeneration)
              acknowledgedSequence = receipt.sequence;
            drainInput();
          }
        } else {
          acceptState(value.result, value.id);
          if (entry.operation === "humanBegin") {
            if (humanAction === "humanBegin") humanAction = null;
            if (!["active", "navigating"].includes(human?.state) || human.leaseId !== humanOwner) endHuman("接管尚未就绪，输入保持禁用。");
          } else if (entry.operation === "humanEnd") {
            if (humanAction === "humanEnd") humanAction = null;
            const cleanup = value.result?.humanCleanup;
            if (!cleanup || cleanup.leaseId !== entry.fields.leaseId || cleanup.cleanupConfirmed !== true) error("人工控制释放尚未确认；Agent 保持暂停，请刷新状态或停止会话。");
            else { if (humanOwner === entry.fields.leaseId) humanOwner = ""; error(); }
          }
        }
        render();
      }
    } catch {
      if (humanReserved()) endHuman("人工控制状态无法确认，已禁用输入并请求释放。");
      available = false;
      error("未能读取浏览器状态。请刷新状态后再操作。");
      render();
    }
  });
  ws.addEventListener("close", () => {
    connected = authenticated = available = false;
    blockHuman();
    pendingAction = null;
    pendingSelectId = pendingSelectTab = null;
    for (const { timeout } of pending.values()) clearTimeout(timeout);
    pending.clear();
    if (!stopped) error("查看连接已断开，不能据此判断会话已停止。运行 managed view 获取新链接，或使用 managed stop 停止会话。");
    render();
  });
  ws.addEventListener("error", () => { /* The close handler reports unconfirmed state. */ });
  setInterval(freshness, 1000);
  window.addEventListener("pagehide", () => { blockHuman(); ws.close(); clearFrame(); }, { once: true });
})();
