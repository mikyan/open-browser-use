# 架构总览

这个仓库当前目标是实现 Open Browser Use：一套开源 Browser Use 风格的
Chrome 浏览器自动化基础设施。

当前 `main` 分支只保留 Chrome route：MV3 Chrome extension + Go native
messaging host + SDK。这条路线用于接管用户真实 Chrome profile 中的 tabs、
debugger、history 和 tab groups。

已完成的 Chrome route 执行计划：

- `docs/exec-plans/completed/2026-05-08-open-browser-use-chrome-route.md`

已有 Browser Use / Codex extension 逆向知识沉淀在：

- `docs/wiki/browser-client/`
- `docs/references/`

## 预期的仓库结构

- `apps/chrome-extension/`：Open Browser Use MV3 Chrome extension，包含
  readable service worker、cursor content script 和 popup。
- `cmd/open-browser-use/`：Go native messaging host 和 CLI 主入口。二进制
  正式名是 `open-browser-use`，可通过同路径 symlink 或 shell alias 暴露为
  `obu`。
- `internal/host/`：Go native messaging stdio 到本地 IPC endpoint 的中继。
- `internal/transport/`：Unix socket 与 Windows 当前用户 named pipe 的平台边界。
- `internal/wire/`：Open Browser Use native frame codec。
- `packages/browser-client-rewrite/`：当前 Browser Use client 的可读重写
  和协议行为参考。
- `packages/browser-use-protocol/`：Browser Use JSON-RPC native pipe frame、
  请求/响应类型和测试工具。
- `packages/open-browser-use-cli/`：npm 上发布的 `open-browser-use` 二进制
  CLI 包，暴露 `open-browser-use` 和 `obu` 两个命令，发布时只打包 Go CLI
  预构建二进制，不打包 Chrome extension。
- `packages/open-browser-use-js/`：JavaScript/TypeScript SDK，npm distribution
  名为 `open-browser-use-sdk`。
- `packages/open-browser-use-python/`：Python SDK，PyPI distribution 名为
  `open-browser-use-sdk`，import 模块名为 `open_browser_use`。
- `packages/open-browser-use-go/`：Go SDK，Go import path 为
  `github.com/ifuryst/open-browser-use/packages/open-browser-use-go`，package
  name 为 `obu`。
- `skills/open-browser-use/`：面向 AI Agent 的 Open Browser Use skill，说明
  如何安装、验证和使用浏览器插件、CLI、SDK 与 Browser Use 风格协议。
- `packages/`：其他跨应用复用的库、契约和共享能力。
- `infra/`：部署、基础设施和环境定义。
- `scripts/`：仓库级自动化脚本，供人和 Agent 直接调用。
- `docs/`：仓库知识库，也是本地规则和上下文的正式来源。
- `docs/wiki/`：长期演进的主题知识库，用于沉淀可持续追加的调研、
  逆向和架构理解。

## 边界建议

- 业务逻辑优先沉淀到可复用包里，不要一开始就散落在各个 app 中。
- 基础设施和运行编排要显式版本化，不要藏在手工操作里。
- 避免隐式跨包耦合；一旦仓库成形，就把允许的依赖方向写清楚。
- 只要架构有变化，就同步更新这份文档。

## Open Browser Use Chrome Route

Chrome route 的目标拓扑：

```text
upper-layer runtime / SDK / CLI
  -> Unix socket / Windows current-user named pipe
  -> open-browser-use Go native host
  -> Chrome Native Messaging stdio
  -> Open Browser Use MV3 service worker
  -> chrome.tabs / chrome.debugger / chrome.history / chrome.tabGroups
  -> user's real Chrome profile
```

Chrome native messaging host name 固定为：

```text
com.ifuryst.open_browser_use.extension
```

Chrome native messaging host name 只能使用小写字母、数字、underscore 和
dot；hyphen 版本 `com.ifuryst.open-computer-use.extension` 会被
`chrome.runtime.connectNative` 直接拒绝。

当前 M1 骨架已经提供：

- native-endian 4-byte length-prefixed JSON frames。
- host→extension 原生帧遵守浏览器 1 MiB 上限。扩展每个 port 的私有 hello
  协商大请求分片，最大完整请求为重写后的 64 MiB；只有完整 commit 进入
  原有 RPC 与控制权检查。旧扩展不协商时大请求明确拒绝且保留连接。
  组装、预算与兼容边界见 `docs/references/native-message-transport.md`。
- Windows host 使用当前用户 ACL 的本地 byte-mode named pipe；`active.json`
  保留 `socketPath` 字段并写入实际 pipe 路径，独立 endpoint descriptor 支持多个
  实例发现。macOS/Linux 继续使用 AF_UNIX。只有确认 endpoint 不存在时才删除
  stale 记录，权限拒绝和连接超时不会删除其他实例的记录。
  详见 `docs/references/local-ipc-transport.md`。
- relay 只将 notification 广播到连接的 SDK；带未知 id 的响应直接丢弃，避免
  已断开客户端的迟到结果进入其他会话。SDK 不自动重放超时的浏览器操作。
- `open-browser-use host`：启动 Chrome native messaging stdio 到 SDK 本地
  IPC endpoint 的中继；Unix 默认路径为 `/tmp/open-browser-use/<uuid>.sock`，
  Windows 默认使用 `\\.\pipe\open-browser-use-<uuid>`。Unix registry 位于
  `/tmp/open-browser-use/active.json`，Windows 位于系统临时目录下的
  `open-browser-use/active.json`，供 CLI/SDK 自动发现当前活跃 endpoint。
  Chrome native messaging 以 `chrome-extension://...` origin 参数启动二进制时，
  CLI 会自动进入 host mode。
- 无参数运行 `open-browser-use` 或 `obu` 输出 CLI 版本、浏览器插件检测状态、
  插件版本和下一步安装/升级命令，不再启动 native host；手工启动 host 使用
  `open-browser-use host`。
- `open-browser-use manifest`：输出 Chrome native messaging host manifest。
- `open-browser-use install-manifest`：把 native messaging host manifest
  写入 Chrome 默认位置，或通过 `--output` 写到指定路径。默认 extension id
  是 Chrome Web Store 版 `bgjoihaepiejlfjinojjfgokghnodnhd`。
  Windows 默认写入
  `%LOCALAPPDATA%\OpenBrowserUse\NativeMessagingHosts\com.ifuryst.open_browser_use.extension.json`，
  并注册
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ifuryst.open_browser_use.extension`
  的默认值指向该 manifest。
- Edge Stable 使用 `install-manifest --browser edge` 和独立 Edge manifest/registry，
  `setup --zip ... --browser edge --no-open` 提供手动 unpacked 安装入口；未知 selector
  在写入前失败，`--output` 仅导出而不注册。浏览器目录及验证边界见
  `docs/references/edge-installation.md`。
- Windows Brave、Opera Stable、Vivaldi 增加安装和默认 profile 发现入口。
  它们与 Chrome 共用 Google native host namespace，合法已有 origin 合并保留，
  冲突在替换 host 前拒绝；共享稳定 host 的安装使用进程间锁。`--output`
  仍只导出并准备稳定 host，不检查或修改注册。自动分发与自动启动不支持，
  本地 ZIP 需 `--no-open`；真实 launcher 与平台范围见
  `docs/references/chromium-browser-installation.md`。
- `open-browser-use setup`：显式安装流程，先调用 native host manifest
  注册，再写入 Chrome External Extensions JSON。只有检测到浏览器插件未安装或
  版本低于当前 CLI 期望版本时，CLI 才打开 Chrome Web Store 正式扩展页，引导
  用户手动安装或启用扩展。macOS/Windows 仍可能需要用户在 Chrome 中确认启用
  扩展并重启；Linux 的 External Extensions 写入默认使用 Chrome 官方系统路径，
  可能需要更高权限。传入 `--zip <本地路径>` 时不走 Web Store，而是复用 keyed
  manual-install 流程：展开本地 ZIP、写入稳定 fallback key、原地重新打包并注册
  对应 extension id 的 native host，然后按需打开扩展页和文件管理器。
- `open-browser-use setup beta`：Chrome Web Store 临时不可用时的备用路径，
  注册 native host 后从 GitHub Releases 下载最新
  `open-browser-use-chrome-extension-*.zip`。CLI 会在本地 unpacked 目录和待拖入
  Chrome 的 ZIP 中写入稳定 beta public key，用该 id 注册 native host allowed
  origin；只有检测到浏览器插件未安装或版本低于当前 CLI 期望版本时，才打开
  `chrome://extensions/` 和 Finder/文件管理器，引导用户把这个 ZIP 拖到扩展页面
  手动安装；GitHub Release 中的正式 zip 本身保持为 Chrome Web Store 上传包，
  不再预写 beta key。setup 过程中如果本机已有可用的 `npx skills`，会
  best-effort 执行 `npx skills update open-browser-use -g -y` 更新已有 agent
  skill；未检测到 skills 时只展示 Codex 和 Claude Code 的安装命令。原有
  `setup beta --zip <本地路径>` 继续兼容，但本地包的首选入口是
  `setup --zip <本地路径>`。
- manifest 的 `path` 默认统一写入稳定 native host link：
  macOS 为
  `~/Library/Application Support/OpenBrowserUse/native-host/open-browser-use`，
  Linux 为 `~/.local/share/open-browser-use/native-host/open-browser-use`。
  Windows 为
  `%LOCALAPPDATA%\OpenBrowserUse\native-host\open-browser-use.exe`。macOS/Linux 上
  `install-manifest --path` 表示这个稳定 link 指向的真实二进制 target；Windows
  上会把 target 复制到稳定 exe 路径，避免依赖开发者模式或管理员权限创建 symlink。
- npm 包 `open-browser-use` 是 CLI 二进制分发入口，安装后提供
  `open-browser-use` 和 `obu`；`postinstall` 只提示用户运行显式
  `open-browser-use setup`。
- SDK 发布包在 npm 和 PyPI 上统一命名为 `open-browser-use-sdk`，避免和 npm
  CLI 包 `open-browser-use` 混淆。JavaScript 使用
  `import { ... } from "open-browser-use-sdk"`；Python distribution 安装名是
  `open-browser-use-sdk`，代码 import 模块名仍是 `open_browser_use`。
- 开发版 `browserAction` 由 extension 内真正的 Playwright CRX 引擎执行。
  JS/Python 的定位器和语义快照发送有限的可序列化描述；Go 提供同协议 wrapper，
  CLI/MCP 通过现有 `call` 使用。单 tab 动作排队、请求 deadline 覆盖排队和
  attachment、结束控制时取消等待，所有动作仍检查 session/tab ownership。
  原生 CDP 与引擎通过共享 attachment/focus/光标反馈 hooks 协作。
  MV3 worker 静态加载 `browser-runtime.js`；构建复制固定版本 ESM 和版权文件
  到 `dist/chrome-extension-unpacked/`，不把第三方生成 bundle 提交到源码。
  协议、构建和版本限制见 `docs/references/browser-action-protocol.md`。
  普通无修饰键单击在原utility interceptor内独立记录目标mouse pointermove
  receipt，以实际局部坐标命中原节点，不与近似framePoint作数值等价比较；
  原生ACK及当前receipt确认后才按下；只在按钮尚未提交时按原cadence重新
  准备移动。CRX参数的私有WeakMap ticket与raw CDP共享attachment输入账本，
  外来Input使ticket失效，持久化等待后仍检查原deadline/context。已提交
  按钮不会因新增错误重放；hover副作用、事件来源及变换frame限制见
  `docs/references/pointer-delivery.md`。
  `snapshotAI` 递归读取 iframe 的原生 ARIA 树，限制总字节、节点、refs、frames
  和深度；renderer 提供真实元素 metadata，Frame 身份使用稳定 slot，避免
  iframe 重排使引用串页。每个 attachment 只保留一个 capture；新快照、frame
  生命周期或控制结束使旧引用失效。JS/Python/Go 与 CLI/MCP 共享这个有限
  契约；普通 selector 使用原生解析器阻止未绑定 capture 的 `aria-ref`。
  opt-in `boxes` 在同次 renderer 观察中读取实际元素位置和 frame 视口；
  runtime 对照真实 Frame 身份后发布有界 `geometry`。坐标明确属于各自
  frame 的 CSS 视口，不假设 iframe 平移足以组合父级变换，详见
  `docs/references/snapshot-geometry.md`。
  截图通过引用记录的真实 Frame 预滚 owner，capture ID 不承担身份认证。
  生产 CRX 禁用基于 `tabs.onCreated` 的 popup 隐式 Page attachment；新 tab
  必须先经过 backend 归属与 admission，OOPIF 子 session 发现仍保留。
  frame 元素截图先由外到内滚动 owner，避免离屏子 renderer 的稳定性等待
  挂起；每步仍使用同一剩余 deadline 和控制权检查。显式 claim 独立 popup
  时通过 auxiliary ownership 保留其原窗口，避免移组造成首次点击超时。
  原生 popup 创建抢前台和用户自行跨窗口移动后的渲染恢复仍有缺口。
- Homebrew formula 从 GitHub Release 下载平台匹配的预编译 CLI tarball，
  安装后提供 `open-browser-use` 和 `obu`，并在 caveats 中提示用户运行显式
  `open-browser-use setup`；安装阶段不依赖 Go，也不在用户机器上编译。
- CLI 命令层使用 Cobra 实现；Chrome native messaging
  `chrome-extension://...` origin 参数启动时会绕过 Cobra，直接进入 host mode。
  这依赖 Chrome Native Messaging 的标准启动形状：MV3 service worker 调用
  `chrome.runtime.connectNative(...)` 后，Chrome 以 host manifest 中的可执行文件
  路径启动进程，并把调用方 extension origin 作为第一个 argv 传入。manifest
  自身不承载额外自定义 argv，因此 Chrome extension 专用启动信号使用这个
  Chrome 提供的 origin argv。Windows Chrome 还可能只暴露 `--parent-window=<handle>`
  形状，因此 CLI 也把该参数识别为 native host mode。
- `open-browser-use call`：通用 JSON-RPC 入口，允许上层应用发送
  公开 method/params；extension 使用显式方法 allowlist，拒绝原型与内部 helper。
  未显式传入 `--socket` 时会优先读取 active socket
  registry。registry 缺失时，CLI 会扫描 `--socket-dir` 下的 `*.sock` 与
  Windows endpoint descriptor 并连接可用实例，连接成功后修复 active registry；
  确认旧 endpoint 不存在时才删除 stale 记录，再尝试目录扫描。
  CLI 和复用同一 runner 的 MCP tools 会按 JSON-RPC request id 等待对应响应，
  跳过其间插入的 `heartbeat`、CDP event 等 notification，避免把通知误当成命令结果。
- `open-browser-use run`：line-oriented action plan 入口，支持一次执行多条
  CLI action，保留同一个 session/turn，并让 `open-tab`/`claim-tab` 设置默认
  tab，供后续 `wait-load`、`page-info`、`navigate`、`cdp` 等 tab-scoped action
  复用；默认和普通 CLI 子命令使用同一个 `obu-cli` browser session，因此
  一次 `finalize-tabs` 可以清理两种调用方式打开的 tabs；需要隔离 tab group
  和清理范围时可以显式传 `--session-id`。它不是通用编程语言，适合 shell、
  CI 和轻量 agent 编排。
- `open-browser-use mcp` / `obu mcp`：stdio MCP server 入口，使用
  newline-delimited JSON-RPC，完成 `initialize` 生命周期握手，并暴露
  `tools/list` 与 `tools/call`。MCP tools 复用 CLI/runner 能力，包括
  `user_tabs`、`open_tab`、`navigate`、`page_info`、`cdp`、
  `run_action_plan`、`finalize_tabs` 和通用 `call`，适合 Codex
  等支持本地 MCP server 的 agent runtime 直接接入。
- CLI 便捷子命令覆盖当前 SDK 核心能力：`ping`、`info`、`tabs`、
  `user-tabs`、`history`、`open-tab`、`navigate`、`claim-tab`、
  `finalize-tabs`、`name-session`、`cdp`、`move-mouse`、
  `wait-file-chooser`、`set-file-chooser-files`、`turn-ended`、`begin-turn`、
  `control-state`、`profiles`。
- Multi-browser / multi-profile 支持：`open-browser-use profiles` 扫描 Chrome
  Stable、Chrome Beta、Edge Stable、平台支持的 Brave/Opera/Vivaldi 和 BitBrowser
  user-data roots，在每个 profile 目录中
  通过 CRX 与 unpacked 两条路径找到已经装好插件的 profile，附带 browser id、
  browser display name、profile directory 和展示名（来自
  `Local State.profile.info_cache`）。所有面向用户的命令支持
  `--browser <chrome|chrome-beta|edge|brave|opera|vivaldi|bitbrowser|displayName|instance>` 和
  `--profile <directory|displayName>`：CLI 枚举 `socket-dir` 下的 `.sock`
  文件，对每个连通的 socket 调用 `getInfo`，把
  `metadata.extensionInstanceId` 反查到 browser/profile（grep 每个支持 browser
  root 的 `Local Extension Settings/<extension-id>/*.{log,ldb}`）。只有唯一匹配
  profile 才能归属品牌；复制 UUID 的多个匹配明确保留歧义，按 selector
  选出匹配 socket。`obu mcp --browser ... --profile ...` 在首次浏览器工具调用
  时选择实际连接，随后在stdio服务期间固定同一连接；active registry、候选
  顺序及同路径替换均不触发重新发现。单reader持续消费通知和迟到回复，响应
  超时不重放，健康连接可显式begin-turn；连接终止要求重启MCP。首次匹配仍
  使用既有选择规则，详见[MCP连接生命周期](references/mcp-connection-lifetime.md)。
  selector 不匹配时 CLI 列出当前已连通
  target 列表，提示用户打开对应 browser/profile。Windows 当前覆盖 Chrome
  Stable 和 Chrome Beta 的 `%LOCALAPPDATA%\Google\...\User Data` roots，以及 Edge
  的 `%LOCALAPPDATA%\Microsoft\Edge\User Data`，新增三品牌目录及 Opera 根 profile
  布局见上述安装 reference；Linux 增加 Brave，macOS 未新增这三个品牌。BitBrowser
  root 仍只在 macOS 路径中自动发现。未显式选择时仍保留
  `active.json` 快速路径；`active.json` 缺失或失效时，CLI 会扫描 socket 目录并
  修复 registry，因此不需要重装扩展。
- MV3 extension core handlers：`getInfo`、`getControlState`、`browserAction`、`createTab`、`getTabs`、
  `getUserTabs`、`getUserHistory`、`claimUserTab`、`finalizeTabs`、
  `nameSession`、`attach`、`detach`、`executeCdp`、`moveMouse`、
  `armNetworkWait`、`collectNetworkWait`、`cancelNetworkWait`、
  `webmcp_list_tools`、`webmcp_invoke_tool`、
  `waitForFileChooser`、`setFileChooserFiles`、`waitForDownload`、
  `downloadURL`、`downloadMedia`、`downloadPath`、`cancelDownload`、`readClipboardText`、`writeClipboardText`、
  `readClipboard`、`writeClipboard`、`turnEnded`。
- `getInfo.metadata.turnLifecycleVersion=1` 协商持久 `control_epoch`；只允许
  `ping`、`getInfo`、`getControlState` 在控制周期外调用。结束会先持久化失效旧
  epoch，再取消操作并释放 debugger；worker 重启也隔离旧 epoch。SDK/CLI/MCP
  不静默重放输入，显式 begin-turn 用于查询新控制状态后提交新工作。
  native Port 断线同步关闭独立恢复 gate，持久失效 epoch，并等待原 attachment
  的输入和资源清理；重连必须显式开始新轮次，保留用户 Pause 设置。普通 task
  tab 移组/移窗会同步撤销旧 attachment 和 engine generation，清理后才允许
  重新领取。task/deliverable/auxiliary 的数字 ID 绑定 session incarnation；
  换代时先丢弃归属并失效所有旧 epoch，恢复页面需显式 claim。原生 Input
  先持久记录风险，worker 丢失后不能凭空 tracker 宣称释放；跨换代使用
  profile-start witness 保守处理，详见 `docs/references/browser-lifetime.md`。
- 全局用户暂停独立于 task/turn：工具栏 popup 可暂停所有 Agent，持久 gate
  拒绝包括 `getControlState` 在内的操作，只有 `ping`/`getInfo` 可读。暂停使
  所有旧 epoch 失效；恢复不执行旧任务，Agent 必须显式开始新轮次。
  raw CDP 和 CRX 共享原生输入跟踪，先释放原 attachment 的按键/指针，再
  detach；清理失败保持阻断并允许用户重试，不关闭或移动页面。popup 验证、
  异步清理身份和 worker 重启限制见 [control lifecycle](references/control-lifecycle.md)。
- 可选网站规则复用暂停事务：真实 popup 保存 exact-origin allow/block 后
  保持暂停；`site-access-policy.js` 管持久 revision，`site-access-frames.js`
  检查 webNavigation 完整文档树，backend 在 native send/结果和导航事件
  处撤权。受限模式禁未经验证的 raw/data 入口，默认 all 保持兼容；边界见
  [website access settings](references/site-access-policy.md)。
- WebMCP 使用两层 content script：MAIN world 优先使用浏览器原生
  `document.modelContext`；如果浏览器没有提供该 API，则在页面代码运行前安装
  一个最小 page-facing shim，覆盖 `registerTool`、`getTools`、`executeTool`、
  `AbortSignal` 注销和 `toolchange`。ISOLATED world 只负责 extension messaging 与
  页面消息转发。扩展在 `document_start` 动态注册两层脚本，并在处理已打开 tab
  时 lazy inject 作为补偿。`webmcp_list_tools` 为当前工具快照生成 opaque
  `registration_id`；`webmcp_invoke_tool` 必须带回同一个 id 和 tool name，页面
  `toolchange`、重新 list 或 navigation 会让旧快照失效。该能力继续复用现有
  session/tab ownership，不新增独立 browser routing layer。
- Session state persists the Chrome tab group id, tab origins, group title,
  deliverable group id, and logical active tab id in `chrome.storage.local` so
  MV3 service worker restarts can recover session tab listing semantics.
  `getInfo.metadata.auxiliaryTabsVersion=1` 表示显式 popup claim 保留原窗口。
  `auxiliary-tab-ownership.js` 在 trusted-context `chrome.storage.session`
  保存有界归属与隔离锁，普通动作、target、通知和 transfer 共用成员检查。
  结束/暂停释放控制但保留已提交归属；popup handoff 保留窗口，finalize 遗漏
  popup 则释放归属而不关闭页面；popup deliverable 在修改前拒绝。用户移走 popup
  会隔离旧归属，清理成功前禁止新 owner。完整浏览器重启需重新显式 claim，
  详见 [popup ownership](references/popup-ownership-design.md)。同一 registry 的
  v2 内部记录还支持普通无组任务页：只有新页或显式 claim 的 admission
  确认本次新单页组已消失时选择，既有 grouped 页解组不会自动转换。
  新页事务在原生创建前预留容量，以实际返回 ID 绑定归属，原 scope/revision
  贯穿结果与失败清理；用户接管后保留页面。普通页按 agent/user 来源关闭
  或释放，handoff 保留归属，无组 deliverable 保留实际页面并撤权，详见
  [ungrouped task tabs](references/ungrouped-task-tabs.md)。
  `createTab({backgroundWindow:true})` 显式新建不聚焦normal窗口，使用v3中的
  `background-window`/agent记录，与原任务组并存。只对该精确tab授予控制；
  finalize关闭它而非整窗，保留后来加入的其他页面。三SDK与CLI/MCP按
  `backgroundWindowVersion:1`检查支持，详见
  [background task windows](references/background-windows.md)。
  新 session 的默认任务组名是 `Task - OBU`，上层 runtime 应通过
  `nameSession`/`name-session` 按 `<short task> - OBU` 设置更具体的任务名；
  grouped `deliverable` tabs 移动到共享 `✅ Open Browser Use` tab group，`handoff`
  tabs 保留当前归属。`moveToDeliverables` 只复用当前 incarnation 为该
  `windowId` 记录的交付分组；记录不存在或原组已消失时新建。浏览器恢复的旧组
  和用户创建的同名组不因标题匹配获得归属，也不会自动被合并或改名。
  `turnEnded` and `finalizeTabs` clear active session state when control ends
  so download notifications only fire while a browser session is active.
- MV3 extension event forwarding：仅将有当前 session/epoch/attachment 归属的
  `chrome.debugger.onEvent` 转发为 `onCDPEvent`。下载使用 owned tab 的
  `Page.downloadWillBegin` / `Page.downloadProgress`，保留 GUID 与来源，
  不通过全局 `chrome.downloads` 事件猜 URL、时间或文件路径。
  Host 将有 `session_id` 的通知只转给明确请求过该 session 的连接，只有
  `heartbeat` 全局发送。Session ID 是路由标签，不是身份验证凭据。
  cursor content script 会回报 cursor arrival 以支持 `moveMouse`
  等待落点。file chooser 通过 CDP `Page.setInterceptFileChooserDialog` 和
  `Page.fileChooserOpened` 事件截获，再使用 `DOM.setFileInputFiles` 写入
  本地文件路径，并保留 OOPIF child session、frame 与 attachment/epoch 信息。
  已交付chooser在原生命令前单次占用，失败不恢复重试；成功ACK后允许
  change导致的正常导航，但仍核对原scope、未撤销的attachment及实时tab
  归属。清空remote object只向原attachment/child释放，详见下述文件传输。
  `downloadURL` 通过原生 downloads API 主动发起有限 HTTP(S) GET，以返回的
  numeric ID 绑定独立有界 handle；`downloadPath` 等待完成并返回该 ID 的
  浏览器记录路径，`cancelDownload` 取消该 ID。它们绑定原控制 scope，不把
  新 GET 冒充网页点击触发的下载；Page GUID 路径仍明确返回
  `OBU_DOWNLOAD_PATH_UNAVAILABLE`。详见 [文件传输](references/file-transfers.md)。
  历史私有 Browser Use command rewrite 含有 DOM CUA、media
  download、element info/screenshot、locator bulk reads、generic tab export 和
  clipboard commands，但它们不等于正式公开入口已完成这些能力。
- `exportPage` 提供 PDF 与 MHTML，原控制 scope、attachment 和文档 revision
  绑定结果。PDF 使用内部 stream 与精确 close，超时后仍追踪真实完成；CRX
  内部 detach 和主动释放都先等待该 attachment 的导出清理。默认/硬上限
  16 MiB，至多四项未完成工作且每 tab 一项；挂起 admission 仍占容量。
  MHTML 在受限网站模式拒绝，PDF 复核完整 frame 树。SDK 返回统一字节对象，
  CLI/MCP 在验证后原子创建新文件，详见 [page exports](references/page-exports.md)。
- `mediaDownloadsVersion=1` 为有限 locator 提供 `downloadMedia`，精确 HTML
  图片与音视频的 HTTP(S) `currentSrc` 发起新的原生 GET；data、原 frame
  同 origin 的 Blob 和 Canvas PNG 则读取有界字节，复用下载 handle/path/cancel。
  固定 CRX adapter 在真实 frame 的 utility world 读取原生 getter，保留
  节点/文档并复核，实际原生读取与句柄释放完成后才返回来源。嵌入内容
  上限 8 MiB，Canvas 最多 16,777,216 像素；解析前预留最多 64 MiB 的
  来源工作容量，原始 deadline 包含排队、来源和原生开始，取消不重放。
  详见 [media downloads](references/media-downloads.md)。
- `clipboardVersion=1` 保留四个剪贴板 RPC，支持有限的文本、HTML 和 PNG。
  `BrowserClipboard` 管全局单项 admission、scope、deadline 与真实结算；
  broker 通过 live offscreen context 和原生 target nonce 验证私有 Port。
  只有打包的隐藏文档调用原生 Clipboard API，页面脚本不接触内容。
  prepare 后重新检查归属再 commit，end/Pause 等待实际清理，恢复不重放写入；
  未确认原始操作状态时保持阻断。解码上限 16 MiB，含 host 转义的 JSON
  上限 48 MiB。三个 SDK 与 CLI/MCP 共用能力协商和验证；CLI/MCP 富内容
  使用显式 JSON 文件且原子不覆盖。系统剪贴板仍是共享资源，受限网站模式
  拒绝调用。验证环境与平台边界见 [clipboard](references/clipboard.md)。
- 公开 `browserAction diagnostics` 使用真实 Playwright Page 事件记录 console、
  pageerror 和 network 摘要；第一条有归属的 engine action 前开始记录，最多
  500 条/1 MiB，返回 capture/cursor/dropped。Detach 或归属改变丢弃历史，
  旧 cursor 不能读取后续 attachment；第一版不记录 headers/body 或历史流量。
  新 CRPage 在启用 Runtime 前记录 epoch-millisecond 时间边界；根页面、
  OOPIF 与 worker 的 console/exception/Log 回调在创建 JSHandle 前拒绝
  边界之前或时间戳不可用的历史事件。原生 raw CDP 通知不改写，也不清空
  用户控制台。丢弃事件的对象只通过原 session 尝试释放，并在异步权限
  检查后再次确认 attachment 身份；失败沿原 CRSession 记录，不冒充已释放。
  该边界假定系统时钟稳定：原生事件使用 wall clock，worker 的高精度边界
  使用 timeOrigin/monotonic offset。系统时钟跳变后的历史区分尚未保证。
  pinned Chromium 的 [Runtime 时钟](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/inspector/thread_debugger_common_impl.cc#682)
  与 [Performance 偏移](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/timing/performance.cc#303)
  分别是这一限制的来源；时间戳不是原生 replay 标记。
- `armNetworkWait` / `collectNetworkWait` / `cancelNetworkWait` 通过真实 Page
  request/response 事件提供先监听、后触发的有限等待。短注册阶段共享 tab
  队列，ready 后监听与读取不占动作队列；不查询 diagnostics 历史。记录在
  首次 await 前预留容量，绑定 session/turn/epoch/tab/attachment，受原始
  deadline、终态 30 秒保留及每 tab/session/global 数量上限约束。匹配只接受
  URL、method 与 response status；结果只含有界元数据。冷 raw→CRX 迁移保留
  未绑定的预留，控制结束、暂停、页面转交或 detach 清除旧等待。三个 SDK
  和 CLI/MCP 通过 `networkWaitVersion=1` 协商，旧扩展明确失败，不重放请求。
  详见 [network waits](references/network-waits-design.md)。
- `armNavigationWait` / `collectNavigationWait` / `cancelNavigationWait` 同样提供
  ready handle，但条件由 pinned Playwright 的原生 URL/glob 与 lifecycle 等待
  判断。私有 bridge 只暴露实际 listener 注册、完成和精确 Waiter 取消；没有
  JavaScript 轮询或伪造 load 事件。旧 browserAction URL/load wait 使用同一
  有界注册表，首次 await 前预留；短 setup barrier 保证后续同 scope 动作不越过
  监听注册，等待完成不占 tab 动作队列。触发动作的剩余 deadline 覆盖权限检查，
  observer 超时只取消自身；warm setup 保留既有 Page，cold setup 按创建身份清理。
  三个 SDK 和 CLI/MCP 通过 `navigationWaitVersion=1` 协商，handle 固定原 scope；
  Pause 追踪真正原生清理完成。详见 [navigation waits](references/navigation-waits.md)。
- `BrowserFileChooserWaits` 提供 `armFileChooserWait` / `collectFileChooserWait` /
  `cancelFileChooserWait`，通过 `fileChooserWaitVersion=1` 协商。准备确认覆盖
  原 attachment 的 root、已知及新加入的 OOPIF interception，后续连接可在
  确认后触发点击。旧 `waitForFileChooser` 复用同一注册表；每 tab 一个、全局
  128 个未交付或未清理记录。首个原生事件同步占位，结果单次交付，原 deadline
  不随 collect 更新；实际 enable/disable 未结算或失败时继续保留容量和控制
  清理账本。取消可在观察期限后按原 scope 重试清理，成功回复要求真实清理完成。
  详见 [file transfers](references/file-transfers.md)。
- `BrowserDownloadWaits` 在准备确认后观察首个实际 Page 下载事件，通过
  `downloadWaitVersion=1` 协商 arm/collect/cancel，旧 `waitForDownload`
  共享注册表与容量。root/已知及新child准备由动作屏障等待，首事件在异步
  校验前固定，原deadline覆盖最终权限检查。原tab/attachment下的合法导航
  保留等待；控制范围失效则撤销。取消只结束观察，不取消底层传输，不关闭
  共享Page事件，也不提供猜测的GUID路径。详见同一文件传输契约。
- JS、Python 和 Go SDK：连接 Windows named pipe 或 Unix socket 发送 Browser Use JSON-RPC。
  JS SDK 支持订阅 native socket 上的 JSON-RPC notification；Python SDK 会在
  同步 request loop 中分发并跳过 notification，避免 CDP event 插队破坏响应读取；
  Go SDK 同样在同步 request loop 中分发 notification，并可自动读取 active
  socket registry。三个 SDK 都在原子 client 之外提供高层 browser/tab API，可直接使用
  `tab.goto`、`tab.waitForLoadState`/`tab.wait_for_load_state` 和
  `tab.playwright.domSnapshot`/`tab.playwright.dom_snapshot` 这类 Browser Use
  风格封装；Python SDK 还提供 `title`、`url`、`wait_for_timeout` 和
  `locator(...).inner_text(...)` 等适合 Jupyter/Python REPL 编排的薄封装，Go SDK
  提供对应的 `Title`、`URL`、`WaitForTimeout` 和 `Locator(...).InnerText(...)`
  helper。三个 SDK 同时提供核心 Browser Use method wrappers、download/clipboard
  convenience wrappers，也保留公开协议 `request`。复合 new-tab/navigation/CDP
  helpers 共享捕获的 session/turn/epoch 与原始 deadline，不在阶段间换到新轮次。

当前实现包含 task/tab/target 归属、持久 turn epoch 和 popup 独占的 origin
允许/禁止规则。全局暂停与网站规则不构成页面网络防火墙；自己的扩展控制页
和已知 raw Target 隧道路由被拒绝。
Session ID 不承担授权认证；生产集成的用户级访问策略仍需单独实现和验收。

## 新项目需要补齐的内容

- 核心产品面和运行拓扑。
- 包分层与依赖边界。
- 数据流与存储模型。
- 可观测性方案和本地开发模式。
