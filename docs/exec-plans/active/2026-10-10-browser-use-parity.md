# Browser Use parity development

## 目标

完成 `docs/product-specs/browser-use-parity.md` 的全部能力和端到端验收，持续迭代直至
实际 Browser Use 能力与 Codex 不相上下。任何单次修复或 CI 通过都不代表此目标完成。

## 当前基线

- 分支 `codex/browser-use-parity`，已将 upstream v1.0.0 合入现有光标反馈实现。
- 不创建或重开 PR；本地开发提交保留在本项目。
- 初始审计发现私有 rewrite 未接入正式入口、Windows SDK 通信不兼容及 targetId 越过任务归属；下文记录修复与剩余缺口。

## 工作流

1. 以能力矩阵和真实复现确定缺口。
2. 修复正式入口及跨平台通信，建立可复用浏览器任务验收环境。
3. 选用完整浏览器操作引擎，接通 CLI/MCP/SDK，补语义定位、动态等待、frames/shadow 和输入。
4. 完成后台渲染、生命周期取消/恢复、文件/数据/诊断和用户控制。
5. 多平台、重复任务与 Codex 同组任务对比，逐项完成证据审计。

## 当前并行切片

- [x] 核对上游 v1.0.0、官方能力说明和当前源码。
- [x] 合入上游，保留已实现光标反馈。
- [x] Windows named-pipe transport：host/CLI/Go/Node/Python，Unix 保持 AF_UNIX；descriptor discovery 与保守 stale 清理。
- [x] CDP target normalization：证明 target 所属任务，保留 owned targetId 和 OOPIF。
- [x] 真实操作引擎选型和 POC，消除仅有命令名字的假覆盖。
- [x] Playwright CRX 固定版本构建、MV3 静态装配、公开 browserAction 与 JS/Python locators、Go wrapper。
- [x] Windows 与 Linux 全 CI；包含实际 SDK→Go host 帧传输、deadline/重连和迟到响应隔离。
- [x] 固化真实浏览器、正式入口和跨平台通信回归；安装注册与更多任务场景继续补充。
- [x] Edge Stable 发现、native host 安装 selector、ZIP no-open 和真实 Windows 独立 profile 验收。
- [x] 持久 turn 生命周期及 worker stop/start 定向真实验收；完整进程重启与移组清理继续补。
- [x] 后退/前进/刷新、逐键输入、HTML 拖放与捕获指针释放的真实 native Edge 验收。
- [x] 文件/数据归属与取消、会话事件路由、公开诊断能力及当前范围整合验收；下载路径、同步客户端等待注册与更多数据能力仍见矩阵缺口。
- [x] 工具栏全局暂停、持久阻断、原生输入释放与失败重试；真实 popup、暂停后 worker 恢复和迟到 Runtime 拒绝通过。网站策略仍未完成。
- [ ] 完成矩阵 P01–P15，并逐项审计。

## 约束与风险

- 不依赖 Codex 私有运行时或内部服务完成正式产品功能。
- 不把原始 CDP 可调用当成高层定位/等待/表单语义已实现。
- 新依赖固定兼容版本并核对许可证及运行时要求；无必要不升级 Go 基线。
- 真实 browser 测试使用独立 profile 和合成页面；不更改用户日常浏览器设置。
- Windows host smoke 必须使用独立临时目录，不能删除默认共享 socket 目录。
- 排队、超时、取消和断线不允许静默重放有副作用的输入。

## 验证与记录

各切片完成后运行必要 unit/integration 测试，阶段集成时执行完整 CI；维护同一
history 记录和能力矩阵。所有未通过或范围不足的验收保持未完成。

## 决策记录

- 2026-10-10：以正式公开入口与真实浏览器任务为验收标准，不以私有 rewrite 命令覆盖率代替能力。
- 2026-10-10：Windows 选择当前用户 ACL 的 named pipe，保持现有帧协议；不引入未经认证的 loopback TCP。
- 2026-10-10：固定 Playwright CRX 0.15.0 / Playwright 1.53.0，复用真实引擎的定位、ARIA 与 actionability；新版本 AI refs/boxes、incognito 等缺口保持显式。
- 2026-10-10：真实 MV3 验收发现 dynamic import 不可用，改为静态 runtime 装配；raw→engine attachment 必须迁移共享状态。
- 2026-10-10：真实 request deadline 包含 queue/authorize/attach；取消不能只让 RPC 提前返回而留下等待中的输入。

## 当前验证范围

- 全 Windows CI：99 extension tests、6 build/script tests、20 JS SDK tests、17 Python tests 与 Go 全包通过。
- Linux 隔离源码快照全 CI 通过；Python 仅跳过 Windows pipe 路径校验，真实 Unix Go host 集成通过。
- 原型真实 Chromium 覆盖 role/name、strictness、遮挡等待、React 受控输入、contenteditable、open shadow、同源及 OOPIF frame。
- 扩展/构建补充回归已达 117 项，覆盖晚接管 OOPIF、有限动作的渲染保持、内部帧单次 ACK 与生命周期释放；最后整合后需重跑完整 CI。
- 独立 headed worker-only 正式验收连续两轮各 17/17 通过（`run-MqJ8aA`、`run-84BPZb`）：JS/Python/CLI/MCP、ARIA、strictness、React、shadow、动态及静态 OOPIF、截图和 finalize 取消。
- 两轮活动 tab 事件均为空；viewport/crop/full-page 图像尺寸、DOM 变更后字节和图片人工检查通过。完全新启动浏览器的隐藏页首帧仍约 9.6 秒，常规多截图套件 561/648 毫秒；未改变 10 秒默认 deadline。
- 测试 NativeTransport adapter 不替代最终已安装浏览器的 native messaging 验收；Go SDK 的同组真实链路、Edge 及完整 P01–P15 矩阵继续推进。
- Go facade 加入正式套件后，两轮各 18/18 通过（`run-ivUQ96`、`run-SKN6wd`），包含 Go 同组 8 项页面断言。
- Edge 153 的两个独立 profile 使用真实 Windows HKCU native registration、Go host 和 JS SDK 验证通过；第二轮还验证 `info --browser edge` 与 `profiles --json`。测试临时 key 已清理。详见 Edge reference；没有将该结果扩大到其他浏览器或其他系统。
- 2026-10-11：持久 control epoch 对所有受保护 RPC 生效；JS/Python/Go/CLI/MCP 协商版本，旧请求不自动刷新重放。定向真实验收 `run-jpSrd0` 和 worker stop/start `run-Lzm9QL` 通过，前台事件仍为空。
- 新动作真实 native Edge 证据 `actions-native-iCWyQz`：BFCache 恢复复用 Chrome 真实 lifecycle replay，HTML 拖放、可信键盘/指针事件通过；缺失目标在按下前失败，输入投递后取消以正常释放收尾，可能产生 click。
- 最近扩展/引擎/构建定向套件 150 项通过；当前新变更尚需 Windows/Linux 全 CI 和完整浏览器套件复验，不能沿用早期全 CI 作为最终结果。
- P10 冷引擎公开 chooser/click 并发、root/OOPIF 字节和清空 `run-8yaDZF` 通过；P11 实际 native Edge `diagnostics-native-QGDV1r` 覆盖 main/OOPIF console/error/network、cursor/drop/截断及移组 owner 隔离。Host 双客户端通知隔离也已通过真实 pipe 回归。
- 2026-10-11 最终整合：Windows 与 Linux 全 CI 通过，均为 167 extension、6 build/script、50 JS SDK tests，Go 全包通过；Python Windows 28/28，Linux 27 通过、1 项 Windows 专属路径校验跳过。真实跨语言 host 集成未跳过。Linux CLI 测试 fixture 改用短临时目录，避免 AF_UNIX 路径上限，不改变产品路径。
- 同版本正式 headed 浏览器套件 `run-EGSton`、`run-rRKgiG` 连续两轮各 25/25，均 `activeEvents=[]`。每轮运行冻结复制的 host、Go checker、JS dist、Python SDK，并记录生产 extension 在测试 transport shim 前的哈希；两轮制品哈希一致。第二轮图片人工检查确认中文、frame 结果、AI 光标、点击圈及蓝框可见。
- 所有入口的显式短 action/wait deadline 包含发现、协商、排队、连接；newTab(URL) 的创建阶段在发送前也保留响应预算。raw CDP 导航同时匹配真实 loaderId 和文档 readiness，避免上一文档完成状态误判。
- Host 每连接使用有界异步 FIFO writer，慢客户端不阻塞共享 extension reader；溢出或写超时关闭对应连接及其 pending，不丢弃单条响应后继续。真实 Windows pipe/Linux Unix slow-reader 回归与 WSL `go test -race ./internal/host ./internal/transport -count=1` 通过。竞态工具链仅解包到仓库临时目录，未安装系统软件。

## 用户暂停控制：实施与验收

先实现 popup 的全局暂停/恢复，不把仅检查 URL 当作站点安全隔离。
[Chromium 的 debugger 安全说明](https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/security_faq.md)
明确指出任意 CDP 的权限无法安全限制到特定 origin；严格站点模式需要同时限制
raw CDP、导航与重定向、frame/document 生命周期等，另列未完成。

- 持久保存 paused/revision；损坏或读取失败关闭 admission，暂停失败仍保持停止状态。
- 暂停先围住新输入、持久化意图，再使所有旧 epoch（含 idle bootstrap）失效，
  取消等待并释放已知及迟到 attachment；不关闭/移动用户 tab，不声称撤销已送达输入。
- 仅可信扩展 popup 可改变状态，native RPC、网页和 content script 不能擅自恢复。
- 恢复等待完整清理与 ledger 持久化，不回放旧动作；Agent 显式 beginTurn 后提交新工作。
- 实测长等待、排队、按下未释放、chooser 和迟到 attach 的暂停，worker 重启保持暂停，
  存储/释放故障仍拒绝输入，前台 tab 不变；完成前不勾选 P14。
- 用户暂停 UI 与持久 admission gate 已进入实现；验收前不计作完成。补充发现：
  raw CDP 与引擎的 held-input 状态需共同清理，失败不可因第二次空 detach 而假报成功。
- Edge 的真实 raw mouse-down 实验确认 native debugger detach 不会释放网页的
  pointer capture/拖动状态；因此必须先在原 attachment 释放输入，失败保留状态重试，
  不以“调试器已断开”替代“输入已释放”。该实验不是整套暂停验收通过的证据。
- Chrome 156 实测真正 action popup 的 sender 没有 documentId；普通扩展 tab
  则带 tab/documentId。因此校验扩展 ID、精确 popup URL、无 sender.tab，并检查
  runtime.getContexts 的 POPUP；有 sender.documentId 时附加匹配，不杜撰必需字段。
  这识别扩展 UI 入口，不构成恶意同账户客户端或本扩展任意代码的安全沙箱。
- 扩展声明 Chromium 125 的最低 API 版本，与 flat debugger child sessions 的
  官方要求一致；popup 的 getContexts 也在该下限内可用。这不是 Chrome 125
  或所有 Chromium 品牌已经实测的声明。
- 第一轮完整 Windows CI 通过（212 extension、8 build/script、50 JS SDK、
  28 Python 与 Go 全包）；随后补充启动存储未读完时 Resume 超时不得覆盖
  原 pending/revision 的回归，最终扩展与浏览器验收仍待收口。
- 真实 native Edge 定向 `held-pause-BnRHyl` 验证 raw pointer capture/Shift
  释放、等待取消及暂停后拒绝输入；活动 tab 事件为空。正常释放产生可信
  pointerup/keyup/click，不承诺撤销此前的按下。该轮早于最终存储竞态补丁。
- 正式 Chromium 套件的 action popup 打开挂起，经独立无引擎最小实验定位
  到测试启动参数 `--window-size=1280,1000`；移除该参数后打开成功。
  不将这一测试环境问题错误归因于按住输入或 CRX 引擎，最终回归使用实际 viewport。
- 正式暂停定向 `run-14f1eY` 通过，111 ms 完成正常清理，含两个 session、
  真实 popup、worker 重启和显式恢复；Running/Paused 图片已人工查看。
  过程完整套件 `run-Yvt6Zu` 26/26 通过，但以下边界审计仍需修复后重跑。
- 实测发现 `Input.dispatchDragEvent(dragCancel)` 不释放真实 pointer capture，
  不能像 drop 一样清掉跟踪中的 left-down；必须保留到实际 mouseReleased。
- 实测发现 CRX 等待 `hideHighlight` 期间日期 fill 可在 gate 已暂停后继续
  发 Runtime 命令并改值。生产路径需立即关闭 Page 调用上下文，跳过没有公开
  用途的 recorder/highlight 等待，同时围住所有新 CRX 命令；不能只拦 Input。
  已投递到页面的脚本依然不可撤销，这不改变既有明确边界。

### 本片最终结果

- 上述两个边界已修复：native `drag-drop-audit-gHI5dd` 验证 dragCancel 后
  可信 pointerup/capture 释放；Edge `pause-late-runtime-CSVCcf` 验证暂停后
  出现的日期输入框值保持空，旧调用因 Page 关闭取消。
- 最终扩展和构建脚本共 225/225 测试通过。此前本片完整 Windows CI 已
  验证未改变的 Go、JS/Python SDK；不把旧 Linux CI 扩大为新暂停功能的
  Linux 浏览器验收。
- 正式冻结制品的 `run-qjsIiJ`、`run-uTXspB` 连续两轮各 26/26；所有生产
  extension、host、SDK 与 harness 哈希相同，仅测试 transport 的动态端口不同。
  两轮活动 tab 事件均为空，正常暂停各 110 ms。最终后台图片中的中文、
  frame 结果、AI 光标、点击圈和元素边框经人工检查。
- 最终 native Edge `held-pause-final-9iHGCP` 验证持有 pointer/Shift 的释放、
  故障注入后的 Failed 与同 attachment 重试成功；四种 popup 图片已人工
  查看，临时注册已清理，关键生产文件与最终构建哈希一致。
- 仅本地保存，不推送或提 PR。P14 网站策略、完整进程重启及其他矩阵缺口
  继续保留，长期目标没有完成。

## 页面生命周期与离屏 frame：实施与验收

真实隔离浏览器审计发现两个需要优先修正的既有缺陷：

- 页面原生 popup 会触发 CRX 的隐式自动 attachment，绕过 backend 的
  ownership、输入跟踪和暂停接入；之后显式 claim 仍可能报重复 debugger。
  生产运行时必须关闭这条旁路，由已授权的普通 attach 路径统一接管。
  OOPIF child-session 的自动发现与此不同，必须保留。
- 先截根页面离屏元素，再截当前视口之外的 OOPIF 元素，真实截图会卡在
  子 frame 的稳定性等待。验证按 frame 链从外到内滚动后再使用原生
  Playwright screenshot；保持严格定位、同一 deadline 与取消检查。

验收包括固定 build patch 行为测试、真实 popup 未接管/显式 claim 后操作、
后台根元素/同源/OOPIF/嵌套 frame 截图、取消后无迟到操作、原正式套件。
原生 window.open 的前台激活是另一个尚未解决的问题，不用事后切回掩盖。
审计模式的成功只代表完成观测，不代表其观测到的失败能力已经通过。

网络等待暂保留为下一片：现有同步 Python request/read、Go requestLock 和
CLI/MCP 串行入口不适合依赖同一客户端并发触发。采用先注册并确认 ready、
再触发动作、最后取结果的两阶段接口候选，后续单独落实有界资源与 epoch
隔离；本片不提前宣称网络匹配等待已实现。
具体候选协议保存在 [Network waits design](../../references/network-waits-design.md)。

本片结果：生产 popup 隐式 attach 旁路已关闭，截图 frame-owner 预滚已实现。
230/230 扩展/构建测试通过；正式相同冻结制品的 `run-TMvHso`、`run-hlLoF3`
连续两轮各 28/28，活动 tab 事件均为空。新增截图覆盖根元素、同源/OOPIF、
嵌套、导航与跨源变同源的新内容；尺寸按真实 DPR 校验、图片人工检查。
子 tab 测试使用真实后台 `tabs.onCreated`，验证 claim 前无 attachment、
claim 后操作、外部任务拒绝和结束释放；它不替代原生 window.open 验收。
原生 Edge `observation-production-6gXof4` 截图验证通过、临时注册已清理。

独立 popup 移组后首次 click 的 trace 表明 CRX 初始化约 3 ms 完成，卡在
`Page.startScreencast` 后 10 秒无首帧；尚未发送该 click 的 Runtime/Input。
这与原生 popup 抢前台、waitForURL 队列问题仍待后续修复。
本片 host/SDK 运行代码未改，未声称重跑 Linux 全 CI 或其他系统浏览器验收。

## 可引用页面观察与 popup 渲染：当前实施

- 补齐 JS locator scoped `ariaSnapshot()`，使同一公开动作协议在 JS、Python、Go
  都能直接读取单个元素；对元素截图静默忽略的 page-only `clip`/`fullPage`
  改为运行前明确拒绝。通过正式 iframe 读取和截图参数回归验证。
- 隔离验证固定运行时内部 `_snapshotForAI()`：实际递归 frame、ref/node 身份、
  新快照与导航后的过期、输出边界、超时和取消。不因函数存在就声明已可用。
  只有证据支持后才暴露带 capture 身份的有限公开入口，保留现有 ARIA 语义。
- 独立追查 popup 跨窗口移组后无首帧，候选恢复必须产生真实帧并通过实际
  click/截图证明；不得激活标签、移动系统鼠标或把人工事件伪装成原生证明。
- 所有修改仅本地提交；完整能力矩阵继续有效。

### 本片结果与下个完整切片

- JS 元素级快照和截图参数校验已完成，扩展/构建 231 项测试通过；JS SDK
  50 项普通测试通过，另单独启用真实 Go host 测试通过。正式 Chromium
  `run-zMs5ju` 28/28，活动 tab 事件为空，反馈和导航后截图已人工检查。
- Codex IAB 的当前合成页面对照确认快照会展开同源/跨源 iframe；它没有
  输出 AI ref，不能把我们的候选 refs 接口说成当前 Codex 同名 API。
- 固定运行时的 AI snapshot 会在 iframe 前插后生成重复 ref 并错读元素。
  保持 live Frame ID 对应稳定 slot 的隔离修补通过重排、100 次读取与 slot
  复用；公开接口仍待可信 metadata、capture 失效与输出限额完整实现。
- 原生 popup 保留原窗口时实际点击/出帧成功，再按现生产 claim 跨窗口移组
  即退化为 10 秒无帧；测试创建的 unfocused popup 保持原窗口也可工作。
  需要完整 auxiliary ownership 生命周期，原生创建抢前台仍是独立缺口。
- 候选方案分别记录在 [AI snapshot design](../../references/ai-snapshot-design.md)
  和 [popup ownership design](../../references/popup-ownership-design.md)，不将
  测试专用补丁或方案文档计为生产能力。此轮没有修改 host/Python/Go 运行代码，
  没有重复宣称 Linux 或 macOS 浏览器验收。

## 有界跨 frame 快照：完整实现切片

按 `ai-snapshot-design.md` 落实新 `snapshotAI` 动作和 singleton `ref` 定位器，
保留旧 `snapshot` 的 YAML 契约。运行时仍使用固定版 Playwright 原生 ARIA
语义：稳定 Frame slot、真正 renderer 提供的 refs、完整性检查和全局预算
一起实现，不从页面可伪造的文本提取授权列表。

- 根负责 engine/state：每个 attachment 一个 capture，frame 生命周期、普通
  快照、下一次快照、取消或 owner 改变时失效；截图通过真实 frame ancestor
  预滚。已开始的点击可以因自身导航正常完成，之后的旧 ref 调用必须拒绝。
- Runtime/build：私有 channel 的受限适配、生成注入代码限额、可信 metadata、
  固定 digest/形状校验和 build 测试；不得改变普通 ARIA 算法或静默返回部分树。
- SDK：JS/Python/Go 的有限 options/result 校验及 ref locator；CLI/MCP 复用
  同一 RPC。SDK 不自动重拍快照、猜替代元素或重放动作。
- 真实验收：root/shadow/same/OOPIF/nested、前插/重排/反复 frame 复用、伪 ref
  文本、失效与取消、五种资源上限、离屏 ref 截图，以及全部既有用例。

实现与验收完成后再更新能力矩阵、参考文档、history 和本地交付包；没有
推送或 PR。Popup 与其他矩阵缺口继续独立保留，长期目标不缩小。

### 有界快照切片结果

- 生产 `snapshotAI`、capture 状态、三种 SDK 与 CLI/MCP 入口已完成。原生
  renderer 提供可信 refs，Frame slot 在前插/重排/替换后仍指向真实文档。
  独立审查补上原生 selector 绕过校验和 iframe 备用文本 YAML 容器修复。
- Windows Chromium 156 正式 `run-rC27uZ` 31/31，活动 tab 事件为空；五种
  入口各自生成 capture、读取并可信点击。20 次重复快照、8 次 frame 替换、
  五种限额、缺失 body、节点改名/删除/替换、capture 过期与取消均通过。
- 扩展/构建 255/255、JS 55/55、Python 32/32 及 Go 全包测试通过，JS/Python
  启用真实 host 集成。本片没有将这些 Windows 结果算作 Linux/macOS 验收。
- 离屏 nested ref 截图与普通 locator 控制图逐字节一致；尺寸遵循原生整数
  裁剪后按实测 DPR 缩放。实际图片、中文和光标/点击圈/目标框已经查看。
  本地扩展 ZIP 的 28 个文件与 unpacked 匹配；18 个生产 JS/JSON 文件、各
  SDK、Go executable、host 与正式 fixture 哈希匹配，skill 包 6 文件匹配源码。
- 仅保留本地提交与安装包，不推送、不提 PR。Popup ownership、原生创建
  激活、两阶段网络等待、其他平台及完整 Codex 对照仍未完成，目标保持 active。

## 网络等待：当前实现切片

上一片 `38d35a3` 已提交且工作树干净，31 项正式浏览器测试通过，属于已验证进展。
本片按 `network-waits-design.md` 实施 request/response 的 ready ACK 协议：

- backend 在首次 await 之前验证和预留有界 waiter，冷 engine attachment 和
  短注册阶段共用动作队列，之后 listener/collect 不占队列。所有设置与等待
  消耗 arm 的原 deadline；匹配事件在异步归属复核前同步选定，不扫描历史。
- waiter 保存精确 session/turn/epoch/tab/attachment，结束、暂停、外部 detach、
  移组、关闭和重启取消旧记录。内部 raw→CRX 迁移只释放已绑定旧 Page 的
  记录，新 arm 的未绑定预留仍需通过 generation、deadline 和归属复核。
- JS/Python/Go handle 保留 arm 实际提交元数据；CLI/MCP 通用 call 提供相同
  三阶段流程。CLI 跨进程需显式保留相同 session/turn/epoch。仅 arm 收紧
  网络操作 deadline，collect/cancel 不续期；旧扩展明确不支持。
- 验证真实 cold main/OOPIF、headers/body 时序、HTTP 错误/redirect、精确匹配、
  历史事件拒绝、终态读取、资源上限及取消；五个公开入口都需实际触发且
  服务端计数为一次。保留既有 AI refs、页面操作、暂停、光标和前台不变回归。

完成后再更新协议、SDK/skill、矩阵、history 与本地交付包；无推送或 PR。

### 网络等待切片结果

- 两阶段 API、三种 SDK 与 CLI/MCP 已落生产。真实测试发现默认定时器被绑定
  到 registry 导致浏览器 `Illegal invocation`；改用包装调用并补原生 receiver
  约束回归。迟到 setup 清理受 phase/generation 限定，不能取消排队前驱或后继。
- Windows Chromium 156 `run-CbeZgJ` 36/36，活动 tab 事件为空。五入口各自冷
  arm 后触发一次可信点击并读取事件；正常请求的服务端计数均为一次。main/
  OOPIF、headers/body gate、redirect/503、历史拒绝、重复与迟到读取、16 条
  保留终态上限、end/detach/转交/close/worker restart/Pause 均通过。
- 连接在 headers 前被关闭的 fixture 观察到一次点击、一次 fetch、三次传输
  尝试。测试分别保存这些计数，response 仍必须超时；不把浏览器网络层行为
  混同为 Agent 重放。修复验收退出时最后一条通知写入已关闭 stdin 的竞态。
- 扩展/构建 282/282、JS 61/61、Python 36/36、Go 全包通过；SDK 测试包含
  真实 host。短 discovery/attach 预算、早于 ACK 的事件、30 秒 TTL 和 session/
  global 上限由确定性单元测试覆盖，没有将其描述为完整浏览器实测。
- 背景截图已查看，中文、AI 光标、点击圈和蓝色目标框保留。协议、SDK/skill、
  架构、质量与矩阵同步；该片仅本地开发，不推送或 PR。Popup、导航等待、
  网站策略、更多平台与完整同组 Codex 比较继续留在 active 目标中。
- 本地扩展 ZIP 的 29 个文件逐字节匹配 unpacked；19 个生产 JS/JSON 文件、
  JS/Python SDK、Go caller/host 和 fixture 与完整验收哈希一致，skill 包的
  6 个文件匹配源码。没有重新加载用户正在使用的扩展。

## 独立弹窗归属：当前实现切片

上一轮 `95f0f41` 的网络等待已提交，正式套件 36/36，属于已验证进展。
本轮按 `popup-ownership-design.md` 实现显式 claim 后保留 popup 原窗口，解决
跨窗口移组使渲染首帧和点击挂起的问题；原生创建时抢焦点单独研究，不将
事后恢复焦点或测试创建未聚焦窗口视为已解决该要求。

- 独立归属模块保存有界反向索引和 session storage 记录；pending claim 不授权，
  durable commit 后才可调用。跨任务冲突、延迟写、取消和重启使用精确 identity。
- backend 的 list、动作、raw target、transfer/event 和清理使用同一成员集合；
  外部移动先撤销授权，再释放旧 attachment。组查询失败不删除独立弹窗归属。
- 结束/Pause 保留已提交 membership 并释放控制；finalize 遗漏保留用户弹窗但
  释放归属，handoff 不移窗，deliverable 在任何结束操作前明确拒绝。
- 单元测试覆盖并发 claim、Pause/end/关闭/移动与存储失败；真实 headed 测试
  验证原窗口内点击、截图、其他任务拒绝、重启和前台事件，保留全套回归。

继续仅本地开发、打包和提交；不推送、不创建 PR。

本片结果：扩展/构建 313/313、store/backend 专项 31/31；Windows Chromium
156 正式 `run-hpWHwC` 38/38。首次独立 popup 可信点击 98 ms，截图、frame、
网络、竞争 claim、外部移动/关闭、handoff、Pause 与 worker 恢复通过。
五次新 popup 自身唯一 tab 激活保持原始记录，原 sentinel 不变；窗口焦点仅有
主动打开控制面板时的已验证两事件，按原始索引与真实 POPUP context 归因，
后续页面动作未新增焦点变化。原生 popup 创建抢前台仍未解决。

审查补充并修复未验证普通 claim 预留误拆其他 session 未发布 attachment 的
竞态；原生存储长期不完成时，claim 响应会超时但写入仍被跟踪，end 会保持
closing 等待，不能把这说成已取消写入或有界结束。长期 P01–P15 目标继续 active。

扩展 ZIP 的 30 个文件逐字节匹配 unpacked，20 个生产 JS/JSON、全部冻结
SDK/host/Go caller/fixture 哈希匹配正式验收，skill 包 6 个文件匹配源码。
