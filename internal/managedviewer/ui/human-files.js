"use strict";

// The viewer supplies names, relative directory paths and bytes. Temporary paths and the original
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
      Object.keys(value).every(name => ["leaseId", "generation", "chooserId", "multiple", "source", "directory"].includes(name)) &&
      [1, 2].includes(owner?.fileChooserVersion) && ["preparing", "active", "navigating"].includes(owner.state) &&
      (owner.fileChooserVersion === 2 ? typeof value.directory === "boolean" : !Object.hasOwn(value, "directory")) &&
      value.leaseId === owner.leaseId && value.generation === owner.generation &&
      Number.isSafeInteger(value.generation) && value.generation > 0 && identifier(value.chooserId) &&
      typeof value.multiple === "boolean" && (!Object.hasOwn(value, "source") || validSource(value.source)));
  }
  function validName(name) {
    return typeof name === "string" && name.isWellFormed() && name.length > 0 && new TextEncoder().encode(name).length <= 240 &&
      !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) && !/[. ]$/.test(name) && name !== "." && name !== ".." &&
      !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/.test(name.toUpperCase());
  }
  // Unicode-aware regex comparison uses simple case folding, without expanding
  // names such as ß into multiple characters or silently normalizing spelling.
  const equalFold = (a, b) => new RegExp("^" + a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "iu").test(b);
  function metadata(files, multiple, directory) {
    if (!files.length || files.length > 16 || !directory && !multiple && files.length !== 1) throw Error("请选择符合网页要求的文件，最多 16 个。");
    let total = 0;
    let root = "";
    const tree = [];
    const values = files.map(file => {
      const name = file.name;
      if (!validName(name))
        throw Error("文件名不受支持。请使用不含路径、特殊字符或 Windows 保留名称的文件名。");
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxFileBytes) throw Error("每个文件最多 32 MiB。");
      total += file.size;
      const value = { name, size: file.size };
      if (directory) {
        const path = file.webkitRelativePath;
        if (typeof path !== "string" || !path.isWellFormed() || new TextEncoder().encode(path).length > 1024)
          throw Error("无法读取所选文件夹的相对路径。");
        const parts = path.split("/");
        if (parts.length < 2 || parts.length > 16 || !parts.every(validName) || parts.at(-1) !== name || root && root !== parts[0])
          throw Error("请选择一个文件夹；目录层级或文件名不受支持。");
        root = parts[0];
        for (let i = 0; i < parts.length; i++) {
          const current = parts.slice(0, i + 1).join("/"), leaf = i === parts.length - 1;
          const previous = tree.find(entry => equalFold(entry.path, current));
          if (previous && (previous.path !== current || previous.leaf || leaf))
            throw Error("所选目录中存在重名、大小写冲突或文件与文件夹冲突。");
          if (!previous) tree.push({ path: current, leaf });
        }
        value.relativePath = path;
      } else if (file.webkitRelativePath !== undefined && file.webkitRelativePath !== "") {
        throw Error("网页请求普通文件，请重新选择文件。");
      }
      return value;
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
      e["file-title"].textContent = pending?.directory ? "网页请求选择文件夹" : "网页请求选择文件";
      e["file-choose"].textContent = pending?.directory ? "选择本地文件夹" : "选择本地文件";
      e["file-cancel"].disabled = !visible || Boolean(picker) || transfer?.phase === "committing" || transfer?.phase === "cancelling";
      const source = pending?.source;
      e["file-source"].textContent = !visible ? "" : source ? `来源：${source.frame === "child" ? "子页面" : "主页面"} · ${source.origin}` : "来源未提供";
      e["file-description"].textContent = !inputIdle ? "请先松开按键和鼠标，等待原操作确认后再选择文件。" :
        pending?.directory ? "将上传所选文件夹中的文件并保留层级。最多 16 个文件，单个最多 32 MiB，合计最多 64 MiB；空子文件夹不会上传。" :
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
        const descriptor = JSON.stringify([value.multiple, value.directory, value.source?.origin ?? "", value.source?.frame ?? ""]);
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
      try { manifest = metadata(files, original.multiple, original.directory === true); }
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
      e["file-picker"].webkitdirectory = original.directory === true;
      e["file-picker"].value = "";
      picker = { key: key(original), timer: setTimeout(() => {
        clearPicker(); notice = "文件选择等待超时，正在结束接管。"; changed(); onFatal(notice);
      }, 600000) };
      notice = original.directory ? "请选择要交给此网页的文件夹。" : "请选择要交给此网页的文件。"; changed();
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
