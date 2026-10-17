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
5. 新包 `preview-20261016-dfb9e6b` 已按用户要求交付。原型本身不触发再打包；
   2026-10-17 用户另行明确要求新包，正式入口验证后更新交付。不创建 PR，
   完成且验证后的代码只推送 fork。

## Module 与 Interface 决策

采用 `codebase-design` 的 Module/Interface 原则：managed-session
Module 负责浏览器进程、profile 独占、确切 native endpoint、观看连接和实际
清理。调用者应获得一个已验证的会话句柄，而不是自行拼装端口、PID、临时
目录和注册项。现有 SDK 继续在原 endpoint 上运行页面任务。

原型已验证进程退出、扩展启动与 native EOF 的真实顺序。2026-10-17
以此实现 `Start/Info/Done/Close` 接口和正式 CLI，并单独验证生产入口，
不以原型或 mock 的通过代替正式入口证据。

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

### 正式启动入口实施（2026-10-17）

当前实现中的实验性入口为 `managed run/status/stop`。`run` 前台持有会话，
可由 Ctrl+C 或同一活连接上的 `stop` 请求结束；CLI/MCP 的 `--managed`
通过当前用户的管理 pipe 获取确切任务 endpoint，与已有 profile/socket
选择互斥。管理通道不读取 PID 文件清场，不在会话不存在时回退全局浏览器。
`stop` 必须在实际清理完成后答复，错误或连接中断不能报告成功。尚不提供
用户暂停、恢复、实时 viewer 或人工登录，不能据此宣布完整 managed 模式。

Go `internal/managedbrowser` 持有专用 profile 的 OS 锁、随机运行目录、
唯一原生注册及 browser/native 进程句柄。Windows 采用创建时
`PROC_THREAD_ATTRIBUTE_JOB_LIST` 加入不可继承的 kill-on-close Job，避免
创建后再挂入 Job 的孤儿竞争窗口；正常先 Browser.close/EOF，失败才终止
自有 Job，并等待所有成员退出。实现依据：[创建属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、
[Job 生命周期](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

扩展新增独立 `managed-config.js` 数据文件。普通包为 `null`，保留原固定
host；仅私有暂存副本写入 version 1 与随机 managed host 名。非法配置在
连接前失败，不连接默认 host。生产后台不再依靠测试脚本替换字符串，
真实 connectNative 和现有 popup-only 用户控制鉴权保持原路径。

系统锁/进程树/注册归属、监督停止回执及连接选择测试已通过；正式 CLI
独立三步原始验收实际 exit 0，详情见下方进度及
[用户入口说明](../../references/managed-browser-session.md)。停止后独审
37 项证据检查通过，15 个去重后的原进程身份已退出；审计实际 exit 0，SHA-256
`8271414aba4e013c7c82fc837e424ad854dd03150279e0a360a0f9897eebddbd`。
用户明确要求的新包从干净提交构建并单独校验后交付；失败保留。

- [x] 原生可行性：独立脚本仅加载原扩展，暂存修改限唯一测试 host 名和
  现有公开扩展 key；核原生产哈希、Go 元数据、真实 host PID/endpoint。
- [x] 正式操作：原 SDK fill/click 提交原始字节；截图保留；先 ready 再用
  一次 Control-click 打开原 child，并从原 typed Tab 完成唯一提交。
- [x] 原型清理：turnEnded、原 Browser.close、浏览器退出、native EOF、唯一
  注册清理与无自有进程残留；失败时也保留全部原回执。
- [x] Windows 实验性正式入口：profile 独占、启动/正常停止、CLI/MCP
  确切选择、原生子页与实际退出的有限验证。
- [ ] 正式用户会话的 finalizeTabs、交付页保留与后续人工接管。
- [ ] 浏览器发现/兼容与完整异常生命周期验收，其他平台实现。
- [ ] 用户体验：实时画面、可见反馈、可信暂停/恢复/结束，以及登录/人工
  接管的明确流程；不得把任务调用者当作用户控制通道。
- [x] 原始下载绑定：此会话确切 Browser root 与 Native Port 挑战成功。
- [ ] 本模式的原文件下载及实际取消业务验收；沿用既有契约，不自动连接
  别的用户浏览器。
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

- 2026-10-17：用户要求的新包 `preview-20261017-dde4d40` 已从干净提交
  重建并发布到 fork。离线 CLI/MCP、94/67/6 文件的完整包/扩展/Skill
  独审与四资产上传回下载校验通过。发布 EXE 未冒称重跑过原页面业务；
  原验收 EXE 与发布 EXE 的身份分别保留。完整包 SHA-256 为
  `ce924e01b94008e739787bfdbb346247e503fe545f058f6d500a29f5b9e73687`。
  本次不创建 PR，后续 viewer、用户控制及安装范围仍保持开放。
- 2026-10-17：正式 `managed-launcher-xgfAuQ` 原始三步全部通过，runner
  实际 exit 0。CLI/MCP 选择同一私有 host；重复名称启动被拒且无新 run。
  SDK 一次可信 Control-click 接续原 child、唯一 192 B POST、758×369 PNG
  以及 turnEnded 旧句柄拒绝均确认。原 Browser.close `{}`、browser/native
  exit 0、Job 成员归零、原进程退出、唯一注册和 endpoint 清理通过，无
  强制终止。结果 SHA-256 为
  `8c398e632daa1db8d4e627a8b36ac80ddb6905ec85d89a1a94f1cac7a22ed790`。
  Go 全包、扩展 1829 项和 builder 25 项通过。停止后独审进行中，新包结果
  待补；未验普通 Edge/公司电脑、OS 前台焦点、实际下载或实时 viewer。

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
