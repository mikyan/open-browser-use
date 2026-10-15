# 显式隔离浏览器会话

## 目标

为用户增加一个显式选择的独立浏览器会话：Agent 可运行页面、打开原生子页，
用户可查看实时画面与现有 AI 光标、点击和元素高亮，并能暂停或结束任务，
不会占用系统鼠标。它是完整 Browser Use 目标的一条新部署路线；普通已登录
浏览器的后台弹窗焦点问题仍按原计划处理，不能被此模式的结果替代。

## 当前依据

- 生产 `backgroundWindow: true` 创建可见 normal window，不能悄悄改成
  headless；原生子页可能先于扩展接管触发窗口激活。
- 已有 memory-clipboard runner 使用统一 Headless 与扩展，但用测试 Native
  Port adapter，不能证明 `chrome.runtime.connectNative` 可用。
- `native-message-checks.mjs` 已提供真实 Native Messaging 的隔离注册和
  endpoint 身份核验，适合先检验这个部署组合。
- [Chrome 官方 Headless 说明](https://developer.chrome.com/docs/automation-and-testing/headless)
  描述统一模式创建但不显示平台窗口。该说明支持可行性假设，不代替本项目
  的原生连接、子页、可视交付及生命周期验证。
- [Chromium 团队的加载扩展变更说明](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)
  指出 Chrome 137 起普通 branded 构建移除 `--load-extension`，Chromium 和
  Chrome for Testing 保留。产品不能默认拿普通 Chrome 路径替代专用运行环境；
  本轮固定 Chromium，安装渠道与兼容发现须后续明确实现。

## 范围和约束

1. 先验证 pinned Chromium 156、独立 profile、真实 Native Messaging 和
   当前正式 JS SDK。原型是开发验收入口，不先宣称为用户可安装功能。
2. 不使用日常 profile、复制 cookies、OS 鼠标或恢复前台焦点；不禁用 sandbox。
   不改变已有 profile 发现、背景窗口或网页输入语义。
3. 一个原始表单提交和一条原生 Control-click 新页接续足以回答首个可行性
   问题；失败保留，不用类似布局和重放动作扩充通过数。
4. 现有 popup-only 暂停/网站权限鉴权不得为原型放宽。真实用户控制与可见
   画面未交付前，不把隐藏进程称作完整可用的 Browser Use 产品模式。
5. 新包 `preview-20261016-dfb9e6b` 已按用户要求交付。该原型不触发再打包；
   不创建 PR，完成且验证后的代码只推送 fork。

## Module 与 Interface 决策

采用 `codebase-design` 的 Module/Interface 原则：未来 managed-session
Module 负责浏览器进程、profile 独占、确切 native endpoint、观看连接和实际
清理。调用者应获得一个已验证的会话句柄，而不是自行拼装端口、PID、临时
目录和注册项。现有 SDK 继续在原 endpoint 上运行页面任务。

这是待原生可行性证据支持的设计方向，尚未引入生产 Interface 或抽象层。
实际原型将帮助确定进程退出、扩展启动与 native EOF 的真实顺序；不要提前
编写只在 mock 中成立的启动器。

首个用户模式优先使用前台 `managed run` 生命周期与本地 viewer，不先建设
daemon。Ctrl+C、明确 stop 和启动失败共用实际关闭流程；命名 profile 的
独占锁保持到自有浏览器及 host 都退出。运行记录只用于定位，不能仅凭
PID 文件杀进程，也不能在缺少匹配连接时退回全局 active endpoint。

viewer 是待实现的用户 Interface，不能将当前 SDK screenshot 轮询当作已有
实时观看能力。它需要与现有 rendering Module 协调有界帧订阅，不另抢 debugger
附件。现有任务 socket 不授予用户暂停/恢复权；若新增 supervisor 控制 Seam，
必须具有独立管理能力、真实 cleanup 回执和 revision 检查，并保留原 popup
鉴权。这不能抵御同一 OS 用户任意执行代码，契约与当前本地通信一致。

独立 profile 的登录与人工接管尚未设计完成。未来可采用串行的可见 setup
与隐藏 run，但两者不得同时打开同一 profile，也不复制日常浏览器凭据。

## 验证阶段

- [x] 原生可行性：独立脚本仅加载原扩展，暂存修改限唯一测试 host 名和
  现有公开扩展 key；核原生产哈希、Go 元数据、真实 host PID/endpoint。
- [x] 正式操作：原 SDK fill/click 提交原始字节；截图保留；先 ready 再用
  一次 Control-click 打开原 child，并从原 typed Tab 完成唯一提交。
- [x] 原型清理：turnEnded、原 Browser.close、浏览器退出、native EOF、唯一
  注册清理与无自有进程残留；失败时也保留全部原回执。
- [ ] 正式用户会话的 finalizeTabs、交付页保留与后续人工接管。
- [ ] 产品实现：浏览器发现/兼容、profile 独占和启动/停止/崩溃处理。
- [ ] 用户体验：实时画面、可见反馈、可信暂停/恢复/结束，以及登录/人工
  接管的明确流程；不得把任务调用者当作用户控制通道。
- [ ] 原始下载：绑定此会话确切 Browser root 与 Native Port，原路径和实际
  取消沿用现有契约；不得自动连接别的用户浏览器。
- [ ] 正式安装和完整任务验收，跨平台范围分别报告。

## 风险和判据

Headless 内部仍可有 tabs/windows 的 active/focus 事件。这些不是 OS 桌面
抢焦点的直接读数，也不能人为将其清零或套用 headed 的既有例外账本。
首轮保留启动参数、进程身份、原生窗口/标签事件及操作结果，明确未做独立
OS 前台观测。测试 adapter、临时注册与生产安装的差异必须公开说明。

停止只关闭本脚本创建且仍可核实的进程/profile，不使用按进程名清场。
注册仅删除本次随机名称且值未变化的键，不能覆盖或删除生产注册。
任何启动、连接、操作或清理失败均保持失败，不将采集完整等同能力通过。

## 进度

- 2026-10-16：重新核对当前干净 `dfb9e6b`、最新发布及剩余缺口。只读
  fullscreen 调查未证明新的生产缺陷；普通原生 popup 的前台行为已有失败
  证据。开始独立 Headless + connectNative 原型，不调整整体完成条件。
- 首轮 `managed-headless-jBbcen` 实际 runner exit 1。生产扩展暂存与唯一
  Native Messaging 注册通过，但 Chromium 在约 0.8 秒后 code 3 退出，未
  创建 DevTools endpoint，也未启动 native host。HTTP 请求为零；表单、截图、
  原生 child 与 turn/EOF 验证均没有执行，不能计为任何业务通过。
  唯一注册删除和 server 关闭均确认，私有 host 库存为空；关闭前进程树已空，
  `checked: 0` 不是完整运行中子树证明。原结果 SHA-256 为
  `be2da7dd2a8980bddc15baba21eab375ce3e868746eab62b817231f4eeda3a8f`。
- 首轮浏览器日志为空。[固定版本结果码](https://raw.githubusercontent.com/chromium/chromium/f842f52ef39fd97b449eb27cff414bf05a98ddce/content/public/common/result_codes.h)
  将 3 命名为 `RESULT_CODE_KILLED_BAD_MESSAGE`，该名字不能定位本机原因，
  也不能直接归因为 sandbox。后续先做无扩展、无业务、无注册的有限启动诊断，
  区分隔离环境和 Chromium testing 配置；仍不禁用 sandbox。
- 有限启动诊断 `run-zVz7zH` 已实际 exit 0：A 原隔离环境/default testing
  config 和 B 保留用户环境/私有 profile、temp 均 code 3；C 原隔离环境加
  项目已有 `--disable-field-trial-config` 正常启动，原 Browser.close 回执
  `{}`、主进程实际 exit 0，无强制终止，运行中 10 个自有进程退出后均不存在。
  三条件均无扩展、native 注册或业务动作；不能据此宣称 Native Messaging
  已通过，也未定位具体 field trial 根因。诊断原结果 SHA-256 为
  `4293a9c6bac687dffe4de2ce843cc5817a51a9053214a7120462c1e08fa4bcfe`。
- 原型将复用已有 `browserStartupOptions` 默认策略，保留显式
  `browser-default` 诊断选项；只补文件日志、提前退出诊断和完整扩展清单，
  原五步业务及期限不变，再执行独立原始场景。旧 runner 另存原哈希快照。
- 第二轮 `managed-headless-XUd0ts` 实际 runner exit 1：浏览器和真实 host
  已启动，runner 在扩展报告 Port connected 后立即读取尚未发布的私有
  descriptor，得到 ENOENT。没有网页业务；Browser.close 回执及浏览器
  exit 0、13 个原进程身份退出、私有注册清理均确认。未建立 EOF watcher，
  因而 native exit code 未知。该前置竞态通过显式等待私有 descriptor 修复，
  不回退全局 endpoint；旧 runner 快照保留。
- 第三轮 `managed-headless-Z8Bgff` 五步全部通过，实际 runner exit 0。
  正式 SDK 提交原表单 112 B、一次真实 Control-click 打开原 child 并提交
  唯一 192 B POST；758×369 PNG 经目视含中文输入、成功结果与 AI 指示。
  三次扩展完整清单均仅目标 UNPACKED/ENABLED。turnEnded 后旧句柄返回
  `OBU_STALE_CONTROL_EPOCH`，三个业务 tab 的 debugger 均释放；未执行
  finalizeTabs。原 Browser.close 回执为 `{}`，浏览器实际 exit 0，预持有
  原 host 进程句柄记录 EOF exit 0。关闭前 17 个进程身份均退出，pipe 不存在、
  endpoint 记录为空、唯一注册删除。内部两次 tab 激活和一次 window focus
  保留为诊断，不能替代 OS 前台观测。
- 本轮启动连接步骤实际约 1.98 秒。新增 descriptor 等待使用初始期限的
  剩余时间，但 worker/status 等待各有自身上限；本脚本尚不能证明所有启动
  步骤共享严格 20 秒总期限。生产启动器尚未实现，需另定完整期限与取消契约。
- 成功结果 SHA-256：
  `fadbdce305b18a14b2f4ab2087feace02538d28c340f86cb625994dd55d0bdd0`；
  runner SHA-256：
  `f0dd160cefa763f02b7faec7ace9d021bd132f2dd3c66c5191669408438ec529`。
  生产源码及已发布包未修改；运行命令见
  [集成验证说明](../../../scripts/browser-integration/README.md)。
- 独立审计实际 exit 0，122 项证据检查通过，复核原业务、PNG 解码、四次
  host 身份检查、原进程句柄回执及停止后清理；这些是审计项而非新增业务。
  审计 SHA-256：
  `2ece817f3a5fad32af40fd2194ebfa8621a7d737114c69303ef281e5456d1b0b`。
  既有相关 helper 测试 23 项、最终语法、文档骨架、仓库卫生和 diff 检查通过；
  本片未重跑历史完整生产回归，不扩大安装包的验收声明。
