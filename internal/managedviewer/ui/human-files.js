"use strict";

// The viewer supplies names and bytes only. Temporary paths and the original
// renderer node stay behind the managed session's authenticated command channel.
globalThis.ManagedHumanFiles = (() => {
  const chunkBytes = 16 * 1024, maxFileBytes = 32 * 1024 * 1024, maxTotalBytes = 64 * 1024 * 1024;
  const key = value => value ? JSON.stringify([value.leaseId, value.generation, value.chooserId]) : "";
  const tuple = value => ({ leaseId: value.leaseId, generation: value.generation, chooserId: value.chooserId });
  const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
  function validSource(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "frame,origin" ||
        !["top-level", "child"].includes(value.frame) || typeof value.origin !== "string" || value.origin.length > 2048 ||
        !/^[\x21-\x7e]+$/.test(value.origin)) return false;
    try { const url = new URL(value.origin); return ["http:", "https:"].includes(url.protocol) && url.origin === value.origin; }
    catch { return false; }
  }
  function validPending(value, owner) {
    if (value === null) return true;
    return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).every(name => ["leaseId", "generation", "chooserId", "multiple", "source"].includes(name)) &&
      owner?.fileChooserVersion === 1 && ["preparing", "active", "navigating"].includes(owner.state) &&
      value.leaseId === owner.leaseId && value.generation === owner.generation &&
      Number.isSafeInteger(value.generation) && value.generation > 0 && identifier(value.chooserId) &&
      typeof value.multiple === "boolean" && (!Object.hasOwn(value, "source") || validSource(value.source)));
  }
  function metadata(files, multiple) {
    if (!files.length || files.length > 16 || !multiple && files.length !== 1) throw Error("请选择符合网页要求的文件，最多 16 个。");
    let total = 0;
    const values = files.map(file => {
      const name = file.name;
      if (typeof name !== "string" || !name.isWellFormed() || !name || new TextEncoder().encode(name).length > 240 ||
          /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || name === "." || name === ".." ||
          /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(name))
        throw Error("文件名不受支持。请使用不含路径、特殊字符或 Windows 保留名称的文件名。");
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxFileBytes) throw Error("每个文件最多 32 MiB。");
      total += file.size;
      return { name, size: file.size };
    });
    if (total > maxTotalBytes) throw Error("一次选择的文件合计最多 64 MiB。");
    return { values, total };
  }
  function sameReceipt(value, original, fields) {
    return value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === fields.sort().join(",") &&
      key(value) === key(original) && value.transferId === original.transferId;
  }
  function base64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function create({ elements, request, onFatal, onChange }) {
    const e = elements, identities = new Map();
    let pending = null, enabled = false, inputIdle = false, transfer = null, picker = null, notice = "", displayEpoch = 0;
    const active = record => transfer === record && !record.retired && enabled && key(pending) === key(record);
    function clearPicker() {
      if (picker) clearTimeout(picker.timer);
      picker = null;
      e["file-picker"].value = "";
    }
    function retire() {
      const wasPicking = Boolean(picker);
      clearPicker();
      if (transfer) {
        clearTimeout(transfer.timer);
        transfer.retired = true;
        if (transfer.phase === "committing") notice = "文件已提交给浏览器，仍在等待原结果；不会重试。";
        else if (transfer.phase !== "finished") notice = "本次文件传输已结束，不会向新页面继续上传。";
      } else if (wasPicking) notice = "本次文件选择已结束，稍后选中的文件不会上传。";
    }
    function render() {
      const visible = Boolean(pending && enabled);
      e["file-chooser"].hidden = !visible;
      e["file-chooser"].dataset.chooserId = visible ? pending.chooserId : "";
      e["file-choose"].disabled = !visible || !inputIdle || Boolean(transfer || picker);
      e["file-cancel"].disabled = !visible || Boolean(picker) || transfer?.phase === "committing" || transfer?.phase === "cancelling";
      const source = pending?.source;
      e["file-source"].textContent = !visible ? "" : source ? `来源：${source.frame === "child" ? "子页面" : "主页面"} · ${source.origin}` : "来源未提供";
      e["file-description"].textContent = !inputIdle ? "请先松开按键和鼠标，等待原操作确认后再选择文件。" :
        pending?.multiple ? "网页允许选择多个文件。最多 16 个，单个最多 32 MiB，合计最多 64 MiB。" :
          "网页请求选择一个文件，最多 32 MiB。";
      e["file-status"].hidden = !notice;
      e["file-status"].textContent = notice;
      e["file-status"].dataset.phase = picker ? "picking" : transfer?.phase ?? "";
    }
    function changed() { render(); onChange(); }
    function accept(value) {
      const identity = key(value);
      if (value) {
        const descriptor = JSON.stringify([value.multiple, value.source?.origin ?? "", value.source?.frame ?? ""]);
        if (identities.has(identity) && identities.get(identity) !== descriptor) throw Error("原文件选择请求发生变化。");
        if (!identities.has(identity) && identities.size >= 1024) throw Error("文件选择记录已达上限，请结束后重新接管。");
        identities.set(identity, descriptor);
      }
      if (identity !== key(pending)) {
        retire();
        transfer = null;
        if (value) { displayEpoch++; notice = ""; }
      }
      pending = value;
    }
    function assertActive(record) {
      if (!active(record)) throw Object.assign(Error("Original file selection retired"), { retired: true });
    }
    function fail(record, error) {
      clearTimeout(record.timer);
      if (record.phase === "committing" && record.displayEpoch === displayEpoch) {
        notice = "文件提交结果未确认；不会自动重试。请等待释放或停止会话。";
        changed();
      }
      if (record.retired || transfer !== record || error.retired) return;
      record.retired = true;
      notice = record.phase === "committing" ? "文件提交结果未确认；不会自动重试。请等待释放或停止会话。" : "文件传输未完成，正在结束接管。";
      changed();
      onFatal(notice);
    }
    async function upload(files, original) {
      let manifest;
      try { manifest = metadata(files, original.multiple); }
      catch (error) { notice = error.message; changed(); return; }
      const record = { ...tuple(original), retired: false, phase: "transferring", transferId: undefined, displayEpoch };
      transfer = record; notice = "正在准备文件传输…"; changed();
      record.timer = setTimeout(() => {
        if (!active(record)) return;
        record.retired = true; notice = "文件传输等待超时，正在结束接管；不会重试提交。"; changed(); onFatal(notice);
      }, 600000);
      try {
        assertActive(record);
        const opened = (await request("humanFileBegin", { ...tuple(record), files: manifest.values })).fileTransfer;
        if (!sameReceipt(opened, { ...record, transferId: opened?.transferId }, ["leaseId", "generation", "chooserId", "transferId", "fileCount", "totalBytes"]) ||
            !identifier(opened.transferId) || opened.fileCount !== files.length || opened.totalBytes !== manifest.total)
          throw Error("File transfer receipt does not match");
        record.transferId = opened.transferId;
        assertActive(record);
        let completed = 0;
        for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
          const file = files[fileIndex];
          for (let offset = 0; offset < file.size;) {
            assertActive(record);
            const end = Math.min(file.size, offset + chunkBytes);
            const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
            assertActive(record);
            if (bytes.length !== end - offset) throw Error("Original file bytes changed");
            const receipt = (await request("humanFileChunk", { ...tuple(record), transferId: record.transferId, fileIndex, offset, data: base64(bytes) })).fileChunk;
            if (!sameReceipt(receipt, record, ["leaseId", "generation", "chooserId", "transferId", "fileIndex", "nextOffset"]) ||
                receipt.fileIndex !== fileIndex || receipt.nextOffset !== end) throw Error("File chunk receipt does not match");
            assertActive(record);
            completed += bytes.length; offset = end;
            notice = `正在传输文件：${completed.toLocaleString()} / ${manifest.total.toLocaleString()} 字节`; changed();
          }
        }
        assertActive(record);
        record.phase = "committing"; notice = "文件已传完，正在等待网页接收…"; changed();
        const receipt = (await request("humanFileCommit", { ...tuple(record), transferId: record.transferId })).fileChooserReceipt;
        if (!sameReceipt(receipt, record, ["leaseId", "generation", "chooserId", "transferId", "acknowledged"]) || receipt.acknowledged !== true)
          throw Error("Original file submission is unconfirmed");
        // Navigation/End may precede this original ACK. Never send another
        // commit, and never let an old completion change a successor chooser.
        record.phase = "finished";
        clearTimeout(record.timer);
        if (record.displayEpoch === displayEpoch) {
          notice = "网页已接收所选文件。完成接管后，Agent 仍可继续提交这些文件。";
          changed();
        }
      } catch (error) { fail(record, error); }
    }
    async function cancel() {
      if (!pending || !enabled || picker || transfer?.phase === "committing" || transfer?.phase === "cancelling") return;
      const original = pending, previous = transfer;
      if (previous) { previous.retired = true; clearTimeout(previous.timer); } // Stops any next chunk before awaiting cancellation.
      const record = { ...tuple(original), ...(previous?.transferId ? { transferId: previous.transferId } : {}), phase: "cancelling", retired: false, displayEpoch };
      transfer = record; notice = "正在取消本次选择…"; changed();
      try {
        const receipt = (await request("humanFileCancel", { ...tuple(record), ...(record.transferId ? { transferId: record.transferId } : {}) })).fileChooserCancellation;
        const fields = ["leaseId", "generation", "chooserId", "cancelled", ...(record.transferId ? ["transferId"] : [])];
        if (!sameReceipt(receipt, record, fields) || receipt.cancelled !== true) throw Error("File cancellation unconfirmed");
        record.phase = "finished";
        if (record.displayEpoch === displayEpoch) { notice = "本次选择已取消，网页原有文件保持不变。"; changed(); }
      } catch (error) { fail(record, error); }
    }
    e["file-choose"].addEventListener("click", event => {
      if (event.isTrusted !== true || !pending || !enabled || !inputIdle || transfer || picker) return;
      const original = pending;
      e["file-picker"].multiple = original.multiple;
      e["file-picker"].value = "";
      picker = { key: key(original), timer: setTimeout(() => {
        clearPicker(); notice = "文件选择等待超时，正在结束接管。"; changed(); onFatal(notice);
      }, 600000) };
      notice = "请选择要交给此网页的文件。"; changed();
      try { e["file-picker"].click(); }
      catch { clearPicker(); notice = "无法打开本地文件选择。请重新选择或取消。"; changed(); }
    });
    e["file-picker"].addEventListener("change", () => {
      const original = pending;
      if (!picker || picker.key !== key(original) || !enabled) { clearPicker(); return; }
      const files = Array.from(e["file-picker"].files ?? []);
      clearPicker();
      if (files.length) void upload(files, original);
      else void cancel();
    });
    e["file-picker"].addEventListener("cancel", () => {
      if (!picker || picker.key !== key(pending) || !enabled) { clearPicker(); return; }
      clearPicker(); void cancel();
    });
    e["file-cancel"].addEventListener("click", () => { void cancel(); });
    return {
      accept,
      update(allowed, idle) { enabled = allowed; inputIdle = idle; render(); },
      retire() { retire(); enabled = false; render(); },
      reset() { retire(); displayEpoch++; pending = transfer = null; identities.clear(); notice = ""; render(); },
      pickerActive() { return Boolean(picker && enabled && picker.key === key(pending)); },
    };
  }
  return { create, validPending };
})();
