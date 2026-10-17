"use strict";

(() => {
  // The one-use ticket never enters a request URL, cookie or persistent storage.
  const fragment = new URLSearchParams(location.hash.slice(1));
  let ticket = fragment.get("ticket") || "";
  history.replaceState(null, "", location.pathname);
  const el = Object.fromEntries(["connection", "indicator", "state", "detail", "refresh", "control", "stop", "error", "tabs", "watch", "freshness", "frame", "placeholder", "page-title", "dimensions"].map(id => [id, document.getElementById(id)]));
  let ws, connected = false, authenticated = false, available = false, stopped = false;
  let status = null, worker = "", pendingAction = null, nextId = 0, appliedId = 0;
  let selected = null, selectedOnce = false, tabs = [], lastFrameAt = 0, imageURL = null;
  let watching = null, pendingSelectTab = null, pendingSelectId = null;
  let viewerCleanupComplete = false;
  let controlSequence = -1, retiredSequence = -1, lastFrameEvent = -1, revoked = false;
  let stream = "", frameSequence = -1, imageGeneration = 0;
  let imageBusy = false, pendingFrame = null;
  let lastFrameTitle = "";
  let awaitingSelectionFrame = null;
  const pending = new Map();

  function error(message = "") {
    el.error.textContent = message;
    el.error.hidden = !message;
  }

  function render() {
    const state = stopped ? "stopped" : pendingAction === "stop" ? "stopping" : pendingAction === "pause" ? "pausing" : !available ? "unknown" : status.state === "paused" && !viewerCleanupComplete ? "error" : status.state;
    const descriptions = {
      running: ["正在运行", "Agent 可以操作其已分配的标签页。"],
      pausing: ["正在暂停", "已请求阻止新操作，正在等待控制释放确认。"],
      paused: ["已暂停", "Agent 操作已阻止。画面保留最后一次更新。"],
      error: ["暂停未完成", "Agent 操作仍被阻止，请重试暂停以完成控制释放。"],
      unknown: ["状态未确认", "请刷新状态后再操作；浏览器连接失联时仍可停止会话。"],
      stopping: ["正在停止", "正在等待独立浏览器及其进程退出的确认。"],
      stopped: ["会话已停止", "已收到独立浏览器停止完成的确认。"]
    };
    const [label, detail] = descriptions[state];
    el.state.textContent = label;
    el.detail.textContent = detail;
    el.indicator.className = "indicator " + state;
    el.connection.textContent = stopped ? "已结束" : authenticated ? (available ? "已连接" : "控制状态不可用") : connected ? "正在验证" : "未连接";
    el.refresh.disabled = !authenticated || stopped || Boolean(pendingAction);
    const canResume = available && status.state === "paused" && status.cleanupComplete && viewerCleanupComplete;
    const retry = available && (status.state === "error" || status.state === "paused" && (!status.cleanupComplete || !viewerCleanupComplete));
    el.control.textContent = pendingAction === "pause" ? "正在暂停…" : pendingAction === "resume" ? "正在继续…" : canResume ? "继续操作" : retry ? "重试暂停" : "暂停操作";
    el.control.disabled = !authenticated || !available || stopped || Boolean(pendingAction) || status.state === "pausing";
    el.stop.disabled = !authenticated || stopped || pendingAction === "stop";
    if (pendingAction === "stop") el.stop.textContent = "正在停止…";
    else el.stop.textContent = "停止会话";
    el.tabs.disabled = !authenticated || !available || status.state !== "running" || Boolean(pendingAction) || pendingSelectId !== null || stopped;
    el.watch.disabled = el.tabs.disabled || selected === null;
    el.watch.textContent = pendingSelectId !== null ? "正在确认…" : watching === selected && selected !== null ? "停止查看" : "开始查看";
    freshness();
  }

  function freshness() {
    if (!lastFrameAt) { el.freshness.textContent = "尚无画面"; return; }
    const seconds = Math.max(0, Math.floor((Date.now() - lastFrameAt) / 1000));
    const frozen = !available || status?.state !== "running" || stopped || selected === null || (watching !== selected && pendingSelectTab !== selected);
    el.freshness.textContent = (frozen ? "保留画面 · " : seconds < 3 ? "实时 · " : "等待更新 · ") + (seconds < 1 ? "刚刚" : `${seconds} 秒前`);
  }

  function clearFrame() {
    imageGeneration++;
    pendingFrame = null;
    awaitingSelectionFrame = null;
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
    for (const tab of tabs) options.push(new Option(tab.title || tab.url || `标签页 ${tab.id}`, String(tab.id)));
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
    controlSequence = value.eventSequence;
    if (next.state !== "running" || value.selectedTabId === null) retireThrough(Math.max(retiredSequence, value.eventSequence));
    if (responseId) appliedId = responseId;
    worker = value.workerBootId;
    if (next.state !== "running") { imageGeneration++; pendingFrame = null; }
    status = next;
    viewerCleanupComplete = value.viewerCleanupComplete;
    tabs = Array.isArray(value.tabs) ? value.tabs : [];
    watching = value.selectedTabId ?? null;
    available = true;
    if (!selectedOnce) {
      selected = value.selectedTabId ?? null;
      selectedOnce = true;
    }
    if (selected !== null && !tabs.some(t => t.id === selected)) {
      selected = null;
      imageGeneration++;
      pendingFrame = null;
    }
    renderTabs();
    render();
    const waiting = awaitingSelectionFrame;
    awaitingSelectionFrame = null;
    if (waiting && watching === waiting.tabId) frame(waiting);
  }

  function retireThrough(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("画面退役状态无效。");
    if (sequence <= retiredSequence) return;
    retiredSequence = sequence;
    imageGeneration++;
    pendingFrame = null;
  }

  function send(operation, fields = {}) {
    if (!authenticated || ws.readyState !== WebSocket.OPEN) return;
    const id = ++nextId;
    const timeout = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (pendingSelectId === id) { pendingSelectId = null; pendingSelectTab = null; }
      if (pendingAction === operation) pendingAction = null;
      available = false;
      error("等待确认超时，不能据此判断操作是否完成。请刷新状态；不会自动重试操作。");
      render();
    }, operation === "stop" ? 55000 : 35000);
    pending.set(id, { operation, timeout });
    if (operation === "select") { pendingSelectId = id; pendingSelectTab = fields.tabId; }
    if (["pause", "resume", "stop"].includes(operation)) pendingAction = operation;
    ws.send(JSON.stringify({ id, operation, ...fields }));
    render();
  }

  function frame(value) {
    retireThrough(value.retiredSequence);
    if (available && !revoked && selected === value.tabId && value.eventSequence > retiredSequence && pendingSelectId !== null && watching !== value.tabId && pendingSelectTab !== value.tabId) {
      awaitingSelectionFrame = value;
      return;
    }
    if (!available || revoked || !Number.isSafeInteger(value.eventSequence) || value.eventSequence <= retiredSequence || value.eventSequence <= lastFrameEvent || status.state !== "running" || selected !== value.tabId || (watching !== value.tabId && pendingSelectTab !== value.tabId) || typeof value.data !== "string" || value.data.length > 4 * Math.ceil(4 * 1024 * 1024 / 3) || value.mimeType !== "image/png") return;
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
      if (next && next.eventSequence > retiredSequence && available && !revoked && status.state === "running" && selected === next.tabId && (watching === next.tabId || pendingSelectTab === next.tabId) && !stopped) decodeFrame(next);
    };
    image.onload = () => {
      if (generation !== imageGeneration || value.eventSequence <= retiredSequence || !available || revoked || status.state !== "running" || selected !== value.tabId || (watching !== value.tabId && pendingSelectTab !== value.tabId) || stopped) { URL.revokeObjectURL(nextURL); finish(); return; }
      if (imageURL) URL.revokeObjectURL(imageURL);
      imageURL = nextURL;
      el.frame.src = imageURL;
      el.frame.hidden = false;
      el.frame.dataset.streamId = value.streamId;
      el.frame.dataset.frameSequence = String(value.sequence);
      el.frame.dataset.eventSequence = String(value.eventSequence);
      el.frame.dataset.renderGeneration = String(generation);
      el.frame.dataset.capturedAt = String(value.metadata?.timestamp ?? "");
      el.placeholder.hidden = true;
      el.dimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
      lastFrameAt = Date.now();
      const tab = tabs.find(t => t.id === value.tabId);
      lastFrameTitle = tab ? `${tab.title || "未命名标签页"} · ${tab.url || ""}` : `标签页 ${value.tabId}`;
      freshness();
      finish();
    };
    image.onerror = () => { URL.revokeObjectURL(nextURL); finish(); };
    image.src = nextURL;
  }

  el.refresh.addEventListener("click", () => { error(); send("status"); });
  el.control.addEventListener("click", () => {
    if (el.control.disabled) return;
    error();
    if (status.state === "paused" && status.cleanupComplete && viewerCleanupComplete) send("resume", { expectedRevision: status.revision, expectedWorkerBootId: worker });
    else send("pause");
  });
  el.stop.addEventListener("click", () => { if (!el.stop.disabled) { error(); send("stop"); } });
  el.watch.addEventListener("click", () => {
    if (el.watch.disabled) return;
    error();
    send("select", { tabId: watching === selected ? null : selected });
  });
  el.tabs.addEventListener("change", () => {
    if (el.tabs.disabled) return;
    selected = el.tabs.value === "" ? null : Number(el.tabs.value);
    selectedOnce = true;
    clearFrame();
    renderTabs();
    error();
    send("select", { tabId: selected });
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
        pendingSelectTab = null;
        imageGeneration++;
        pendingFrame = null;
        awaitingSelectionFrame = null;
        render();
      } else if (value.type === "unavailable") {
        available = false;
        revoked = true;
        imageGeneration++;
        pendingFrame = null;
        awaitingSelectionFrame = null;
        pendingSelectTab = null;
        error("浏览器控制连接已断开；仍可停止会话。");
        render();
      } else if (value.type === "response") {
        const entry = pending.get(value.id);
        if (!entry) return;
        clearTimeout(entry.timeout);
        pending.delete(value.id);
        if (pendingSelectId === value.id) { pendingSelectId = null; pendingSelectTab = null; }
        if (pendingAction === entry.operation) pendingAction = null;
        if (value.error) {
          available = false;
          error(value.error.message || "操作结果未确认，请刷新状态。");
        } else if (entry.operation === "stop" && value.result?.stopped === true) {
          stopped = true;
          error();
        } else {
          acceptState(value.result, value.id);
        }
        render();
      }
    } catch {
      available = false;
      error("未能读取浏览器状态。请刷新状态后再操作。");
      render();
    }
  });
  ws.addEventListener("close", () => {
    connected = authenticated = available = false;
    pendingAction = null;
    pendingSelectId = pendingSelectTab = null;
    for (const { timeout } of pending.values()) clearTimeout(timeout);
    pending.clear();
    if (!stopped) error("查看连接已断开，不能据此判断会话已停止。运行 managed view 获取新链接，或使用 managed stop 停止会话。");
    render();
  });
  ws.addEventListener("error", () => { /* The close handler reports unconfirmed state. */ });
  setInterval(freshness, 1000);
  window.addEventListener("pagehide", () => { ws.close(); clearFrame(); }, { once: true });
})();
