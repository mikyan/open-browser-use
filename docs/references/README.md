# 外部参考资料

这个目录用于沉淀那些值得长期放进仓库、供 Agent 直接读取的外部参考材料。

适合放这里的内容包括：

- 团队会反复依赖的框架、部署或接入说明。
- 设计系统参考、API 使用约定。
- 对外标准、合作方协议或外部文档的简要整理版。

不要把大段供应商文档原样塞进来。这里应该是经过筛选和整理后的资料。

长期演进的项目知识放在 `docs/wiki/`。例如 Browser Use 客户端的增量逆向
结论维护在 `docs/wiki/browser-client/`，这里的 reference 文档保留首次分析
的来源型记录。

## 已沉淀资料

- [Browser action protocol](browser-action-protocol.md)：公开 Playwright engine
  动作与定位器协议、固定依赖版本、构建方式和已知限制。
- [Local IPC transport](local-ipc-transport.md)：Windows named pipe、Unix socket、
  endpoint discovery 与跨语言帧协议。
- [Native message transport](native-message-transport.md)：浏览器 1 MiB 出口
  上限、私有分片协商、有界组装、原预算和旧版本兼容。
- [Browser control lifecycle](control-lifecycle.md)：持久 control epoch、结束与恢复、
  客户端显式开启新轮次，以及取消不能撤销已投递输入的边界。
- [File transfers](file-transfers.md)：上传拦截准备、跨 frame 来源、清空文件、
  按任务等待下载和当前本地路径查找限制。
- [Network waits](network-waits-design.md)：已实现的两阶段 request/response
  等待契约，说明 ready/trigger/collect、同步入口、deadline、资源上限与控制权隔离。
- [Navigation waits](navigation-waits.md)：URL/loadstate 的原生等待语义、独立
  注册/完成阶段、同步客户端 ready handle、取消与控制权边界。
- [Website access settings](site-access-policy.md)：popup 独占的持久 origin
  规则、完整 frame 检查、受限入口、暂停保存与网络防火墙之外的实际边界。
- [Page exports](page-exports.md)：PDF 流关闭、MHTML 字节与网站边界、任务
  生命周期、三个 SDK 和 CLI/MCP 原子创建文件契约。
- [Codex observation baseline](codex-observation-baseline.md)：隔离合成页面上的
  IAB 只读快照基线及其有限范围，不等同于输入、性能或完整能力对齐验收。
- [AI snapshot design](ai-snapshot-design.md)：已实现的有界递归 `snapshotAI` 与
  capture ref 契约，记录历史错路由证据、可信 metadata、失效与资源边界；
  附本片 Windows 真实浏览器验收范围，完整 Codex 任务对照仍待完成。
- [Popup ownership design](popup-ownership-design.md)：跨窗口移组造成渲染停滞的
  正负对照，以及已实现并验收的独立窗口归属与回收；原生创建焦点仍有缺口。
- [Headed browser startup](headed-browser-startup.md)：Windows 隔离验收中首窗口
  原生首帧停滞的对照证据、固定版本源码和诊断限制。
- [Edge 安装与发现](edge-installation.md)：Edge Stable selector、独立 native host
  manifest/registry、手动 ZIP 安装和实际 Windows 验证范围。
- [Clipboard](clipboard.md)：可信隐藏文档、有限富内容契约、真实写入结算、
  SDK/CLI/MCP 接口与隔离内存剪贴板验收边界。
- `chrome/0.1.7/skills/chrome/SKILL.md`：OpenAI bundled Chrome plugin
  `0.1.7` 的官方 Chrome skill 原文快照，用于对照官方 browser session、
  tab claiming、file upload 和 tab cleanup 约定；后续版本按同一路径新增。
- `codex-chrome-extension-1.1.4/`：Codex Chrome Web Store extension
  `hehggadaopoacecdllhhajmbjkdcmajg` 的本机安装快照、格式化入口文件和
  native messaging host 形状记录。
