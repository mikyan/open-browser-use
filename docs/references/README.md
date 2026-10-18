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

- [Managed 人工网页弹窗](managed-human-dialogs.md)：原生提示、确认和输入框的
  人工回答、独立回执、结束接管清理及已知期限/范围。

- [Managed 五入口完整流程](managed-entrypoint-workflow.md)：正式JS/Python/Go/
  CLI/MCP原业务、实时查看、原文件与只读OS观测，以及内部候选和发布边界。

- [独立浏览器会话](managed-browser-session.md)：实验性 Windows launcher、
  CLI/MCP 选择、真实 Native Messaging 和进程清理，以及 viewer/登录边界。

- [Managed worker 替换恢复](managed-worker-recovery.md)：原结果持久记录、
  明确恢复与新权限、原查看附件清理、未知输入拒绝及原会话停止边界。

- [两轮完整任务对照](paired-task-comparison.md)：固定 24 次原始尝试、失败保留、
  正式 API/业务/清理证据与有限结论；附脱敏 SHA 索引。

- [Raw frame feedback](raw-frame-feedback.md)：已初始化 Page 的坐标叶节点读取、
  原临时对象释放与调用方期限分离；冷 CDP 的独立失败及未完成边界。
- [Visual delivery cleanup](visual-delivery-cleanup.md)：原可视消息结算、精确
  接收器退役与最终隐藏，BFCache 本地 frame 恢复及 worker 清理边界。
- [Frame target feedback](frame-target-feedback.md)：iframe 内原操作元素的边框
  快照、坐标投影、迟到反馈与实际读取清理；原始红绿验收及未完成边界。
- [Restricted page downloads](restricted-page-downloads.md)：允许网站的原始
  Blob 文档来源、同 GUID 文件交付与实际清理；受限 HTTP/POST 和最终实机验收边界。
- [Restricted file choosers](restricted-file-chooser.md)：允许网站上的原生上传、
  原文档与节点归属、真实操作清理及当前 Codex IAB 的有限对照。
- [DOM rebuild feedback](dom-rebuild-feedback.md)：同文档根节点重建后的光标、
  目标框与点击圈恢复，原图层归属、迟到动画及隐藏清理边界。
- [Zoom feedback](zoom-feedback.md)：根 CSS 缩放下的光标、目标框及点击圈
  对齐，原表单/像素证据、正文缩放对照和动态刷新边界。
- [Top-layer feedback](top-layer-feedback.md)：HTML 模态框与 popover 上方的
  光标/目标反馈、Shadow DOM 事件隔离、原提交与像素证据及正常结束清理。

- [Native JavaScript dialogs](native-dialogs.md)：显式决定、订阅准备与原生 ACK、
  五个公开入口的原 scope 示例，以及取消和失败不重放的边界。
- [Keyboard chords](keyboard-chords.md)：完整键名校验、预持输入及部分原生失败
  的原动作期限和附件清理边界。
- [Fill delivery](fill-delivery.md)：原编辑宿主输入回执、setter 与格式化语义、
  原租约清理和禁止提交后重放的边界。
- [Ordinary-start Edge downloads](normal-browser-downloads.md)：独立正常启动、
  人工授权、真实 Native Messaging 与原文件业务验收的执行和证据边界。
- [Hover delivery](hover-delivery.md)：原目标悬停事件确认、菜单及目标变化语义、
  已确认持输入兼容、原attachment错误恢复与真实验收边界。
- [Screenshot completion](screenshot-completion.md)：截图调用超时与实际原生完成
  的区分、原 attachment 渲染队列和 Pause 清理屏障，以及受控 ACK 验收边界。
- [Transformed element bounds](transformed-element-bounds.md)：正式元素边界框与
  截图的跨renderer四角投影、剩余期限、无布局语义和独立像素验收。
- [Browser action protocol](browser-action-protocol.md)：公开 Playwright engine
  动作与定位器协议、固定依赖版本、构建方式和已知限制。
- [Pointer delivery](pointer-delivery.md)：普通单击按下前的目标投递确认、
  有界准备移动、并发原生输入隔离与禁止重放已提交点击的边界。
- [Local IPC transport](local-ipc-transport.md)：Windows named pipe、Unix socket、
  endpoint discovery 与跨语言帧协议。
- [SDK connection identity](sdk-connection-identity.md)：实际连接固定、断线终态、
  新client显式恢复，以及原生IPC与真实浏览器验收的不同边界。
- [Native message transport](native-message-transport.md)：浏览器 1 MiB 出口
  上限、私有分片协商、有界组装、原预算和旧版本兼容。
- [Browser control lifecycle](control-lifecycle.md)：持久 control epoch、结束与恢复、
  客户端显式开启新轮次，以及取消不能撤销已投递输入的边界。
- [Browser lifetime](browser-lifetime.md)：跨浏览器重启的归属隔离、输入风险持久化、
  原标签销毁与保守的启动见证恢复，以及真实重启验收的边界。
- [File transfers](file-transfers.md)：上传拦截准备、跨 frame 来源、清空文件、
  按任务等待下载和当前本地路径查找限制。
- [Original page download delivery](original-page-download-delivery.md)：当前Codex
  原POST/Blob对照、正式Host绑定与同GUID路径/取消，以及普通安装和验收边界。
- [Current session connection](current-session-connection.md)：显式Chrome/Edge端口
  文件发现、原连接身份与授权总期限，以及真实浏览器授权尚待验收的范围。
- [Locator file uploads](locator-file-upload.md)：隐藏file input的直接路径上传、
  与chooser共用的节点锁、目录完成及五入口验收边界。
- [Network waits](network-waits-design.md)：已实现的两阶段 request/response
  等待契约，说明 ready/trigger/collect、同步入口、deadline、资源上限与控制权隔离。
- [Original response bodies](original-response-bodies.md)：原诊断响应的五入口
  正文读取、禁止 URL 重取、跨进程身份、有界并发与取消后的实际清理。
- [Navigation waits](navigation-waits.md)：URL/loadstate 的原生等待语义、独立
  注册/完成阶段、同步客户端 ready handle、取消与控制权边界。
- [Website access settings](site-access-policy.md)：popup 独占的持久 origin
  规则、完整 frame 检查、受限入口、暂停保存与网络防火墙之外的实际边界。
- [Page exports](page-exports.md)：PDF 流关闭、MHTML 字节与网站边界、任务
  生命周期、三个 SDK 和 CLI/MCP 原子创建文件契约。
- [Media downloads](media-downloads.md)：精确图片定位器、utility world 原生选源、
  原始预算与真实清理、三个 SDK 和 CLI/MCP 入口及新 GET 的语义边界。
- [Codex observation baseline](codex-observation-baseline.md)：隔离合成页面上的
  IAB 只读快照基线及其有限范围，不等同于输入、性能或完整能力对齐验收。
- [Shared research workflow](shared-research-workflow.md)：五个公开入口、三种
  布局的多页资料比较与报告交付任务，独立服务端评分、原始请求和标签生命周期
  证据，以及独立 Codex 对照和有限任务验收的边界。
- [AI snapshot design](ai-snapshot-design.md)：已实现的有界递归 `snapshotAI` 与
  capture ref 契约，记录历史错路由证据、可信 metadata、失效与资源边界；
  附本片 Windows 真实浏览器验收范围，完整 Codex 任务对照仍待完成。
- [Snapshot geometry](snapshot-geometry.md)：opt-in 元素位置、frame/ownerRef
  关系、视口 CSS 坐标与截图/点击坐标的边界，以及原限额和capture失效规则。
- [Element position geometry](element-position-geometry.md)：元素 padding 局部位置、
  原生 quad 投影、叶元素变化复查和跨 renderer 量化边界。
- [Transformed iframe input](transformed-frame-input.md)：按实际 renderer 边界
  投影点击坐标、逐层遮挡检查、原几何指纹与提交后不重放的验收边界。
- [Drag delivery](drag-delivery.md)：原拖动源和目标、按下后不重放、原生
  dragover/drop 提交检查，以及未知清理完成与资源回收的验证边界。
- [MCP connection lifetime](mcp-connection-lifetime.md)：长期stdio会话固定实际
  浏览器连接、后台通知消费、超时与断线恢复边界，以及不跨实例重放的验证。
- [Popup ownership design](popup-ownership-design.md)：跨窗口移组造成渲染停滞的
  正负对照，以及已实现并验收的独立窗口归属与回收；原生创建焦点仍有缺口。
- [Created-page waits](created-page-waits.md)：正式等待接口、原scope返回页与同网址双任务原生后台子页的
  来源事件、实际文档与提交证据，以及待完成的五入口和生命周期验收。
- [Ungrouped task tabs](ungrouped-task-tabs.md)：短命原生标签组的兼容接纳、
  新建页事务、显式普通页归属和交付/回收边界。
- [Background task windows](background-windows.md)：显式不聚焦窗口、混合任务归属、
  目录上传用途及仅关闭本任务页面的清理契约。
- [Headed browser startup](headed-browser-startup.md)：Windows 隔离验收中首窗口
  原生首帧停滞的对照证据、固定版本源码和诊断限制。
- [Background idle and concurrent rendering](background-parallel-workflow.md)：
  长时间后台闲置、多任务同时操作与独立收尾的实测契约及证据边界。
- [Edge 安装与发现](edge-installation.md)：Edge Stable selector、独立 native host
  manifest/registry、手动 ZIP 安装和实际 Windows 验证范围。
- [Chromium 浏览器安装与发现](chromium-browser-installation.md)：官方浏览器
  来源、共享 native host 注册位置与隔离真实 launcher 验证边界。
- [Vivaldi 首文档诊断](vivaldi-initial-document.md)：原生提交状态、早期调试器
  连接的上游机制，以及独立于生产验收的单变量诊断边界。
- [Vivaldi 文本输入诊断](vivaldi-input-diagnostic.md)：原始输入命令、被动页面
  事件与真实提交的对照，区分命令 ACK、底层焦点和实际填值。
- [Clipboard](clipboard.md)：可信隐藏文档、有限富内容契约、真实写入结算、
  SDK/CLI/MCP 接口与隔离内存剪贴板验收边界。
- `chrome/0.1.7/skills/chrome/SKILL.md`：OpenAI bundled Chrome plugin
  `0.1.7` 的官方 Chrome skill 原文快照，用于对照官方 browser session、
  tab claiming、file upload 和 tab cleanup 约定；后续版本按同一路径新增。
- `codex-chrome-extension-1.1.4/`：Codex Chrome Web Store extension
  `hehggadaopoacecdllhhajmbjkdcmajg` 的本机安装快照、格式化入口文件和
  native messaging host 形状记录。
