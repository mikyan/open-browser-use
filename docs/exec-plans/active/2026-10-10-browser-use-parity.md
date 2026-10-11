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
- [x] 持久 turn 生命周期、worker stop/start、普通 tab 移组撤权及真实 host 进程恢复已验；完整 browser lifetime 专项继续。
- [x] 后退/前进/刷新、逐键输入、HTML 拖放与捕获指针释放的真实 native Edge 验收。
- [x] 文件/数据归属与取消、会话事件路由、公开诊断能力及当前范围整合验收；下载路径、同步客户端等待注册与更多数据能力仍见矩阵缺口。
- [x] 工具栏全局暂停、持久阻断、原生输入释放与失败重试；真实 popup、暂停后 worker 恢复和迟到 Runtime 拒绝通过。exact-origin 网站策略已有专项验收，更广受限入口仍未完成。
- [x] 原生 URL/loadstate observer、跨语言 ready handles、冷 wait→click 顺序与精确取消；五入口及独立生命周期关卡通过，完整进程恢复仍待补。
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

## 导航等待：当前实现切片

上一片 `a2955b3` 已完成并验证独立 popup 归属，正式套件 38/38，属于进展。
本片处理先提交 `waitForURL` 再并发点击被同 tab 队列阻塞的问题：

- 保留原生 Playwright URL/glob、当前 URL、loadstate 和导航错误语义；增加
  有界、可取消的独立监听生命周期，只把短注册阶段放入动作队列。
- 在首次 await 前预留等待和原始 deadline；后提交的同 scope 动作等待监听
  就绪，防止冷引擎、权限检查与快速跳转使触发越过注册。
- `armNavigationWait` → 触发 → `collectNavigationWait` / `cancelNavigationWait`
  对 JS/Python/Go/CLI/MCP 提供明确 ready ACK；原 `waitForURL` / `waitForLoadState`
  继续可用。已满足的 URL/loadstate 可以立即完成，不能把它描述为等待下一次导航。
- 等待超时或取消仅清理本次原生 waiter，不 detach 同页正在执行的动作；
  end/Pause、关闭、移动与换 owner 使旧 waiter 失效，结果与 scope 不跨轮次复用。
- 用真实冷页面、快速导航、SPA、redirect、状态就绪和五个入口验证，并保留
  全套后台光标、截图、文件、输入、归属与暂停回归。仅本地开发，不推送或 PR。

本片结果：导航专项 `run-o6Oc7z` 10/10；完整 Windows Chromium 156
`run-9ZuGbE` 43/43，保留五个公开入口、光标/蓝框/点击圈、截图、frames、
文件、popup、网络及 worker/Pause 回归。扩展/构建 361/361、JS SDK 66/66、
Python 39/39 与 Go 全包通过，SDK 测试包含真实 host。

审查修复两处边界：触发动作在监听就绪后的权限检查仍沿用原剩余预算，
不再迟到点击；原生 observer 在 arm 检查前已过期时，实际取消完成仍进入
Pause drain。warm setup 超时保留其他监听和输入，cold setup 只清理自身
创建的 attachment。独立回归覆盖前置阻塞、迟到原生调用与 ownership 变化。

真实加载测试先暴露两个 fixture 问题：旧 goto 不接受 commit，改由原生
commit observer 就绪后公开 CDP 导航；计数 fetch 未消费 body，native trace
证实缺少该 requestId 的 loadingFinished。读取响应体后正常结束，新增阶段、
清理前快照及两个精确请求完成断言；没有伪造 lifecycle、放宽断言或延长超时。
完整套件的原始五次新 popup 自身 tab 激活保留，sentinel 不变；窗口焦点仍
只在测试主动打开 Pause UI 的两个精确索引变化，页面动作无额外切换。
背景页面与 popup 图片已查看。该片只做本地提交/打包，不提 PR、不推送。
原生 popup 初始激活、完整 host/browser 重启、网站策略、更多平台与完整
Codex 同组任务比较仍未完成，长期目标保持 active。

本地制品最终校验通过：21 个生产 JS/JSON、31 个扩展包文件、6 个 skill
文件及 SDK/host/全部 fixture 哈希与正式验收一致，导航阶段与原始焦点
记录独立复核通过。报告保存为 `.tmp/navigation-final-verification.json`。
未重载用户日常扩展；本轮交付仍是本地开发包。

## 主动下载：当前实现切片

上一片 `f464871` 已完成导航等待并通过 43 项正式浏览器测试，属于已验证进展。
本片补齐插件主动发起 HTTP(S) GET 下载到可归属本地路径的流程：

- `downloadURL` 以原生 `chrome.downloads.download` 返回的 numeric ID 绑定
  opaque handle；`downloadPath` 只查询这个确切 ID，`cancelDownload` 只取消
  它。三个 SDK 暴露绑定原 session/turn/epoch 的 handle，CLI/MCP 使用同一 RPC。
- 原生选项固定 `saveAs:false` 和 `conflictAction:uniquify`，有限 URL 与可选
  单文件名，拒绝内嵌凭据和路径穿越，不接受危险下载。浏览器设置或企业策略
  仍可能要求 UI，不能把无保存对话框选项说成所有环境均不聚焦。
- 设置、等待、晚到的创建结果、结束与 Pause 清理均保持原始 deadline 和
  scope；路径仅表示浏览器报告的位置，真实文件字节由独立 fixture 校验。
- 修复下载 progress 在 tab 移组后仍可能向旧任务发通知的窗口；每次异步
  输出复核实时归属、attachment 和 record identity。
- 真实测试覆盖同 URL 并发、cookie、完成/中断/取消/超时、无关下载、控制权
  失效和五个正式入口，同时保留前台、光标和已有完整回归。

前置 PoC 已证明两个主动下载返回独立 ID、路径及正确文件字节；活浏览器
History SQLite 使用正常只读锁的 15 次读取全部失败。History 的写入还可能
延迟，因此不采用数据库锁绕过、复制活库或 URL/时间猜配。网页点击产生的
Page GUID 路径仍明确不支持；本片不把主动重新下载冒充原网页下载。
只做本地开发、验证与打包，不推送或提 PR，长期矩阵目标保持 active。

### 主动下载切片结果

- 独立 `BrowserDownloads`、三个 SDK 的固定 scope handle 及 CLI/MCP 通用入口
  已落生产；有限 GET 参数、精确 native ID、路径重试与显式取消共享原预算。
  保留 Page GUID 路径不支持；无 SQLite 或新依赖，无全局 URL/时间猜配。
- 审查补上移组后的 native progress 泄漏、取消后的挂起 path 唤醒、真实
  cleanup barrier，以及旧 owner 迁移期间再次显式 detach 后仍启动 GET 的
  竞态。独立重现最终为零 GET、旧 start EXPIRED、无残留记录。
- 扩展 353 与脚本 30 共 383 项通过，JS 74/74、Python 42/42、Go 全包通过；
  SDK 测试含真实 host。Windows Chromium 156 下载专项 `run-1D7lpX` 8/8，
  完整 `run-toIMbt` 47/47。五入口均校验下载文件 UTF-8 字节和 SHA-256，
  cancel 证据在 finalize 前确认；无归属下载在拒绝非法操作后继续完成。
- 初次真实慢下载失败源于 fixture 只发 1 字节，浏览器等待 MIME 嗅探才
  给出下载 ID。改为 4096 字节前缀加 1 字节尾部门控后通过；没有延长超时
  或修改原生行为。原始 start 可能先于 ID 超时，清理需等实际返回再尝试取消；
  永不返回/取消失败仍可能使 end 等待或 Pause 保持 Failed。
- 47 项保留导航、网络、frames、输入、截图、popup、worker/Pause 回归。
  背景和 popup 图片已查看，光标、点击圈、蓝框保留；原始五次 popup 自身
  tab 激活与控制 UI 的两个精确焦点事件仍有记录，sentinel 不变。
  页面点击下载路径、剪贴板/导出、原生 popup 初始激活、网站策略、完整重启、
  更多平台与完整 Codex 比较继续待补；没有缩小长期目标。
- 最终制品复核通过：22 个生产 JS/JSON、32 个扩展 ZIP 文件、6 个 skill
  文件，SDK 运行时代码与声明、host、Go 客户端及 fixture 均与正式验收冻结
  哈希一致；独立复核真实文件、取消前缀/尾部、导航阶段和原始焦点记录。
  报告保存在 `.tmp/download-final-verification.json`，文档骨架、仓库卫生、
  Action SHA 检查通过。只更新本地包，未重载用户日常扩展。

## 大请求与真实 native messaging：当前切片

上一片 `b1c2acb` 已验证主动下载；本片解决大输入/富数据/CDP 参数在真实
native messaging 上使共享连接断开的缺口。Chrome host→extension 单条消息
上限为 1 MiB，反向为 64 MiB；现有本地适配器未模拟前者，64 MiB IPC codec
不能作为浏览器传输容量的证明。文件 chooser 发送路径，大文件上传本身不是
这个方向的大消息证据。

- 保留 SDK/CLI/MCP 公开调用。新扩展每次 native port 发私有 v1 hello；host
  对协商后的超 1 MiB 请求分成至多 512 KiB 原始字节的 base64 帧。所有
  实际 host 出口帧均有 1 MiB 上限；未协商或完整消息超 64 MiB 时只拒绝
  单请求，保持连接。SDK 不能伪造私有传输 method。
- 每个实际 port 只保留一个有界 assembler，固定顺序/字节数/片数、严格
  UTF-8/JSON 与原 host request ID。start/chunk 不执行任何操作，只有完整
  commit 才进入原有 scope/epoch/ownership 检查；超时、错误或断链丢弃，
  无自动重放，旧 port 回调不能污染新连接。
- host 收到完整 IPC 帧后的重写、发送队列和分片耗时计入原显式 timeoutMs，
  扩展继续扣除组装耗时。缺省组装预算 10 秒。该契约不代表 SDK→host
  传输前已具有统一 deadline，也不把未返回的原生写入说成已取消。
  start 同时携带原始绝对 Unix deadline，接收器用绝对与单调时间共同检查，
  防止 Chrome 队列积压使相对预算重启。host 大请求排队/发送字节限额为
  128 MiB，不将其冒充 IPC 读取/JSON 重写暂存或整个进程的内存上限。
- 验收用公开 SDK 发送实际超过 1 MiB 的合成输入，页面只回长度、SHA-256
  和执行次数；要求字节正确、只执行一次、不同客户端无串流、后续连接仍活。
  新增正式真实 native registration 脚手架，独立 profile/env 与随机临时
  HKCU host key，保留原始窗口焦点/tab 激活和产物哈希，finally 验证清理。
  同时把既有适配器的 host→extension 上限改成 1 MiB，保留完整能力回归。
- 本轮只本地开发/提交/打包，不提 PR、不推送，不重载日常浏览器扩展。

本片结果：Windows Edge 真正 native port `native-u7vkkz` 现代/legacy 两组
通过；两客户端各超过 2 MiB 的 UTF-8 内容与 SHA-256 一致、各执行一次，
未协商的大请求由 host 拒绝且后续小 ping 正常，同 PID/endpoint 保留。
两组原始 tab/window 事件为空，原 sentinel 不变；临时 HKCU key 已独立确认
删除，浏览器/native host 已退出。未替换 connectNative 或调试页面的 CDP。

完整 Chromium 156 `run-xMoFkk` 48/48；新增两条 2,520,000 字节内容请求，
共 22 个数据片，物理帧最大 699,142 字节。420 项扩展/脚本、JS 74、Python
42 与 Go 全包通过；SDK 测试包含最新真实 host。背景/popup 图片已查看，
光标/蓝框/点击圈保留；原始五次新 popup 自身激活与主动打开 Pause UI 的
两个精确焦点索引保留，没有未解释切换。

独立审查发现并修复旧 native port 上的异步 handler 回复进入新 host 同号
request 的竞态；成功/失败都绑定原 port reply closure，独立 VM 复现通过。
同时修复 receiver 先报错、host 后超时导致的重复响应；原生 pipe 确定性
回归证明后续 ping 不会先读到重复旧错误。双时钟回归覆盖 Chrome 入站队列
与 JSON 解析耗时。完整能力矩阵仍有剩余项，长期目标继续 active。

最终制品复核通过：23 个生产 JS/JSON、33 个扩展包文件、6 个 skill 文件，
SDK/host/fixture 与 48 项运行及真实 Edge 原生验收冻结哈希一致；独立重算
大内容 SHA-256，复核文件/导航/焦点账本与临时注册清理。报告为
`.tmp/native-final-verification.json`。新增本地
`dist/native-host/open-browser-use.exe` 与实测 host 字节一致；本片需要更新
host 和扩展两者，未替用户更新日常安装。

### P14 网站访问控制（2026-10-11，开发与验收中）

- 默认保持 all；新增 exact HTTP(S) origin allow/block。工具栏真实 popup
  独占 setter，先同步暂停/清理/失效旧 epoch，再持久保存；恢复需显式操作。
- 网站限制覆盖 live root 与所有 frame，未知/opaque/错误树拒绝整页。
  webNavigation 事件撤权、CRX 每次 native send 与最终结果复核，共用原有
  detach/input release，保留鼠标与前台不变要求。
- 受限模式只保留已检查的 browserAction/locator/navigation 入口；任意
  CDP、跨源网络诊断、WebMCP、剪贴板和文件传输暂不开放。用实际 parser
  限定 selector 引擎，不将字符串过滤冒充脚本隔离。
- 这是 Agent 文档控制，不是页面网络防火墙：跳转仍可能先加载再撤权，
  不回滚已执行输入/网页自身请求。完整站点隔离和所有入口仍未完成。
- 分别实施策略/树/后端/弹窗确定性测试；真实浏览器验收使用允许与拒绝的
  两个测试站点、OOPIF、redirect、旧等待、真实 popup 设置和 worker 重启。
  持续维护 [网站策略契约](../../references/site-access-policy.md)。
- 所有修改只在本地，不推送、不提 PR、不改用户日常浏览器安装。

本片最终 Chromium 156 `run-4A3rF0` **49/49**，扩展/脚本 **472/472**。
真实 popup 应用 allow 规则用 115 ms 取消等待 click；旧 epoch 拒绝，显式
恢复后允许站点填表/可信 click/截图成功。禁止 goto/claim/raw CDP、混合
跨源 frame、redirect 后观察及非可信设置来源均拒绝；空白页只允许导航
bootstrap，worker 重启后同 revision/policy 保留，再验证 block 规则。
末尾通过同一真实 UI 恢复 all 并显式恢复。已有五个 auxiliary popup 激活
保留精确归因；四个窗口焦点事件只属于两次真实控制面板打开，sentinel
不变。所有浏览器进程已退出。三态 UI 和页面反馈 PNG 已检查。
持久读/写挂起以有界 UI 错误返回，真实写入未结算仍阻止恢复；迟到结果
不会自动恢复。运行中 root blank 导航和原生发送前微任务竞态有独立回归。

独立制品复核 `.tmp/site-final-verification.json` 通过：26 个生产 JS/JSON
及 10 个静态文件与实测冻结版本一致，扩展 ZIP 36 个文件逐字节匹配，
skill 6 个文件及 SDK/host/fixture 哈希一致。权限与包内测试文件/凭据/
私有机器路径扫描通过，精确验证所有原始前台事件。完整目标继续 active。

### P10 页面导出（本片已验收，完整矩阵继续）

- 实际 headed Chromium 已证明 PDF stream 与 MHTML 原生导出可行；无标签
  激活或窗口焦点事件。正式 API 仍需单独验收，探测不算产品能力完成。
- 新增 `exportPage`，只导出当前任务拥有的 HTTP(S) 页面。PDF 固定流模式，
  精确关闭内部 IO handle 后才交付；MHTML 不开放受限网站模式。返回统一
  base64 artifact，默认及硬上限 16 MiB，SDK 不隐式写文件。
- 整个 admission、原生命令、流读取和关闭共用原始 deadline；取消后仍追踪
  真正原生完成，迟到 stream 仅关闭。导航、文档/frame 变化、失去归属、
  Pause 和任务结束使旧结果失效，不能在关闭前主动 detach。
- 三 SDK、CLI、MCP 协商 `pageExportVersion=1`；CLI/MCP 显式输出路径，
  验证完整结果后原子创建且不覆盖已有文件。测试包含真实内容、跨域 frame、
  大小限制、超时清理、不同会话、受限 PDF 与完整五入口调用。
- MHTML 原生 snapshot 整体返回，结果字节上限不代表原生内存上限。PDF
  中文视觉正确但部分字体 ToUnicode 映射可能不逐码点保真；不修改导出字节。
- 仅本地开发、测试和提交；不推送、不提 PR、不改日常浏览器安装。

本片正式 Chromium 156 `run-BfrpnY` **53/53**，导出专项 `run-svvViO`
**8/8**，扩展/脚本 **512/512**；新 host 下 JS **82/82**、Python
**50/50** 无跳过，Go 全包通过。五入口实际 PDF/MHTML 均已解析内容；
JS PDF 本次 81,260 字节约 215 ms，MHTML 2,783 字节约 22 ms，限于合成
fixture 单次观察而非跨平台性能承诺。跨域 frame、CSS/SVG 和中文保留，
CLI/MCP 旧文件不覆盖；受限 PDF 成功，混合禁止 frame 的 PDF 与 MHTML 拒绝。

迟到流测试明确保留真实 Chrome stream 后延迟其 Promise 交付，证明任务
结束先拒绝结果、仅精确 IO.close 无 IO.read，并等关闭后确认结束；不是
Chrome 正常运行时延的测量。原五条 auxiliary tab 激活和四条控制 popup
焦点事件保留精确账本，导出没有新增前台事件。原 sentinel 不变。

最终独立核验 `.tmp/export-final-verification.json` 通过：27 个生产 JS/JSON、
37 个扩展 ZIP 成员、6 个 skill 成员、host、SDK 与全部 fixture 均和实测
冻结版本一致；五入口产物重新计算哈希并解析内容。包内无测试源码、凭据
形状或机器私有路径。导出 PDF、后台光标高亮及控制 popup 截图已查看。
测试浏览器与 host 已退出；本地包已更新，日常浏览器安装未改动。

### P10 剪贴板（公开入口与生命周期验收中）

- 保留四个现有 RPC 和 snake_case 富内容字段，改由打包的 offscreen 文档
  读写文本、HTML、PNG。可信 Port 结合唯一 live context 与原生 target
  nonce 验证；只给隐藏文档做 focus emulation，不激活标签或移动系统鼠标。
- 三 SDK、CLI/MCP 协商 `clipboardVersion=1`；统一 16 MiB 解码与 48 MiB
  JSON 编码上限，后者包含 host 的 HTML/Unicode 转义。严格拒绝非法 Unicode，
  PNG 限尺寸并在原生提交前完整解码；富内容文件原子创建且不覆盖已有文件。
- 原预算覆盖 admission、编码和原生执行；系统剪贴板是共享资源，操作应
  全局串行。已提交写入不能回滚或自动重放，Pause/end 必须追踪真实结算。
  网页、会话、控制周期变化应废弃旧结果；受限网站模式继续拒绝这四个入口。
- 测试不读取或覆盖日常系统剪贴板。Windows 新 window station 探针在当前
  非管理员令牌下失败，未启动浏览器、未访问剪贴板。已核实 Chromium
  headless 独立内存剪贴板的固定源码、二进制和运行参数，作为协议测试环境；这种
  实验不能替代 headed 浏览器与系统原生剪贴板的完整验收。
- 本片仍仅本地开发、测试和提交，不推送、不提 PR、不改日常浏览器安装。

固定 Headless 内存剪贴板专项 `run-ueXaBw` **8/8**：五入口三 MIME 内容，
提交前取消等待真实清理，实际 worker stop/start 后不重放旧写入。独立
Pillow 解码确认五份 PNG 都是 2×1 红/绿 RGBA 像素（浏览器重编码为 90 字节）；
CLI/MCP 元数据、文件不覆盖与无内容重复通过。原始焦点账本为空；唯一
tab activation 精确属于重启测试自己创建的 unfocused auxiliary window。
591 项扩展/脚本、JS 90、Python 59 和 Go SDK 52 项通过，Go 全包也通过。
有界面完整回归独立进行，不把 Headless 结果当作系统剪贴板或完整矩阵验收。

本轮 headed `run-obwspc` **29/53**，未通过。只读原生事件与 worker heap
定位到主窗口后台 tab 的 `startScreencast` 已完成却没有首帧，动作仍卡在
`withRenderingLease`，尚未进入 locator/input；当时没有 offscreen context
或剪贴板工作。独立 popup 同类动作、填表/快照与后段部分主窗口动作通过。
窗口未最小化，document visible/focus/rAF 正常；这些事实不足以确定系统
锁屏或遮挡原因。接着做改动前基线和无激活原生绘制探针，不盲目扩大超时。
全轮前台事件仍只属于五个合成 auxiliary tabs 与两次真实设置 popup，
截图中的光标、蓝框、点击圈已查看。尚不能将本轮完整回归标记为通过。

对照 `run-scGSgB` 使用改动前 `de1b7f7` 的 background/manifest；30 个
其余既有生产输入逐项校验相同。三个早期关键场景同样全部首帧超时。
最小原生扩展探针（不含本项目或剪贴板代码）也在 startScreencast 成功后
10 秒无帧，另发无 clip 截图 5 秒未结算，再等 2 秒仍无帧；前台、视口、
滚动均不变。证据排除了此问题只由本次 clipboard 接线引入的判断，但
尚未证明具体系统原因或找到修复；没有为通过测试而激活用户标签。

### P09 原生诊断与连续事件日志

新增可直接运行的 `scripts/browser-integration/rendering-probe.mjs`，使用最小
原生扩展和合成页面，不加载生产插件。正式 `rendering-M8L3l9` 保留失败：
启动窗口后台 tab 10 秒内零帧，后建未聚焦 normal window 约 154 ms 收到
首帧、2 帧/2 ACK、一次可信点击和 PNG，视口及滚动不变。前述 app、无窗口
启动等变体的阴性结果保留；这不是通用启动修复，生产渲染逻辑未改动。
探针原始预算覆盖 start 与真实 ACK，迟到 ACK 不发输入；超时不冒充 native
Promise 已结束。两个阶段实际命令均结算，独立检查本轮测试进程已退出。

代码审查另发现旧验收脚本在 worker 重启期间拼接日志可能漏记或重复事件。
已改为 staged-only 常驻扩展观察页，在全部被测动作与多次重启期间使用
同一 document identity 和本地 sequence，保留重复事件；窗口创建许可仅
绑定当时实际事件 index，sentinel 不再任意豁免。最终实际保存的快照再次
验证，observer 丢失、截断、迟到事件均失败，并分别保存有效历史和失败读取。
初始进程/observer 建立和最终 checkpoint 后的 teardown 不纳入连续覆盖。
旧日志不能作为跨 worker 重启期间完全无事件的独立证明，完整 headed
回归及更广 OS 仍待重新验收。

本片新增 **15/15** Node-only 单元纳入 CI。真实 `run-IajAnU` 固定 Headless
内存环境 **4/4**，包含 raw 前置、准备中 clipboard 的真实 worker 重启、
Pause 与网站策略各一次真实重启；常驻 observer 不变，只有两个辅助窗口
初始 tab 激活、零 focus。此结果不替代 headed OS 剪贴板或桌面焦点验收。
有界面 `run-8j69VK` 三个关键场景仍 **0/3**，完整原始日志保留、无额外
前台事件。未盲重跑全套，也未把失败改算通过。仅本地提交，无 PR/推送。

### P10 媒体来源与下载（HTTP(S) 图片首片已实现，广义范围继续）

正式 RPC `downloadMedia`、三 SDK locator helper 和 CLI/MCP generic call
已接通；能力协商要求 `getInfo.metadata.mediaDownloadsVersion === 1`。
这只交付 HTTP(S) 图片来源下载，不把媒体或 P10 标记完成。

- 首片提供 `locator.downloadMedia({filename?, timeoutMs?}) -> Download`，
  三 SDK 共用有限 locator 描述、独立媒体能力协商及现有 opaque download
  handle。只接收精确匹配的 `<img>`，取得浏览器已经选择的 HTTP(S)
  `currentSrc` 后发起一次显式 GET；空源、其他类型或协议明确拒绝。不隐式
  查找后代媒体、滚动、点隐藏下载链接，或把空 `currentSrc` 猜成 `src`。
  这不保证资源已解码，也不保证重新 GET 的内容等于页面已经显示的字节。
- 首片以外的后续分片分别验证 video/audio 的 progressive HTTP(S) 源、
  原 frame 中的 blob/data 字节、Canvas 原生编码，以及有界内容返回。
  MSE、MediaStream、DRM、跨域 tainted Canvas 必须区分并明确拒绝尚不支持
  的情况；不能将一个 blob URL 当作一定可下载的完整视频。GSuite 等专用
  导出另需真实格式/认证验收，不直接移植参考 rewrite 的无界 fetch。

内部 seam 位于原生定位器解析与下载来源绑定之间。
`BrowserDownloads.reserveSource` 在 URL 未知时预留，复用精确 numeric ID、迟到 start 取消和 path/cancel
归属。不能在 SDK 中先 evaluate 再调用公开 downloadURL，也不能用占位 URL
绕过校验。SDK 像现有下载 helper 一样只捕获一次 session/turn/epoch，并以
一次 RPC 返回同一 scope 的 Download；后台在首次 await 前 reserve，容量
从此刻占用，原始 deadline 覆盖 admission、排队、定位、来源读取/复核及
原生 start，不能在取得 URL 后重新计时。`BrowserDownloads` 的墙钟 deadline
和私有 engine source task 的单调钟 deadline 以当时剩余预算转换，并保留原检查。

可信来源读取不能直接使用公开 locator.evaluate：已检查的 pinned CRX
0.15.0 / Playwright 1.53 代码会将查询得到的 ElementHandle adopt 到 main
context，页面可修改该 world 的 getter。实现使用固定 runtime 的私有
adapter，在原生 parser 解析 locator、frame 和 capture ref 后，使用实际
frame 的 `_utilityContext()`，禁止重新查询替代节点。只开放固定媒体读取函数，
在该 isolated world 用原生 prototype getter 读取 currentSrc、节点连接状态
及所属文档，不执行调用者代码；拒绝自定义/main-world selector engines。
engine 私有 source task 复用 capture ref 校验和已有 action 队列，不在
队列内递归调用公开 browserAction/downloadURL；没有开放页面自定义代码。

来源绑定至少包含 attachment、根文档 revision、实际 frame/document 身份
和精确元素 handle。定位与首次原生 getter 读取应在同一次 renderer 调用
完成，提交前复核同一节点/文档及来源；可观察的导航、移除、替换或源改变
明确失败，不自动转而下载新节点。但最后一次读取与 Chrome GET 是跨进程
操作，无法组成原子事务：契约必须限定为已授权元素的一次 source snapshot，
不能声称二次比较消除了所有 TOCTOU，也不能保证请求发出时 DOM 仍未变化。
Chrome downloads 的 HTTP(S) GET 使用浏览器下载上下文中的 cookies，但它无
tab/frame 上下文参数；页面 POST、Authorization、Referer 和分区认证语义
不能据此宣称等价，需保留失败且不静默换认证路径。初片受限网站模式拒绝。

解析期和后续 start 均须跟踪真实未结算的 engine/native Promise，超时只
结束调用者等待，不能释放容量后让同一批挂起操作无限增长。Pause/end、
移组、detach、文档变化取消旧来源并等待实际清理；对冷 raw→engine 迁移仅
保留精确未绑定预留。清理不能等待正在等待自身 detach 的 admission；真实
pending 仍进入 controlSnapshot。迟到 native download ID 只按该 ID 取消，
不得发布旧 handle，失败保留重试清理证据。来源 handle 释放与下载终态分开，
不得用等待整个文件完成占据 tab action 队列。

后续 blob/content seam 保持同一来源身份，可在原 frame 内取得并固定实际
Blob/Canvas 编码结果，以有界 chunk 读取、总字节/像素上限和真实取消结算
交付。URL 来源与字节来源是不同内部实现，不能把原 frame blob 字符串移到
扩展页直接 fetch；公开字节结果沿用严格 MIME/base64/byteLength artifact
校验，下载则沿用精确 ID sink。Canvas 安全错误不能静默改成截图成功。

阶段证据 `run-yzlAP6` 为固定 Chromium Headless 的 **6/6**，包含 mandatory
raw-navigation 和 JS/Python/Go/CLI/MCP 五入口。JS 核验 root、语义 locator、
open shadow、同源、OOPIF 与嵌套 frame 的 picture/srcset 来源；五入口共十份
文件独立解码为正确的 2×1 红绿 PNG。页面 prototype/实例 getter 未触发，
严格性、非图片/空源/不支持协议与跨 session 拒绝通过，observer 连续且
activation/focus 为空。源码、SDK、host 和调用器的冻结哈希一致。

保留全部服务端记录：六次 JS 下载均为选定资源的一次 GET，非 cross 来源
携带合成 HttpOnly cookie，localhost OOPIF 来源没有 cookie。这是请求观测，
不直接证明浏览器的第三方 cookie 设置，也不承诺 frame 分区认证等价。
此前 `run-lAlw0I` 因“所有来源均带 cookie”断言失败，仍记为 **5/6**。

最终本地完整 `scripts/ci.sh` 通过：扩展/脚本 **663/663**、JS **93**、
Python **63**、Go 全包及其余 workspace 检查。Windows 使用 Git Bash，并仅
为该测试进程指定 npm shell；此前默认 cmd 执行 `.sh` 失败日志保留。
native context lease 清理修复后，固定 Headless `run-FDmPto`
为 **9/9**，同源码 headed `run-XLWzut` 为 **8/9**：八项媒体均通过，既有
mandatory raw-navigation 仍超时。两轮生产 extension、SDK、host 与 fixture
哈希一致，各十七份 PNG 像素、十七次下载 GET 和连续零前台事件已独立核验。

追加五种 capture-ref 路由、旧/移除 ref 拒绝、双 session 同 URL 的不同 ID
和绝对路径；来源改变、节点替换和 turn end 后均无下载 GET。测试明确在
真实 native capture 已结算后暂缓结果交付，随后核对原 object 的一次实际
release；导航场景另以对应 context 的真实销毁事件、不同 documentId 证明
资源失效，end 等待迟到结果清理后才成功。该注入不等于 native 命令挂起。
过程轮 `run-cAYlXr` 仍记 **6/9** 失败：fixture 自身的 picture fallback 请求、
队列中导航自等待及 end 后 SDK 观察重新 attachment 已分别修正，不改失败记录。

媒体定向通过不代表 P09 首帧已修复或完整 headed 套件通过；P09 trace 仍是
诊断而非生产方案。Page GUID 路径/取消、headed OS 剪贴板、video/audio、
blob/data/Canvas 内容和其他平台继续未完成。完整契约见
[媒体下载](../../references/media-downloads.md)。

### P09：启动 trace 与 Chromium 测试实验配置

最小探针新增启动前原始 Perfetto 追踪和只读 HWND 快照，保留实际
`traceFormat`、流关闭、部分数据、源码/二进制 hash 与阶段时钟。
`rendering-MCMbt8` 的原配置仍失败：root Surface `(0,1)` 提交后一直等待
toolbar 和最初 about:blank 两个依赖，页面 child Surface 已激活；1,813 个
Browser scheduler 状态均 visible/can_draw=true、pending_submit_frames=1。
这比“窗口不可见”更具体，不能把 HWND foreground=0 解释为锁屏。

原 trace 的 study/group hash 精确匹配 pinned Chromium testing config 的
`WebUIReloadButtonStudy/EnabledWithSurfaceSync_20260902`：它启用一组实验，
配置 100,000ms renderer commit delay 和 12,000-frame deadline。单独命令行
覆盖 `InitialWebUISurfaceSync` 会让整个 study 跳过，相关两窗口成功对照
不能被称为单一 feature 的因果证明。原失败与字段名修正前丢流的过程失败
均保留，不改为通过。

独立 `--disable-field-trial-config` 对照 `rendering-b4WKbw` 两窗口均有真实
帧、ACK、可信点击及 PNG；root pending 62.923ms 后激活，focus 记录为空。
正式验收脚本现采用 Playwright 同版本 launcher 的这一测试基线开关；不导入
其余 background/occlusion 参数，生产插件及用户浏览器配置不变。
`OBU_TEST_FIELD_TRIAL_CONFIG=browser-default` 可复现旧策略；未知值启动前
拒绝，`browser-startup.json` 保存实际参数与 binary hash。
三项正式链路定向 `run-Uq8Fkj` 3/3；完整 headed `run-NJ72u2` **61/61**，
包含 JS/Python/Go/CLI/MCP 与八项图片下载/生命周期用例。连续 observer 的
最终校验通过；五次辅助窗口首个 tab 激活、两次测试明确打开控制面板的
四条 focus 事件精确归因，网页操作没有额外前台事件。脚手架 Node 回归
**30/30**、文档与仓库卫生检查通过；本轮仅改脚手架，未重复完整产品 CI。
这修正的是验收环境，实验配置下的生产兼容性仍是限制，全部 P01–P15
目标保持未完成。证据见 [启动诊断](../../references/headed-browser-startup.md)。

### P13：普通 tab 撤权与 native host 断线（局部能力已验收）

只读生产类 VM 重现两个接线缺口：普通 task tab 被用户移出 group 后，旧
attachment 和按键/指针仍保留，CRX send hook 可继续发命令；native port 断线
仅隔离旧回复，未撤销已经接收的动作。此片在第一个 await 前封锁旧控制，
复用原 attachment 的输入释放、真实 native drain 和 detach；host 断线另行
持久失效 epoch，重连要求显式新轮次，不能改变用户的 Pause 设置或重放输入。

验收覆盖真实 ungroup、转入其他任务分组和跨窗口移动，以及同一浏览器内
终止/重启实际 host 进程。检查待执行 locator 不再点击迟到元素、可信
pointerup/keyup、原 debugger 释放、显式重新领取/连接可继续；连续 focus
observer 保持原验收规则。异常及迟到结果、清理失败由生产类 Node 回归覆盖。

完整浏览器重启仍是独立未完成项：groupId、tabId、deliverable 与 Pause
待释放 tab 列表都属于 browser lifetime。不能只清空 groupId，或把 session
storage 缺失当作旧输入已释放的证明。媒体完整字节导出和其他浏览器安装
继续保留在整体范围内，本片不宣称 P13 或 P01–P15 完成。不提 PR、不推送。

真实新增定向首次 3/3；完整 `run-ssmjWr` 12/63 暴露正常 tab 关闭与 CRX
异步 detach 的竞态，导致意外全局 Pause。保留失败并以只观察原清理错误的
staged hook 定位，不通过自动 Resume 绕过。`run-4NEQV8` 1/2 复现后，按
原 attachment token 的原生销毁证据修复，`run-T5lvEC` 定向 4/4。另补原生
输入释放和 detach 实际 pending 期间关闭 tab 的回归：成功与拒绝都重新
核对原 token 销亡证据，不再发送下一条旧目标命令；未知失败仍保持阻断。

最终完整 CI 通过：扩展/脚本 **706**（627+43+36）、JS **93**、Python
**63**、Go 全包及 workspace 检查。最终同源码 headed `run-PeM3FT`
**63/63**，独立核验代码、SDK、host、fixture 和 harness hash 一致；每个
新场景的实际 selector 等待、可信 pointerup/keyup、原目标 detach、迟到
点击为零及显式恢复均保留原始证据。三种移组/移窗取消为 123/122/248ms，
host 断线动作取消 118ms。连续 observer 的六条窗口首 tab 激活与两次
测试打开 popup 的四条 focus 事件精确归因；没有其他激活/焦点事件。

### P13：完整浏览器 lifetime 隔离（本片已完成，P13 广义范围继续）

本片不能把 host 重启当浏览器重启。生产使用 `storage.session` 的随机
incarnation 绑定 task group、active tab、tabOrigins、各窗口 deliverable
与 auxiliary 归属；marker 丢失或不匹配时先撤销所有旧数字 ID，再接受
请求，不关闭、重命名或移动可能复用这些 ID 的新页面。迁移不信任无
incarnation 的旧 schema，保留任务名称与单调 epoch counter；active 和
idle 旧 epoch 都失效。交付仅复用当前 incarnation/window 的精确 group，
不再吸纳或合并用户的同名组。

持久 Input 风险日志在每次实际 native send 前登记 attachment 的 opaque
risk ID，不存键值、坐标或页面内容。mark/clear 按实际存储顺序执行并纳入
control drain；清理写失败保留风险。durability await 后再核对原 attachment、
epoch、raw 原 deadline、restricted site proof 与释放状态，避免 Pause/end/
移组、超时或 detach 后迟发旧输入。替换 worker 的空 tracker 不等于释放。

恢复不依据 `getTargets()`/`tabs.query()` 缺席，也不依据 session marker
消失判断页面销亡。同 incarnation 的真实 `onRemoved` 可确认原 tab 已销毁。
原生 profile startup 采用 witness：第一次遇到无 witness 的旧风险只标记，
当前 incarnation 永不清；只有冻结候选来自不同 incarnation 且携带不同的
旧 witness 时，后续实际 startup 才允许清理。事务先持久 session intent，
再写 journal，最后 consumed；中途 worker 退出重试同 witness 不能误清。
这依赖已核对的 pinned Chromium profile-once 事件与卸载队列失效语义，
不伪造事件、不用 sleep 等待推断、不自动 Resume。边界见
[browser lifetime](../../references/browser-lifetime.md)。

初版生产类 focused 回归 **110/110**；当时完整 `scripts/ci.sh` 通过扩展 **660**、
脚本 **43**、浏览器脚手架 **42**（共 **745**），JS **93**、Python **63**、
Go 全包及其他 workspace 检查。初版完整 headed `run-fLR1kz` **63/63**，
独立 hash 与连续 focus 审计通过：六条首标签激活、两次主动打开面板的
四条 focus 精确归因，原 sentinel 不变，没有其他激活/焦点事件。这些
证据覆盖现有主套件，不能替代新增完整进程重启专项。

独立 `browser-restart.mjs` 用同一合成 profile 真正退出/重启浏览器，各进程
分别建立 observer，保留 PID、源码与实际退出证据；重启空档不拼成连续
零事件日志。数字 ID 碰撞由确定性测试强制覆盖，不要求自然碰撞。首轮
`browser-restart-ucmbPs` **0/4** 因受保护恢复偏好重启后消失；第二轮
`browser-restart-yH1Qzu` **0/4** 因 inactive restored 页尚未加载时提前 scripting
失败。第三轮 `browser-restart-kTnp4S` **1/4** 的未暂停重启全部通过；
暂停场景任务页已 complete，但交付页持续 lazy/unloaded，两页 DOM
只读等待 30 秒后失败，后二项受前置失败影响。第四轮
`browser-restart-kmDdeo` **2/4**，未暂停和已暂停实际重启已通过；任务页
仍核真实 DOM/no-replay，未操作的 lazy 交付页核 URL/window/group。余下
两项未通过：同浏览器 session 状态丢失后 claim 的首次 fill 报本扩展
遗留 debugger attachment 冲突，worker-input 当时另待诊断。四轮原结果保留，
不激活或强制重载页面规避问题。重启 support tests 的补充分别带来脚手架整组 **45/45**、最新 **48/48**
通过；与此前完整 CI **745** 分别记录，最终完整 CI 另见下文。

真实重启四场景及证据复核现已完成，具体最终范围见下文。原生
launcher 恢复、extension reload/update 顺序、更多媒体类型和平台仍在
目标范围内；P13 与完整 P01–P15 保持未完成。只本地开发，无 PR、无推送。


第四轮的 own orphan 已定位并修复：显式 claim 在现时授权和 input 风险
门通过后，只读探测该目标上的本扩展 native session；成功才按 opaque
`targetId` reset，不基于旧数字 ID、其他 debugger 的 attached 标志或
错误文本夺取连接。现存受控 Page/attachment/pending 不重置，探测与真实
detach 进入控制释放屏障。每次 claim 独立原 deadline 防止已 committed
auxiliary 重复调用在超时后迟到 detach；已提交 owner 保留。Pause 等待
实际释放，但不将成功释放后的 claim 取消误报为清理失败。

最终 focused **119/119**，包括九项 orphan/取消/超时回归。最后修复源码
另行通过四场景、完整 CI 与主 headed 63 项；此前 745 CI 和 `run-fLR1kz`
63/63 保留为修复前版本的通过记录。


最终重启 `browser-restart-ShnPfH` **4/4**、exit 0。未暂停/已暂停真实浏览器
进程重启、同浏览器 session storage 丢失后真实 worker 替换及显式领取、
held input 后真实 worker 替换均通过。任务页查真实 DOM 与可信输入，lazy
交付页只声明 metadata 保持；旧 active/idle epoch 被拒、旧动作不重放。
held input 留在原文档时真实 popup 保持 Failed，原 tab 真实关闭后才在
同一 popup 上 Retry pause/Resume，并显式新 turn/new tab 恢复。

该运行三个浏览器进程分别建立 observer，activation 全空，focus 0/2/6
条均有准确 popup-open 归因；重启空档不拼作连续日志。前三个恢复场景的
显式点击各一次且 isTrusted=true，迟到点击为零，服务端仅有显式请求。
第四场景不是自动释放未知 held input，而是阻断到原 target 销毁后的恢复。
前四轮失败 0/4、0/4、1/4、2/4 全保留。未知输入跨 profile-start witness
清理、真实 extension reload/update、原生 launcher 恢复仍另待实测。完整
CI-final 已 exit 0：扩展 **669**、脚本 **43**、浏览器脚手架 **48**（共
**760**），JS **93**、Python **63**、Go 全包与其他检查通过。四场景行为
与三段 focus 已独立复核，同一 popup 三种状态截图已查看。最终主 headed
`run-hlPRVD` **63/63**、exit 0；六条首 tab 激活、四条明确控制面板 focus
精确归因，无额外前台事件。四场景和 ZIP 审计确认验收源码一致，重包产物
**1,237,392 bytes**、**44 files / 49 entries**，SHA-256
`01f6e2cafdf4efa032fea6b8222a2883adfdcb3e89b647cd9150715bb32718a1`。本片完成，未知输入跨
profile-start witness、extension reload/update 与原生 launcher 等 P13
余项及完整矩阵继续，目标保持 active，无 PR、无推送。

### P10：有限媒体文件下载（本片完成，P10 仍部分完成）

下一片扩展既有 `downloadMedia`，保持 `mediaDownloadsVersion=1`、现有
五入口及 scoped `Download.path/cancel` 契约。HTTP(S) 图片与音视频采用原生
`currentSrc` 的新 GET；data、原 Frame 同 origin 的 Blob 与 Canvas PNG
采用实际有界字节。仅精确元素，不回退猜测后代、源属性或操作播放状态。
嵌入字节上限 8 MiB、Canvas 16,777,216 像素，并限制活跃字节总预算。
MSE、live/srcObject、DRM、tainted Canvas、失效 Blob 与超限明确失败。

新增读取必须保留真实 native settlement、原 attachment/context/Document、
元素与源身份。取消先触发精确 binding 的固定 abort，再等待实际读/编码/
句柄释放，不能把调用方 timeout 当 cleanup。utility world 有 universal
access，故不扩大成任意 HTTP 内容 fetch，也不允许跨 origin Blob 读取；
content-return API、HTTP 原始响应复现及其他 P10 范围仍另待完成。

字节 sink 优先核定并实测 Chrome downloads 的 data URL，避免新增 offscreen
文档与现有剪贴板宿主页争用。仍由返回的精确 native ID 建立所有权，迟到 ID
取消；公共 `downloadURL` 继续只接受 HTTP(S)。验证覆盖五入口实际文件、
确定性字节/Canvas 像素、frame/shadow/ref、原型篡改、取消/导航/超限负例，
并核对连续焦点账本。源码冻结后运行 CI、headed 回归、制品审计并同步本文、
media reference、质量矩阵与已有 history。仅本地，不提 PR、不推送。

实现与验收已完成。媒体专项 `run-L7XsRk` **16/16**；初轮完整
`run-WMOIim` **69/70** 的媒体全过，但发现旧 console 重放进入新 capture。
随后为每个新 CRPage 添加高精度 epoch-ms 边界，在原 root/OOPIF/worker
回调生成 handles 前过滤历史 console/exception/Log；原始 CDP 通知保留。
清理绑定原 session/targetInfo，在异步 admission 后再次核对身份。
该时间戳方案依赖稳定系统钟，跨时钟跳变的严格隔离仍未完成。

新生产定向 `run-iJIwsa` **2/2**，最终完整 headed `run-XnREpF` **70/70**。
新 fence 的 12 项确定性回归与全仓 CI **807**（703+52+52）通过；JS 93、
Python 63、Go 全包及其余检查通过。独立审计验证 36 实际媒体文件、两个
8 MiB 边界、12 负例、四个真实 pending read 取消及 end ACK 顺序；真实
console replay 保留原时间戳，但新 capture 只有当前 root/OOPIF/owner 消息。
连续 observer 六条创建首 tab 激活与四条明确 popup focus 均精确归因，
sentinel 不变，无额外前台事件。旧失败保留，不能用通过的定向样本否定竞态。
内容返回、任意大小资源、headed OS 剪贴板与更广 P10/P11/平台验收仍在矩阵；
完整 P01–P15 与长期目标保持 active，无 PR、无推送。

最终有限媒体制品已独立核验：ZIP **1,245,340 bytes**、**45 files / 50 entries**，
SHA-256 `f4d720f839a0198ae3c5ccfd97c70930368af0e78eb0d9a8b400f7e3fb634e66`。
每个成员与最终 unpacked 及 `run-XnREpF` 验收静态产物一致，原生 Port
adapter 改写的 background/manifest 单独按生产 hash 核对；没有测试钩子或
私有路径。Host 沿用已验证二进制，hash 与实际运行一致，不宣称重新构建。

### P05/P06/P15：组合定位与共享表单任务（本片完成，矩阵继续）

上一轮本地提交 `93b2400` 已完成有限媒体分片，作为本轮 clean 基线；
上轮属有效进展而非等待。当前 Codex Edge 扩展接口可用，返回的正式文档
包含 `filter(has/hasNot/visible)` 与 `and/or`，而本项目 filter 仅有文字条件。
本轮补齐有界组合定位的正式 engine 与三个 SDK，并核对嵌套 selector 的
网站策略、frame/ref/会话边界。已确认 selectOption 混合字符串/对象数组在
现有校验后进入 pinned Playwright 错误 wire shape；修复必须保留字符串
按 value 或 label 匹配的原语义，并验证实际选择结果。

共享本地合成多步骤领用表单将包含重复名称作用域、动态表单、多选与勾选、
中文/emoji、open shadow、同源及跨 origin frame、真实服务端提交与回执。
本项目通过公开 SDK/CLI/MCP，Codex 通过当前 Edge 扩展公开工具完成同组
任务；结果按实际 DOM 和服务端记录核验，不把不同版本/环境或调用开销
变成不公平性能结论。可信输入只对实际 pointer/key 事件要求，不能把
Playwright 原生 selectOption 的 DOM input/change 当成硬件可信事件。
浏览器由 root 独占运行，源码冻结后验收；无 PR、无推送。

组合定位与混合 select 已实现并冻结，原生 parser/queued mutation 与三 SDK
单测通过；同 frame 前缀精确剥离，ref 与嵌套跨 frame 控制递归拒绝，整个
动作树（含 drag 目标）共用 128 步限额。新增完整表单七项接入主 runner。
发现测试 stdout 按 Buffer 分块解码会破坏中文后，改为 UTF-8 decoder 并等待
close；四个真实 child 输出回归通过。表单专项 `run-j4jsMy` 8/8，完整 CI
824（710 扩展 + 53 脚本 + 61 脚手架）、JS 98、Python 67、Go 全包通过。

Codex Edge 扩展已实际完成相同三个布局的最终任务，独立 ledger 确认 3/3；
共享收据 checker 同样 3/3，但需显式 label descriptor、简单 OOPIF locator
及键盘确认等替代操作。额外严格指针一致性为 0/3，因为 cross frame 仅有
可信 Enter 派生 click、没有 pointerdown。保留原方法失败与一次部分成功
fill 返回错误，未无条件重试。早期 exact-label fixture driver 失败已保留，
修改为 role 后才启动最终同 hash 对照。来源和环境范围详见 observation
baseline；不同 profile/浏览器版本不支持速度或整体产品结论。

最终完整 headed `run-6SwxDM` **77/77**，保留原 70 项并新增七项表单；
五入口均无需替代动作，JavaScript 三布局均通过。整体 P01–P15 仍保留
content-return、原生 popup 初始激活、launcher/reload 恢复、其他平台及
研究/多 tab 等同组任务缺口。目标 active，仅本地提交，不提 PR、不推送。

最终独立审计通过：七任务均为三次准确 POST，五张收据 PNG 的 CRC/尺寸/
hash 正确，CLI/MCP 各 28 次实际 browserAction；旧 36 媒体文件、四读取
取消与诊断证据保持通过。连续 observer 六次创建首 tab 激活、四条 focus
仅归因两次测试主动打开 popup，sentinel 不变，host 两代退出。ZIP
**1,246,279 bytes / 45 files**，SHA-256
`baa12d3e3627305565110172dcd4f0e432e05ad17102aa7311bacc5c99d27dfd`，
每成员与 unpacked/实测静态制品一致，无测试钩子；新增 SDK source/dist
均追踪，内存重新编译的 14 个 JS 产物与当前文件一致。Host 明确沿用旧
已验证二进制。pre-stage 未追踪检查失败保留，统一暂存后复核无问题。

### P13：真实扩展重载和未知输入恢复（本片完成，P13 仍部分完成）

本轮从 clean `04a3ecc` 继续；上一轮属于实现和验收进展。保持旧四项生命周期
验收，增加运行中、已暂停和真实 held pointer/Shift 的有/无 startup witness
两分支共四项 `runtime.reload()`。
一次真实调用后核对旧 worker 销亡、新 worker/native Port、浏览器 PID/CDP
身份不变、安装实例不变和 session incarnation 改变；不以清空 storage 或
stop/start worker 替代。unpacked 的 onInstalled update 只证明开发扩展重载，
不能宣称商店签名更新。被动事件记录不能伪造 onStartup 或修改产品状态。

焦点观察页迁入独立测试扩展，在被测扩展重载前后保持同一 document/ledger。
整个浏览器退出仍分段并明确覆盖空档。原 native Port adapter 在重载时保留
host 进程，旧请求按真实 deadline 失败；这不是 Chrome 原生 launcher/EOF
验收。后者单独推进，不因本片通过而从矩阵移除。

held-input 跨 incarnation 后继续阻断，不能靠关闭同数字 tab 或 tracker 为空
推断释放。验收需保留真实输入/持久 journal、Failed popup、拒绝动作及精确
原页关闭后仍阻断的证据，再经一至两次实际同 profile 浏览器退出重启取得
原生 startup witness；若仍 Failed 则显式 Retry，完成 Paused 后仍需显式
Resume、新 turn 和可信动作。
同时改善用户恢复指导，按实际 journal 区分原页关闭、完整退出重开或现在可
Retry，保留全部安全门禁。源码冻结后独占浏览器验收、CI、制品核对与本地
提交；目标仍 active，不提 PR、不推送。

本片实现完成：可选 `inputRecovery` 只读枚举从当前风险生成恢复提示，原风险
算法与 Resume 门禁不变。新增独立 companion observer、被动生命周期事件、
真实reload身份/Port校验以及四项实际reload测试。最终
`browser-restart-w5chI9` **8/8**，已独立审计：未witness输入需两次真实startup，
已witness需一次；两者关原页后旧风险仍阻断，最终显式Resume/newturn才接受
可信动作。六代真实退出，五段覆盖空档明确；零tab激活，22条focus全部归因
11次主动popup，20张PNG校验并检查关键恢复提示。

保留本轮失败 `9gmJt7` 4/8、`j31iqu` 5/8、`TIhZUP` 6/8、`bbnMFd`
setup失败及`XJtixZ` 0/8。它们分别暴露developer mode前提、同popup保留、
命令行重复安装无startup、CDP拖拽缺原生drop状态与bootstrap初始化时序。
最终使用一次CDP引导后普通扩展管理器reload建立持久安装，并等待真实
install/update dispatch与连接；后代不重新安装。两扩展最终location4、
creation_flags38，无CDP-only位。详情与源码链接见runner README。

完整 CI **839**（719 扩展 + 53 脚本 + 67 脚手架）、JS98、Python67、Go
全包通过。最终主 headed `run-FPduQP` **77/77**，最终脚手架定向29/29。
原生launcher/EOF、签名更新/禁启、更多压力顺序及跨平台能力继续保留在矩阵；
这轮完成不代表整体目标完成，仍只做本地提交。

最终交付独立审计 `.tmp/reload-delivery-audit.json` 通过，无待处理问题。
ZIP **1,246,792 bytes / 45 files**，SHA-256
`c6fc5dd9cd9a5711704b97ad607ce0feb62f650bd211124bef31351b2ea047d4`。
45 个成员逐字节匹配 unpacked 与本轮生命周期验收的生产 hash；主验收的
34 个 JS/JSON hash 及其余 staged 静态文件也一致。无测试钩子或机器私有路径，
vendor MODIFICATIONS 保留。主验收六次允许的创建激活、四条主动 popup
focus 精确归因，两代 host 真实退出，两个测试 profile 均无进程残留。
Host 沿用 SHA-256 `d946f5b64301084094db3bfd85e36af1dbfb513123938fc53ba76eef004be3a5`
的已验证二进制；不宣称本轮新构建。用户主浏览器的已安装扩展未被替换。

### P02/P13：真实 native launcher 生命周期（Chrome 本片完成，Edge 焦点待查）

从 clean `75cb7d3` 继续；上一轮有代码、真实验收和提交，属于有效进展。
本轮补足浏览器原生 `connectNative` 启动、host 崩溃和扩展 reload 的 EOF
链路。新 runner 使用独立 profile、唯一临时 host 注册及相同生产 host，
不替换 connectNative；只允许测试 host 名、公钥和被动事件记录的 staging
差异。常驻 companion 观察页跨 reload 保留原始焦点记录。

必须核对实际 host PID/可执行文件/父进程身份、旧 IPC 失联和新 endpoint，
挂起动作及时失败且无迟到副作用，原页面与用户前台保留。host 单独崩溃
保留同 incarnation 的任务成员，仅要求显式新 turn；真实扩展 reload 更换
incarnation，必须显式新 turn 和 claim。暂停状态在 reload 后保持。
原生终止前再次验证进程身份，收尾删除的只能是本轮创建且值未变化的注册。
保留失败证据，不把开发版 unpacked 重载等同商店签名更新或其他 OS。

静态审计发现 packed 扩展的重连 alarm 可能被 30 秒 heartbeat 反复覆盖，
使实际重连饥饿；Chrome 对 packed alarms 的最小 30 秒间隔与同名覆盖语义
见官方 alarms 文档。修复需保证重连只调度一次、后续消息不延后期限，
保留持久唤醒与短延迟重连，同时不重放任何浏览器动作。补确定性时序回归
及真实 native launcher 验收后再记录完成范围；目标保持 active，无 PR/推送。

已实现单一 pending retry、best-effort 5 秒 timer 和 30 秒持久 alarm，串行
create/clear 防止旧清理覆盖新后备；七项新增竞态回归通过。完整 CI 的
849 项 Node、JS98、Python67、Go 全包通过，最终脚手架增加三项后 73/73。
主 `run-aZyBs1` 77/77；最终 Chrome 原生 `native-lifecycle-dnAdTC` 3/3，
真实 host 崩溃、运行/暂停 reload、两次 EOF exit0 及原 deadline+250ms
无重放均验收。源码、产物和焦点证据独立核验；包 hash 见本轮 history。

Edge setup 经三次失败后用实际可见开关修正；首次 host 恢复通过的后续
reload 准备阶段出现焦点异常，且发现同步外来扩展。最终统一禁同步策略与
全状态管理 API 清单核验后，`native-lifecycle-R7MPzo` 仍因本窗口一次未知
focus 失败，后两场景未运行；进程及临时注册清理通过。严格焦点条件保持，
后续从此独立失败查明操作/原生进程/OS 窗口时间关系，不靠重复运行取通过。
签名更新、packed alarm 实际唤醒、其他 OS 和剩余 P01–P15 继续保留。

Edge 失败日志在 focus 同一毫秒记载开发者模式提示气泡出现（旧 host 退出
457ms 后、新 host 启动前约 4.6 秒），目前仅时间相关。下一片做相同设置下
无 SDK 动作、无 host 终止、无 reload 的 idle 对照，保留完整 observer 与
清单，不引入新 flag 或豁免，先判断是否不经恢复操作也出现该事件。

### P03/P13：Edge 原生焦点的空闲对照（对照完成，Edge 验收仍待补）

从 clean `ba3d2ce` 继续；上一轮已提交重连修复、真实 Chrome 验收及 Edge
失败证据，属于有效进展。本轮用显式 idle-diagnostic 模式复用同一套安装、
隔离清单、observer 和收尾。安装后固定观察十秒，不执行 SDK 动作、host
终止或 reload；出现焦点变化也采完整区间。诊断完成与三项生命周期通过
使用不同结果字段，不允许空用例列表冒充验收成功。

先比较独立空闲对照与原故障过程的气泡/焦点时间。若气泡也在无动作时出现，
只证明现象可独立于恢复操作，不自动放行有动作场景。扩展 ready 与浏览器
安装提示结束不等同；不得仅靠更长 sleep 或关闭提示的 flag 获得通过。
同时梳理 P10 content-return 的具体公开契约，下一片继续补真实产品能力。

最终 Edge `native-lifecycle-XlNQ9o` 与 Chrome `native-lifecycle-K2qRSM`
分别采集 10,002ms / 10,015ms，各11样本、原 host 不变、零案例/服务器
witness、全清单隔离与收尾通过。Edge唯一focus比气泡日志早1ms，Chrome
无事件；两者均 diagnostic.complete:true、passed:false，严格区分诊断
采集与验收。无操作也可复现，故恢复动作不是必要条件；未直接检查气泡 UI，
不能宣称因果。默认 Chrome 验收 `native-lifecycle-0B1hfL` 3/3，最终
Node-only脚手架75/75；生产与交付包未变。继续保留原Edge恢复失败，后续
若追查使用只读私有 HWND/UIA 证据，不靠固定等待或新flag关闭提示。

本轮梳理发现“Content-return”缺少具体基准；已有正文、PDF/MHTML 和
剪贴板内容返回不能重复列为缺失，旧命令名不证明当前 Codex 媒体字节 API。
因此下一片先实现已有真实使用缺口的跨连接 chooser 准备确认，完整目标
不缩减，其他文件/平台和当前 Codex 同组基准继续保留。

### P10：文件选择器的准备确认与跨连接上传（本片已验收，P10 仍部分完成）

目标是让三 SDK、CLI 和 MCP 顺序完成“确认监听就绪 → 点击 → 取得 chooser
→ 上传”，解决 `file-transfers.md` 已记录的跨连接排序缺口。当前 JS 同连接
并发模式保留；本片先完成 chooser，下载的准备确认与 GUID 路径/取消继续
保留为后续工作。不得通过 sleep、后台线程启动顺序或重放点击证明就绪。

实现三个 RPC，公共 scope 均为 `session_id`、`turn_id`、`control_epoch`、
`tabId`；拒绝未知选项，协商 `getInfo.metadata.fileChooserWaitVersion === 1`：

| RPC | 额外参数 | 响应 |
| --- | --- | --- |
| `armFileChooserWait` | 可选 `timeoutMs`，默认 10000，整数 1–120000 | `{waiterId, remainingMs}` |
| `collectFileChooserWait` | `waiterId` | `{fileChooserId, isMultiple}` |
| `cancelFileChooserWait` | `waiterId` | `{}` |

准备确认必须晚于原 attachment 的 root 和已知 OOPIF interception 成功、
监听安装及最终 scope 校验，且释放动作队列后允许另一连接触发点击。原始
deadline 从首次 admission 计算，覆盖冷 attachment、准备、事件校验和
collect；collect 不接收新的等待预算。SDK/bootstrap 与 CLI/MCP 队列耗时
只能扣减预算，不能重置。`setFileChooserFiles` 是既有的后续动作，继续
校验 chooser 的原文档和所有权，等待成功不授予无限期文件写入权限。

实现时复用 `prepareTransferAttachment`、`transferScope`、
`fileChooserSetupsByTabId` 的动作准备屏障、`fileChooserWaitersByTabId` 的
原生监听、`fileChoosersById` 的实际 node 身份，以及
`enableFileChooserTarget` / `handleFileChooserOpened` 的主 frame/OOPIF
路由。增加一个独立、有限的 chooser-wait registry 管理 opaque waiter、
状态、deadline 和实际清理；参考 network/navigation wait 的 reserve、
lookup、invalidate、controlSnapshot 结构，不改造成任意事件框架。
旧 `waitForFileChooser` 通过同一实现执行 arm+collect，避免两套原生监听。

边界在实现前固定：

- 每 tab 最多一个尚未收集或清理完成的 waiter，全局最多 128；旧等待和新
  RPC 共享容量。收到首个事件时先固定候选，再异步验证；不能由后来的
  更快校验事件替换。成功 collect 只交付一次，并发 collect 明确冲突。
- record 绑定完整 scope、原 attachment、文档版本和确切 child session。
  collect 的未知/外来/过期 handle 统一拒绝；cancel 对未知或外来 handle
  无效果且不透露状态，不能取消其他 owner。取消已匹配但未交付的结果时
  同时撤销该 waiter 创建的 chooser，已交付 chooser 沿用既有生命周期。
  正常 scope admission 仍适用：无权 tab 或无效 epoch 可统一拒绝，不据此
  区分 waiter 是否存在。
- 新 OOPIF 加入活动 wait 的 interception；新 child 准备未完成时，相关
  动作也必须等待实际确认。child detach、文档导航、移组/转交、end、Pause
  和 worker/host 生命周期使旧记录失效，不能凭同 tab 数字 ID 恢复。
- timeout/cancel 及时结束公开等待；实际 native enable/disable 尚未结算
  时保留操作账本和容量。清理仅面向原 attachment/child，旧 disable 不能
  关闭后继 wait；失败保留可重试的确切清理，不能吞掉失败报告已释放。
  超时不触发点击、不重复文件写入，也不关闭用户原生对话框来伪造取消。
- cancel 可在原等待期限后按原 scope 重试确切清理，使用独立最多 10 秒的
  清理响应预算、不发送 `timeoutMs`、不更新等待 deadline。已知记录仅在
  真实清理完成后回复 `{}`；失败明确拒绝并保留容量。result 在队列、连接后
  再检查原本地 deadline，额外一秒回复余量不能授权过期 collect。

三 SDK 提供 `tab.expectFileChooser(...)` / `expect_file_chooser(...)` /
`ExpectFileChooser(...)`，返回带 `result()`/`cancel()` 对应语言方法的
wait handle；result 返回现有 chooser ID 与 multiple 标志，文件设置仍走
`setFileChooserFiles`。CLI/MCP 使用正式通用 `call` 顺序执行相同三个 RPC
和既有文件设置入口，无测试 RPC、私有 native pipe 或隐式线程约定。

验收先写确定性竞态测试，再冻结生产代码进行真实浏览器五入口验收。
每个入口用两个独立连接共享同一合法 scope：A 的 arm 返回后，B 立即点击，
A collect 并设置合成文件；冷 root/OOPIF 都应成功，至少覆盖准备后新建的
OOPIF。页面读取文件并 POST 到合成本地服务器，核对 UTF-8/二进制字节、
长度和 SHA-256；另验 multiple 与空列表清除，不以 input.value 或 RPC
成功代替上传内容。保留同连接旧 JS 用例。负例覆盖原 deadline、重复 arm、
并发 collect、外来 scope、导航/移组/Pause、取消后迟到事件及新的成功等待；
保留原文档至原 deadline 后观察无迟到写入。连续独立 observer 核对 sentinel、
tab 激活与窗口焦点，确认没有原生文件选择器抢前台；源码/hash、实际入口、
原始服务器记录和失败运行一起保存。通过后再更新 reference、history 和矩阵，
仅称完成本片，不把尚未做过的 Codex 上传对照或完整 P10 宣称为完成。


本片最终结果：专项 `run-bE4e26` **9/9**，完整 `run-3OY97j` **83/83**；
完整CI **882** 项Node（751+53+78）、JS105、Python73及Go全包通过，无跳过。
五入口30条上传/清空原始POST及生命周期另6条独立核验，真实OOPIF的原生
frame/session与独立renderer进程均保留。取消后原文档观察超过旧deadline
267ms，无迟到写入；全套连续observer六条创建激活、四条主动popup focus
全部精确归因，sentinel不变。scope证据非完整RPC transcript、焦点不含启动
与退出、Port adapter不代替原生注册，这些边界保留在reference和runner文档。

首轮1/9的浏览器timer receiver，以及4/9和诊断1/2中新OOPIF先commit后swap
缺陷均已修复并添加回归；失败证据不改写。新frame的首次nav与父端swap
分别受精确身份约束，重复/错误来源/匹配后变化仍失效。完整P10未完成，
未执行Codex上传对照，仅完成本片；继续保留Edge原生focus失败和其余矩阵缺口。

最终包独立审计通过：46文件、1,251,944bytes，SHA-256
`8990be12bf0702945e919b6f852246bea01feb56dfba7558939b91a3f85f5f9d`。
成员与unpacked及两轮实际验收一致，无测试插桩/私有路径。保持本地开发
与提交，不推送、不提PR，不替换用户主浏览器现有安装。

### P10：页面触发下载的准备确认

上一片 `09cd914` 已完成 chooser 准备确认；本片补页面真实下载的等待顺序。
现代码在多次 attachment/权限 await 后才注册 download waiter，跨连接点击
没有就绪保证。确定性复现还证明首个事件的异步校验较慢时会返回后一个GUID，
以及最终权限校验可超过原期限后仍交付结果。旧 sequence 检查已能排除注册前
事件，不把这一项误称为已证实的后继等待污染。

协议协商 `getInfo.metadata.downloadWaitVersion === 1`，固定原 session/turn/
positive control_epoch/tabId；三个方法拒绝未知字段：

| RPC | 额外参数 | 结果 |
| --- | --- | --- |
| `armDownloadWait` | 可选 `timeoutMs`，整数1–120000，默认10000 | `{waiterId, remainingMs}` |
| `collectDownloadWait` | `waiterId` | `{downloadId}` |
| `cancelDownloadWait` | `waiterId` | `{}` |

SDK提供 tab/playwright 的 expectDownload/expect_download/ExpectDownload，
返回等待handle；result返回现有Download对象，保持原scope。cancel取消观察，
不取消已经开始的浏览器传输；不能与Download.cancel混同。CLI/MCP沿用call。
Page GUID路径与实际取消仍需要可靠机制，不能用新GET、URL/时间/文件名或
SQLite无锁副本冒充。该缺口保留，完成等待不等于完成P10。

同步reserve后才进入bootstrap，确认原CRX attachment、root/已知child的
Page事件启用、监听与scope后返回ACK，新child加入真实准备屏障。首个合法
原生事件在任何异步校验前固定候选；成功单次collect，并发冲突。每tab一个
尚未交付/清理等待，全局128，旧waitForDownload共享同一实现。原deadline
覆盖队列、连接、准备、触发和最终校验，collect不接收新timeout；额外回复
余量不授权过期请求。cancel可在期限后按原scope用独立10秒预算完成观察清理。
未知/外来handle不产生效果，正常scope admission仍适用。

下载等待采用tab/attachment语义：合法导航或重定向不重置deadline，也不
因为DOM文档更换而抹掉已观察到的真实下载。事件到达时只接纳确切root或
当前注册child；已销毁child不能再提供新事件。已证明的候选可在普通child
销毁后保留，但tab detach、所有权转交、end、Pause及worker/host替换仍撤销。
清理不调用会影响共享引擎的Page.disable；实际未结算setup继续记录，不能
用公开超时冒充真正释放。旧回调不能命中后来创建的waiter。

先补首事件倒序和最终deadline确定性回归，再冻结代码做真实五入口验收。
每入口两独立连接，覆盖冷root、既有与arm后新建OOPIF；ACK后立即点击，再
collect，保留原生GUID/source和scope通知。隔离下载目录差集与内容nonce
验证落盘UTF-8/二进制字节，明确属于测试文件证据，不声称公共GUID→path。
另验并发、取消后实际传输仍可完成、旧事件/期限、合法导航、所有权/Pause
及原文档迟到动作。保留旧公开下载场景和全部历史失败，连续observer严格
检查前台与sentinel，不新增焦点豁免。通过后同步reference/history/矩阵。

修复后专项 `run-mRwIs8` **9/9** 已独立审计通过：24份实际文件98,376字节，
五入口原生GUID/跨进程OOPIF/scoped通知、取消观察后原传输继续均有原始证据。
首轮 `run-c0ip6L` **7/9** 的监控连接未发送scoped RPC，现先await只读getTabs，
新增真实SDK wire回归，原通知要求未放宽。首轮完整 `run-Ni9Djz` **87/89**
的两个popup场景因根窗口inactive失败；账本只有六条预期创建activation、
零focus，最后窗口minimized，初始state未记录，原因仍未知。下一步增加
只读初始窗口state/focused记录并复跑，不调用focus掩盖，也不增加豁免。

最终CI另保留一次Go测试601秒timeout：旧export非法参数测试在go-winio
Listener.Close等待doneCh，而listenerRoutine回到外层select，Accept已退出。
独立完整CLI包8.259秒和export结果负例100次2.897秒通过不能抵消该失败；
现采用官方go-winio v0.6.3关闭广播修复、x/sys v0.48.0，并将构建版本固定
到官方SHA校验的Go1.26.9，保留旧工具链和二进制。新回归分单次/八次Close
与无客户端/立即断连四种真实交错，必须真正结束Accept、释放端点且保留
既有连接；原卡死负例20次通过。有界压力不称确定性旧版本复现。
升级后完整CI **906** 项Node（771+53+82）、JS115、Python82及Go全包通过，
无跳过；新主机和五个Go调用程序另存。最终新版本专项 `run-lMFHcB` **9/9**、
完整 `run-k3mDiy` **89/89** 均通过。两次均记录初始窗口normal/focused=true，
没有主动focus/还原窗口，也没有增加豁免；旧minimized运行原因未被新成功
解释或抵消。两轮独立16组审计通过，全套129,574ms账本六激活/四focus均
精确归因，sentinel不变；24份原始响应与实际文件98,376字节再次核验。
最终ZIP47文件、1,255,479bytes，SHA-256
`cef6706a1cf69717835f168c4e96bd1f20146f0dfc610e9b28b58434a2c5a0c8`，
逐成员与unpacked和两次实测一致，无测试插桩或私有路径。Go运行时、依赖
和六个产物hash同预跑基线。完整P10与长期目标仍active，仅本地提交。

### P15：跨标签页研究与带来源的报告

本片验证完整资料核对流程：从可见任务书打开多个供应商资料页，读取并比较
当前方案与跨源框架中的限制，生成带来源的报告，提交一次，核对服务端收据，
保留交付页并关闭研究页。每次资料由服务器随机生成，正确答案只在服务端评分；
调用器不能读取 oracle、直接 HTTP 请求资料或旁路提交。三种布局避免依赖顺序，
五个入口各自完成建页、读取、交互和 finalize；CLI/MCP 不借 JS SDK 代做生命周期。
这是合成完整任务验收，不等同于开放互联网研究或模型规划能力的证明。

先固定共享任务与可见字段契约，再并行实现 fixture/oracle、JS/CLI/MCP 与
Python/Go 调用器。主线程统一集成并启动真实浏览器；保存原始资料、页面访问、
提交内容、各入口步骤和源码身份。连续独立 observer 必须确认用户 sentinel、
标签激活与窗口焦点不变，不增加焦点豁免。只有最终报告与来源、单次提交、
实际保留/关闭页均通过，才记录该任务成功。必要时用当前 Codex 同任务对照，
单列可调用能力、失败及替代路径，不从测试耗时推断模型速度或整体能力持平。

本片沿用现有生产 API；只有真实任务暴露缺陷才修改生产。原生 popup 焦点、
Edge 恢复、P10 下载路径/取消、跨平台等既有缺口继续保留。不推送、不提 PR。

本片专项 `run-AOpN3n` **16/16**、全套 `run-WWWaGP` **104/104**，两轮
独立审计通过。每轮15项研究任务、90份当前来源、15次原始POST以及实际
75创建/60关闭/15保留均一致；专项连续账本零激活/零focus，全套六激活与
四focus均来自原有明确fixture/控制面板动作，未增加豁免。CI Node **920**
（771+53+96）、JS115、Python82和Go全包通过；最后Go调用器修改另有编译
及定向检查，新Node测试14/14。生产与既有ZIP未变，只扩展测试和证据。

当前Codex Edge使用相同fixture三布局最终 **3/3**，跨源及动态条款读取、
单次提交、带来源报告和关闭四个研究页成功，无浏览器方法失败或替代路径。
最终清单保留三个报告；该端无独立focus/lifecycle observer，不推断OS焦点。
任务后的证据导出一次语法错误保留；独立server的stdin已关闭，stop无法
发送，核对身份后强制退出且记录exit1，不宣称正常停机。共享任务reference
记录完整范围；原生popup、Edge、文件/诊断、更广重复与平台缺口继续开放。

### P09/P12：后台闲置后的并行渲染与独立收尾

上一片已形成提交与独立证据，属于实际进展；当前工作树从 `6af3f95` 干净
状态继续。新增专门的长期实测入口，保持默认104项不被几分钟等待拖长。
至少三个独立任务各拥有多个后台页，指定页连续闲置超过五分钟，其间其他
任务反复进行有可核对结果的输入和截图；随后验证闲置页首次操作/截图，
以及一个任务结束时其他任务并发继续。每页含独立nonce和可见状态，核对
实际截图像素、页面动作和范围，不用空白PNG或自报完成替代行为证据。

原连续focus observer保持，不能新增激活豁免或主动聚焦恢复。原生渲染
命令/事件和最终租用回收证据另行采集，测试钩子须声明且不能改动作结果。
超五分钟只表示真实闲置时长，不凭时间推断Chromium已进入某种节流策略。
如任务失败，先保留原始记录并定位生产缺陷，再修复及复验；不以较短等待
或串行化调用掩盖并行问题。P11调钟后的日志边界和P10原下载标识关联并行
做只读机制核查，未经原生证据不得将这些缺口标为完成。

并行机制核查确认：P11的固定performance epoch与原生墙钟会在调钟后偏离，
且即使改用Date.now，历史时间区间折返仍让旧/新primitive日志同形。公开
Runtime/Log事件没有统一replay标志；迟child enable ACK也不是原Page起点，
不能以丢弃此前新日志换取表面隔离。未改系统时间或生产，缺口保持开放。
P10唯一查到的精确公开路线是browser-root CDP的downloadProgress.filePath
和cancelDownload(guid)，但启用事件的setDownloadBehavior会修改context
全局设置，只能作为另行设计的独占受管profile路线，不能静默用于当前用户
profile。普通扩展权限、Page.setDownloadBehavior和内部下载页数字ID均不能
补足该证明；本片未增加新连接权限或下载行为覆盖。

专项首轮 `run-8DMNGR` 1/2，4.67秒即因元素截图高度校验失败，未完成长
闲置。四张实际360×92 PNG保留且全部nonce/sequence色块正确；旧检查直接
使用60×1.5=90，忽略bundled引擎的CSS enclosingIntRect。修正后记录原生
capture.clip、截图后box和根页scroll，严格复算整数裁剪与DPR，不使用尺寸
容差。新增7项纯测试与完整CI **927** Node（771+53+103）、JS115、Python82
和Go全包通过；缺zip PATH与pnpm shell的两次环境失败日志保留。

最终专项 `run-ttHLU9` **2/2**，实际命令静默310087.7247ms，3owner/8页/
31轮，172原始POST、182原始PNG和2912采样点独立核验通过。490原生渲染
区间中563对跨owner重叠，C结束时B持续工作并保留原scope，A首次恢复即
截图且之后新状态正确。8页均removed、无pending，原4tabs不变；连续焦点
账本零激活/零focus，未增加豁免。初始8页和恢复后2页document visibility
均visible，保留既有focus emulation，不据此宣称hidden/intensive节流。
生产未改、原ZIP hash不变；冻结361源码/7二进制/192历史结果后实测。

独立默认回归 `run-NDr4vF` **104/104**，与前主套件case名称逐项相同，未
启用长测；15研究任务90来源/15POST及75创建/60关闭/15保留重新核验通过。
全套六激活/四focus精确归因既有fixture与控制面板动作，无新增豁免。两轮
源码/runtime/产物/历史身份一致；最终仅文档更新。P09/P12本片完成，更多
平台、浏览器配置、长期压力和既有能力缺口仍开放，完整目标继续active。

### P03：真实浏览器安装与发现

从干净 `f678039` 继续；上一片真实验收和本地提交属于进展。当前catalogue
实际仅实现Chrome/Chrome Beta/Edge，Brave/Opera/Vivaldi不只是缺少实测，
而是安装selector和连接profile归属尚未实现。本片核对官方Native Messaging
namespace和profile根，避免把profile目录直接当成host manifest目录，或把
共享注册位置误称浏览器隔离；未证实路径不猜测。补全实际CLI/setup/discovery
及相关测试，再用官方浏览器二进制、独立测试profile和真实native launcher
验证注册、连接、身份、后台动作及清理。保留现有用户host注册和默认profile，
测试注册须有独占归属和可核对恢复；主线程唯一启动真实浏览器。

P04并行核查发现，旧三SDK快照schema严格，位置扩展应显式opt-in；pinned
CRX对变换OOPIF的boundingBox只加祖先AABB偏移，不能直接宣称坐标正确。
该方向先保留事实和待验证项，不用简单加boxes字段当作完成。本片优先修
已明确缺失的跨浏览器入口，其他能力要求保持，不推送、不提PR。

Windows三品牌catalogue及安装实现已落地；共享Google namespace会校验并合并
合法origin，双registry视图冲突明确拒绝；新增OS文件锁和manifest原子替换。
ZIP在覆盖原文件前读真实key预检；复制UUID保留歧义，不再按首匹配猜品牌。
Linux仅新增官方源码确认的Brave，未猜macOS及Linux另外两品牌路径。
完整CI **935** Node（771+53+111）、JS115、Python82、Go全包通过；新增
OS helper已做Linux/macOS交叉编译。原生产扩展及47文件ZIP保持既有hash。

新host默认回归 `run-Ov7GEM` **104/104**、终端exit0；独立审计精确case集
与 `run-NDr4vF` 相同，15研究任务/90来源GET/15POST及75建页60关页15保留
正确；六激活/四focus全由原有fixture动作归因，无新豁免。host、六调用器、
四runtime和185历史结果核验通过；仅新native安装脚本的后续修正不同于首次
冻结，该文件未被默认套件使用。两个host代际及浏览器已退出。未启用长闲置
测试，也不将Port adapter默认套件当作原生launcher证明。

真实品牌验收首轮Brave在签名阶段因PS5误加载继承的PS7 Security模块失败，
没有注册或启动浏览器；修为PS5自身系统模块及UTF8后，三个官方程序签名
只读验证通过。下一轮Brave真实启动，中文版版本页已显示准确profile，
但旧英文label解析失败。自然退出后外部输入法daemon被脚手架误算成浏览器
后代，导致保守保留临时注册。确认实际浏览器保留句柄exit0、专用程序目录
及native目录均无进程后单独清理独占随机叶，未终止外部进程，原失败保留。

后两次Brave失败分别暴露自定义LEO开关的outer click无效和tabs.create的
pending URL尚为空；改用事前已观测inner控件中心的单次CDP输入，并以原
请求URL核对完成加载的准确sentinel。最终 `native-installation-brave-f2CLp5`
exit0，实际Brave155.1.97.56、原生host父子链、Default UUID归属及错误
selector拒绝均独立核验。唯一POST含可信input/change/click、PNG色块准确，
任务页和attachment经finalize移除。全测量区间零激活/零focus/无豁免，host
和browser精确句柄exit0，随机注册、descriptor、endpoint和私有进程全清。
独立审核保留失败原record，不把新通过回填旧记录。

Vivaldi首轮 `1d9k5o` 的About别名经CDP变为无效chrome://about；按官方
程序的UI映射改用engine chrome://version后，`pqexFC` 精确确认真实品牌
和profile，但manager求值超时。新增有界target/connection/首次求值诊断；
canonical chrome://extensions的 `AwOP9S` 同样失败，实际target URL变空，
不能据此归因产品后台能力。三轮未到任务，均保留失败且正常退出/清理。
Opera首轮 `ZS8f2w` 的About是main-view自定义组件，原body观察为空，尚未
到原生连接。下一步仅按实际DOM补观察，并单独验证Vivaldi安装页初始化；
不改变任务焦点规则，不将安装页前台初始化伪装成后台任务。

随后按实际页面结构修正品牌诊断：Opera profile 在 main-view/about-opera
的 open shadow 内；内置广告拦截只允许实际唯一禁用 tuple，未知或启用条目
仍拒绝。Vivaldi 诊断页由实际 vendor UI 的原生 tabs.create 创建，独立观察
页只向准确 vendor extension ID 暴露该 HTML。新脚手架20项测试通过，
没有改动生产扩展、任务输入或连续焦点断言。Opera早期一次WS连接超时
需强制退出，原失败和退出错误保留，不能列作正常退出。

Vivaldi `V8o50Q` 已通过原生连接和公开发现，但 fill ACK 后实际POST为空、
没有input事件；点击可信。加入只读输入前后观察的 `eNV0Su` 在首次goto
期限内失败，尚未到fill。两次整项失败保留，真实后台输入/导航缺口进入
后续诊断，不以setup成功替代任务验收。

Opera `KVzWiz` 原生连接成功、200次profiles返回空；真实Secure Preferences
使用extensions.opsettings。仅按catalogue确认的opera品牌读取该表，其他
品牌仍读settings；新回归覆盖七品牌冲突表、缺路径/manifest和Default/根
profile。Go全包及Linux/macOS交叉编译通过，旧证据与源身份在编辑前冻结。
新host `b2zz2L` 已通过安装/连接发现和正反selector，但newTab报组不存在，
完整任务仍失败；host/browser精确句柄exit0，零前台事件及随机注册清理
保留。Brave同一新host/最终脚手架 `eF73Op` 再次完整通过，终端exit0。

本片只收束已验证的安装/发现和Brave后台任务；Opera分组、Vivaldi输入/导航
继续列为真实产品缺口，不能标P03全完成。保留默认104回归与全CI，后续先用
原生命令诊断分叉定位，不激活任务页或静默重试副作用。仅本地提交，目标active。

下一片诊断分叉已只读审查：Opera createTab在创建inactive页后调用group、
保存session，再update组属性；现有证据未定位哪条API失败，且错误后遗留
一个未交付SDK的页。先有界记录原生group事件和单次调用结果，不禁用分组
或吞错。Vivaldi goto在Page.navigate前先等待CRX attach初始化，故十秒外层
超时不证明导航本身超时；记录attach/初始化/Page.navigate/Input.insertText
发送与完成，并记录实际GET和tab metadata。不要在goto前额外SDK evaluate
提前attach改变时序。focused-widget路由只是输入假设，尚无根因证明。

最终验证已完成：完整CI **947 Node（771+53+123）**、JS115、Python82及
Go全包通过；默认 `run-ewJVHf` **104/104**、终端exit0，独立严格核对364
源码/203旧结果/host与六调用器、15研究90来源GET/15POST/75建60关15留。
六激活/四focus精确对应既有fixture，无新豁免。Brave `eF73Op` 与 Opera
`b2zz2L` 的原生通过/失败报告独立复核，未把后者改写通过。原ZIP保持
1,255,479字节/47文件及cef6706a… SHA；无推送、PR或日常安装变更。

### 品牌后台动作兼容：原生命令诊断与修复

上一片 `6c31505` 为实际进展；本片从干净工作树继续，优先修复已经真实失败
的后台能力，不把连接/发现通过当作完整品牌支持。先增加显式opt-in诊断：
只在独立测试制品中透明记录原生API开始/完成/错误及被动tab/group事件，
保留调用receiver、参数和原Promise，不重放、激活或改变输入。记录有界，
溢出/未知或不完整写出必须保留；诊断运行不得冒充原生产验收。

Opera先确定group创建/消失/update顺序，再修正常单页任务支持与创建失败后
未交付页面的所有权清理。Vivaldi分开验证attach初始化、navigate与输入目标，
记录真实GET和输入前后状态；对路由假设要求原生命令和DOM共同证据。生产
变更需确定性边界回归、实际对应品牌后台任务及既有默认套件，完整P01–P15
范围不缩减。root唯一启动浏览器，其他Agent并行只读审查及局部代码实现。

显式诊断首轮 Opera `BnR9eF` 在 worker module 执行前读取初始快照，整体
诊断不完整；原失败保留。初始读取已移到原有 native getInfo 握手与身份
校验之后，没有添加轮询或任务输入。新定向回归 **34/34** 通过。
`pmcGIj` 完整诊断再次确认：tabs.group 成功，随后 groupId=-1/onRemoved，
再调用 tabGroups.update 时失败。事件只证明顺序，不提供解组原因。
真实任务仍失败；诊断 exit0 只表示记录和严格清理完整，passed 恒为 false。

Vivaldi stable `6TvJ0U` 的真实 debugger.attach 和 Target.getTargetInfo 成功，
随后九条 renderer 初始化命令直至最后快照仍未结算；无 Page.navigate、
无 Input 命令，GET/POST 均为零。不能把这轮归因为导航或键盘路由。
官方签名 snapshot 8.3.4185.3 的 `l5U4my` 在安装前 manager 求值超时，
未到扩展/native/task，不能比较新版分组或输入。它使用 stable catalogue
的隔离目录覆盖，不证明 snapshot 默认目录发现。私有浏览器与随机注册
实际已清理，但从未启动 host，不满足完整 native EOF 诊断条件。

下一步生产改动限定为普通无组任务页和新建事务：复用已有显式 auxiliary
registry，保留现有 grouped 权限语义，仅在新页或明确 claim 的 admission
确认本次短命组消失后选择无组模式。既有 grouped 页的后续解组仍撤权，不自动
转换。agent/user 来源决定关闭或释放；handoff 和实际无组 deliverable 保留
页面并结束旧控制，不能写失效组 ID。创建途中失败或控制结束必须收口
原始调用与自己仍拥有的页；未知接管状态不自动关闭。SDK/RPC 不扩展。

增加显式 `OBU_TEST_NATIVE_OWNERSHIP=1` 原生验收：在默认单页流程后，
通过两个公开 SDK session 核多页互斥、handoff、显式新 turn 恢复、agent
来源不降级、遗漏页实际关闭及 deliverable 在新 scope 中仍无权。要求四次
真实 GET、五次原始 POST、连续零前台变化和精确清理；默认流程与诊断
判定不变。定向脚手架测试 39/39。生产独立审查另补失败清理重试后的
持续接管识别，及已存在任务组内保留失败页的精确撤权，随后再冻结实测。

生产最终以同一 registry 的 v2 `excluded` 记录保存原组拒绝归属，Pause、
end 与 worker 恢复保留；旧 agent quarantine 写失败恢复也不删除锁重授。
明确同 session claim 按 user 接管，确认真实离组或销毁才退休。扩展
**806/806**、独立定向 **76/76**；完整CI **1,001 Node（806+53+142）**、
JS115、Python82、Go全包通过。恢复原四图标后新生产ZIP为1,260,454字节、
47文件，SHA `6ff5c281ad7769750abc66ffde203995a482cd60c5caf1fdfed3bd4e3a7ed5b3`。

冻结 v15 后真实 Opera `7IDBb7`、Brave `vC2mkf` 均完整通过新多页验收及
独立审计：标准12步+ownership35步、每轮四GET/五POST、跨scope拒绝、
handoff/恢复、遗漏agent页实际关闭、交付页新scope明确unowned。Opera
三页实际无组，Brave实际原生分组；每轮十个连续检查点零激活/focus/豁免。
原生/browser retained-handle exit0、精确进程和随机注册完整清理，真实
PNG已查看。369源码/210旧结果与ZIP逐成员一致，没有改写旧失败。

Vivaldi `b9p876` 完成安装/native/selector，却在独立焦点观察页首次求值
20,003ms超时；task不存在、GET/POST零、没有焦点账本。实际host/browser
exit0且清理完成，保留准备阶段失败，不称任务回归。默认主 `run-5TPsWz`
**104/104**、terminal exit0。最终独立审计核 369 源码/210 旧结果、新 ZIP
全部 47 成员与实际 staged 文件、host/六调用器身份一致；15 研究任务的
90 来源 GET、15 POST、75建60关15留及原六激活/四focus精确归因均通过，
没有新增豁免。ignored 审计前两轮因误用结果哈希字段而停止，原日志和脚本
版本保留；修正为逐个实际静态文件及已有 HTML hash 后通过，未更改运行
证据或生产源码。仅本地提交，不推送、不提 PR。

下一片继续 Vivaldi 后台 renderer readiness/输入问题：先用单变量诊断
区分 vendor 创建 tab 的初始文档尚未就绪与真正挂起，同一 deadline 内
实读目标身份和状态，不增加激活、隐式重复输入或以等待掩盖失败。完整
parity 目标保持 active；Edge 原生 focus、popup 初始激活、更多平台和
同组任务比较等既有缺口仍按矩阵保留。

### Vivaldi 首文档与调试器连接时序

从干净 `c6ef3b1` 继续。上一片是实质进展：无组生产路径、真实双品牌
多页任务与默认104全套均完成并独立核验；本片不重复改写已验结果。
旧 Vivaldi 诊断缺少目标 attach 前的 native tabs.get 连续状态，不能由
target URL 变空推断导航被取消。上游 Chromium 在初始空文档 attach 时
会隐藏 pending 可见URL，并可能在未提交导航期间挂起 renderer 消息；
该机制为实验依据，不是已确认的 Vivaldi 根因。

先只改显式 `OBU_TEST_VIVALDI_READINESS=1` 测试诊断分支：管理页和
独立观察页在首次目标CDP连接前，利用原已验证 vendor UI 只读检查实际
tab ID/window/非活动状态、committed URL、status及同一target。创建、
关联、采样、连接与首次求值共享入口25秒绝对deadline，不在gate后重置。
默认验收路径与生产SDK任务不变，不同时添加API trace prelude，不激活、
重新创建、reload或重试输入。诊断passed恒false，完整采集与任务表现分开。
如setup可推进，下一实验才分离新任务页首次commit、group与attach的顺序，
保留原scope、deadline及未知清理边界；没有证据前不加入生产等待或重试。

本片诊断实现经独立审查及全部脚手架 **157/157**，文档/卫生检查通过。
v16 冻结后真实 Vivaldi `7y16Q1` 的 manager/observer 分别3/2样本从原生
loading变为committed complete，再各一次连接/求值；总229/155ms，原25秒
预算不重置。已进入原生产任务，goto/fill/click ACK完成，但before/after
实际value都空，after DOM focus为#note、selection0、inputEvents为空；
唯一实际POST仍为空值/trusted click。诊断exit0/complete，task与acceptance
均失败，旧初始化失败保留，不能由单轮设置成功认定根因或稳定修复。

独立核371源码/214旧结果、原ZIP47成员、host/SDK和真实清理一致；两个
任务检查点408ms零前台事件/豁免，host/browser保留句柄均exit0、随机注册
和精确私有进程已清理。关闭诊断开关的默认 Brave `t8wpE8` 标准任务与
独立审计通过，四检查点零前台事件，PNG实际查看。仅harness/文档变更，
生产与v15ZIP字节不变，没有重复未受影响的全语言CI或默认104套件。

下一片优先从可重现的输入无效继续：先读取真实原生命令、输入焦点和事件，
区分Input.insertText与键盘路由，不以ACK或emulated hasFocus证明成功，
不对同一次失败任务重放替代输入。初始文档问题也仍开放；任何生产改动
都要有新的单变量证据和默认回归。本地提交，无推送或PR，目标保持active。

### Vivaldi 原生文本命令与页面事件

从干净 `8b2337c` 继续，上一片是实质进展：新增readiness诊断、真实任务
再现空输入、默认Brave回归与独立核验完成。本片保留同一原始单次fill/
click，新增独立 `OBU_TEST_VIVALDI_INPUT=1`；与其他显式诊断/ownership
模式互斥。内部固定采用已验证readiness设置和原透明native API observer，
不修改生产、预算、动作或焦点规则；diagnostic passed恒false。

沿用原receiver、参数、Promise的native记录区分命令未发、错target、
已结算和未知。fixture增加有界被动焦点、选区、beforeinput/input/change/
composition账本，保留同文档nonce、原note节点身份、实际值与取消状态。
capture时defaultPrevented不能证明最终未取消，异步观察仍未知时显式标出。
原before/after读取附带账本；动作结束后只再读一次最终账本，失败不重试。
保留实际响应HTML、原GET/POST与独立focus/cleanup，新增观察会影响调度，
不能称为零扰动复现。root唯一启动浏览器，其他Agent实现/独立审查和核验。

固定上游源码提供候选机制：DOM焦点模拟与WidgetBase底层HasFocus不同；
IME处理可以无输入而返回ACK。现有标准只读CDP未提供实际focused widget
选择结果，故不能仅凭“ACK+无事件”断言输入去了浏览器UI。先收直接证据，
再判断需要生产修复、独立输入路径实验或原生层进一步调查。

首轮 `PI0rSV` 未到输入：两setup gate成功，但新任务blank页在create后
22ms attach时尚未提交；九条renderer初始化命令持续pending，goto原约
10秒期限届满，无Page.navigate/Input/GET/POST/DOM。diagnosticCompleted
为false，独立审计核373源码/216历史/原制品及完整清理，零焦点事件。
保留该失败；接续独立 `OBU_TEST_VIVALDI_TASK_READY=1`，只在原newTab
ACK后、goto前，用既有observer/worker权限读同一tab和debugger target，
最多5秒等待原about:blank committed complete，无pending、非活动且未
attach。原group步骤与goto预算不改，错误不重试；旧模式行为不变。

TASK_READY 经独立复审，定向77/77、全部脚手架180/180通过；最后证据
写入也共享5秒预算，超时不会继续goto或在helper里再次等待挂起写入。
v18冻结后 `QAMMuD` 两采样106ms观察原blank提交，再原goto68ms完成。
同task的utility返回needsinput，唯一原生Input.insertText目标和文本正确，
1ms ACK；同document/原note节点仅出现焦点、选区与点击后的blur/focus，
无输入事件、实际值和唯一POST仍为空。诊断完整exit0，任务失败保留。
这次直接命令/DOM/HTTP证据支持分离初始化与文本交付，尚不确定底层widget
实际选择或IME门禁；不把元数据或模拟焦点当作该机制的证明。

独立核375源码/217历史、原ZIP47文件和真实staging/host通过；native
目标/frame/context/objectId链一致。515ms连续focus零事件/豁免，真实
native/browser退出和注册清理完整。大utility载荷截断及三条微任务最终
取消状态未知均明确保留；没有把原收据失败后的截图/finalize计为执行。

默认Brave `QC0zdV` 标准任务、独立审计和实际截图通过，四焦点检查点
零事件/豁免，完整清理；v18生产/SDK/host/原ZIP未变。接续优先以独立
新任务验证原生逐键路径，不能在失败fill之后自动改键盘或DOM重放；生产
初始化修复若采用提交检查，必须限定新建页、共享原动作期限并保留撤权。
仅本地开发、提交；无推送或PR，完整parity目标保持active。

### Vivaldi 逐键输入对照

从干净 `7bb6bc4` 继续。上一轮是实质进展：完成被动原生/DOM采集、
任务首文档时序实验、真实空值证据与默认Brave回归，生产未修改。
本轮新增独立 `OBU_TEST_VIVALDI_KEY_INPUT=1`，内部固定复用TASK_READY与
INPUT，其余显式诊断开关互斥。在全新session/turn/tab/nonce里，保留原
ASCII文本、Delivery note定位器与唯一Submit，只预先选择公开
pressSequentially；不先fill、不增加点击/聚焦、不按失败结果回退输入。

新模式被动记录keydown/keypress/keyup及已有输入事件，容量显式1024；
旧输入模式保持原事件集/256，默认非诊断fixture不变。实包对这39个US
布局字符应发78个down/up，原生target/参数/顺序/ACK与DOM真实值、可信
事件和唯一POST分别核验。采集是否完整、是否确实走预期键路径、任务
是否成功分开，不把错误参数或空值伪装为采集缺失，也不只凭ACK算通过。

如果逐键成功，只能证明该公开ASCII路径可用；fill的替换已有值、Unicode
和contenteditable语义必须继续验证。若原节点收到键但不编辑，检查实际
取消/选区；若正确键ACK且整个文档没有键事件，转向有证据的vendor输入
目标路由或窗口架构，不重复加delay。root唯一启动浏览器，生产改动须有
对应证据和默认回归；完整能力目标与已有其他缺口保持原范围。

KEY_INPUT 实现通过188/188脚手架、独立85/85及最终摘要8/8。v19真实
`HrDsGN` 2采样93ms首提交检查后goto63ms，92ms逐键的78命令全部同原
root，key/code/text/顺序/ACK均独立核正确，0insertText；同文档原note
没有任何键盘或输入事件，唯一POST仍为空。377源码/219历史/原host/ZIP
身份核验通过，508ms零前台事件/豁免，真实进程及注册清理完整。旧失败
保留，未将逐键声明成可用替代；准确内部focused widget仍不能由此确定。

接续独立POINTER_FOCUS：仍为全新任务、原TASK_READY+INPUT，goto后读
before-pointer-click→一次原Delivery note.click→after-pointer-click，
再原before-fill/fill/after-fill、一次Submit和final，共五快照。仅新模式
增加有界pointerdown/up、mousedown/up、click事件，保留真实命令序列、
原node和值/选区；额外点击预先声明，不重试失败fill，不激活标签，
默认及旧诊断行为保留。基于鼠标按坐标命中和键盘/IME焦点选择路径差异
进行判别，不预先推断成功；这不是通用fill实现变更。

POINTER经独立94/94复审，v20 `ttYgKb` 的原input收到完整可信pointer/
mouse/click，点击后及fill前仍空；原唯一Input.insertText随后写入完整
39字符，真实beforeinput/input/change和唯一POST一致。原截图、finalize
与任务页移除通过，五快照同document/node且无事件丢失。379源码/220旧
结果、原host/ZIP和实际staging独立核验，1068ms零前台事件，真实退出和
清理完整。taskPassed=true但诊断acceptance恒false；生产尚未修改。

同v20默认Brave `TKisEN` 所有诊断关闭，标准任务与独立审计通过，截图
实际查看。完整脚手架初轮196/197，一项form fixture首次fetch被Node
禁用端口规则拦截：本机动态端口范围与禁用列表重叠，listen(0)无过滤。
该失败原样保留，单独修测试HTTP传输；不改变系统端口配置或浏览器动作。

修复仅在form fixture单测内改用node:http，保留真实请求和所有原断言，
新增UTF-8/状态/JSON错误/连接重置/截断/超时回归；无共享helper扩张。
修后完整脚手架198/198、零skip/cancel。最终浏览器运行源码保持v20，
其后仅测试传输与结果文档改动；未重复无关生产构建或全语言CI。

下一片以这次明确click→fill流程成功为依据，检查是否存在无额外页面
点击副作用的输入焦点修复。不能把单轮结果扩大为全品牌/版本通过，也
不能把原失败fill自动改键盘或点击重放。生产修复需要对应受控表单、
Unicode、已有值和撤权/期限验证；其他parity缺口保持开放。仅本地提交。

### 首文档检查进入生产动作预算

从干净 `38fb2c0` 继续；上一轮属于实质进展，增加两种独立输入证据，
明确click后原fill可用而无click的逐键仍失败，完整198项测试与本地提交
完成。本片先处理独立的初始化缺口：`PI0rSV` 在首文档未提交时attach
后renderer初始化悬挂；`QAMMuD` 和 `ttYgKb` 在提交检查后goto成功，
后者的额外click发生在goto完成之后，不能解释初始化成功。

生产候选只对本worker明确创建且尚未首次连接的空白页生效，用精确
creation marker绑定tab/window/session/turn/epoch，不从URL或agent来源
标签推断。保持原createTab分组和发布语义，标记必须在页面可被其他
同scope连接操作之前可见。仅真实cold attachment creator执行提交检查，
已存在或共享Page、claim的用户页及普通导航不增加加载等待。

engine dispatch、withPage和transfer setup向内部attachment传递已有
check/remaining deadline。原生tab读取和短采样间隔共享原动作
期限，每个await后及真正attach前重新检查；不增加独立5秒、不在错误后
重试、不用激活/导航/重新创建换取就绪。撤权、身份变化、迟到读取不能
继续attach。首次文档之外的输入焦点问题保持原失败语义。

先独立审查和定向测试，再完整CI/build，冻结后真实Vivaldi INPUT模式
不启用TASK_READY，以原任务证明实际生产路径处理初始化；原fill即使
仍为空也须保留，不悄悄增加点击。默认品牌和主回归确认无新前台事件。
root唯一启动浏览器，其他Agent实现、复核和独立证据审计，无推送或PR。

独立审计发现旧native prelude不记录tabs.get/getTargets，不能据此声称
看见生产检查的末次查询。已有INPUT诊断因此显式开启metadataReads，
在同一透明wrapper记录真实读取；不新增查询、动作、等待或重试。原
receiver/参数/Promise保留，容量和截断边界不变，默认native诊断仍不
包装这两个API，旧trace profile继续可核验。新原生26项定向回归通过。

实现收口为两个生产文件：精确marker在bindCreated后、普通归属发布前
同步登记，最终创建事务通过后才admitted；冷creator在原预算内等事务
及首个blank提交，窗口例外保留。raw attach本身不新增期限，共享已有
pending时也不能撤销其creator的marker。最终native attach前再核scope，
runtime/tab/app/prepare阶段取消只清理实际已经准备的状态。

新增21项生产回归，作者154/154、独立108/108；完整CI为扩展827、脚本53、
脚手架199，共1079项Node，加JS115、Python82与Go全包通过。CI重新生成
的四个icon恢复原字节后重新打包。v21冻结379源码/222旧结果；47文件ZIP
只有background与engine两成员改变，vendor、依赖及其余45成员不变。
独立包审计通过，原生实测host沿用已有6c4版本，本片没有Go改动。

首次Vivaldi `wv2kHQ` 在安装扩展前的chrome://version身份页首次求值
20,011ms超时；生产gate与任务未执行，focus observer也未建立。精确
浏览器exit0、私有进程/随机注册清理通过，但无native连接/EOF证据，
runner实际exit1。保留此失败，同一冻结源码和包在新profile只复测一次。
默认Brave `i40fyX` 标准任务、唯一真实POST、实际PNG与独立审计通过，
四焦点检查点零事件/豁免，browser/native实际exit0与精确清理通过。

本轮主回归 `run-chNw0r` 实际exit1：原104用例41通过/63失败，另有最终
focus-ledger失败。首个未豁免窗口焦点发生在mcp-page-exports最终检查，
其后有两个标签激活；最终原窗口minimized、sentinel仍在但非活动。
因连续账本保留同一事件，后续失败不等于63个独立功能缺陷。原因待核，
不放宽豁免、不把旧104/104结果写成新生产版本通过。

独立第二次Vivaldi `yeWkzC` INPUT-only最终取得生产证据：原goto开始后
真实tabs.get从loading到精确blank complete，接着唯一attach与navigate，
goto82ms；没有TASK_READY或额外点击。原唯一insertText仍ACK但无输入
事件、值与唯一POST均空，故task/acceptance失败、diagnosticCompleted
true，runner实际exit0。403ms零前台事件，host/browser实际exit0与精确
清理通过；关键原始记录、379源码/222历史和新ZIP独立核验通过。

下一片优先处理主回归新出现的未知焦点/最小化及既有Vivaldi输入缺口，
避免在尚未解释的完整回归失败上继续叠加功能。新gate只覆盖首连接，
raw attach、早期About设置、输入焦点及其他parity缺口均保持开放。
完整目标仍active；只保留本地改动和提交，不推送或提PR。

### 排除已确认的测试干扰并继续输入修复

从干净 `d594bb9` 继续。上一轮属于progress：生产首提交检查已落地，
有效Vivaldi实测和Brave验收取得新证据，完整回归失败亦被独立保留。
本轮开始先复核实现与原始focus证据；用户随后明确确认对应测试时段
“有操作”浏览器。因此 `chNw0r` 是存在外部操作干扰的失败轮，不再把
它当作无外部输入的回归对照，也不将每条事件精确归给用户。

据此停止尚未落盘的focus诊断扩展，保持生产、测试和验收判据不变，
冻结v22的379源码/226旧结果，用同包重新完整104项。在这轮完成前不
修改运行源码，不重启已运行的进程，不放宽任何focus豁免。

并行研究Vivaldi无点击输入修复。公开DOM.focus可作为一次预选的新任务
对照，在fill前执行，保留原单次fill/POST与所有失败；不得在失败之后
重放。屏蔽输入事件再模拟鼠标虽可能提供widget线索，但会阻断用户输入，
恢复失败的风险与后台体验目标冲突，本片不进入生产候选。

同版本 `run-p0iiaM` 终端exit0、原104项全部通过。独立审计核验379源码、
226旧结果、host、六调用器、四runtime及47制品成员；15研究任务的90来源
GET、15原始POST、75建60关15留均通过。连续账本只有原六次fixture激活
和两个明确popup产生的四focus，原窗口最终normal/focused、sentinel未变，
没有新增豁免。旧失败字节保留。根代理查看了实际后台PNG，中文输入、
跨frame内容和AI指针可见；主Port adapter不代替原生launcher退出证明。

新增独占DOM_FOCUS诊断：原goto后、首次fill前读取document/原#note节点，
一次DOM.focus；公开owner.cdp.call四次共用5秒预算，无TASK_READY、无
额外点击或按键。独立before记录保留原输入观察表达式，旧三快照和HTML
不变。ACK、采集完整、空值/未focus实验前提、真实任务成功分开判断。
新增14项单测后，全脚手架213/213通过；生产/SDK/host/ZIP未改变。
未知activeElement不视为未focus，错误insertText文本不视为原实验成立。

v23冻结381源码/227旧结果后，`YMxiBJ` 实际terminal exit1。原goto82ms，
四DOM命令20ms完成；原node获得可信focus/selectionchange，但原fill后仍
空值、唯一POST为空，无beforeinput/input/change，因此不能作为输入修复。
398ms连续焦点检查零事件/豁免；host/browser精确exit0和进程/注册清理通过。
生产与原ZIP不变。原判定的collectionComplete为true、experimentObserved
与diagnosticCompleted为false，保持原结果。

独立复核发现两处诊断比较器假阴性：describeNode参数对象字段顺序不同，
语义相同；DOM.focus的worker结束时间比调用端结束时间晚1ms，不能把两个
上下文Date.now当成严格同一时钟。后续只修判定：对象结构语义比较，native
唯一命令/目标/参数/返回值与同worker序号关联，本地await顺序/总期限独立
检查。跨上下文时间窗口仅观察，不增加时间容差，也不把原任务改判通过。

冻结v23下独立审计v2已exit0，381源码/227历史/47制品成员和原始HTTP、
DOM、focus、精确清理通过；v1先复现了上述判据假阴性，两个审计都保留。
原结果中的diagnosticCompleted=false/terminal1不改写；语义匹配说明另存
审计结果，不作为新动作或任务通过证据。

比较器修正再增四组回归：对象成员顺序、跨进程时间偏移、原生输入序号
及鼠标ACK并发。作者/独立18/18，全脚手架最终217/217，无skip/cancel。
修正只改变诊断匹配，原动作、fixture、原始结果和生产包不变。冻结v24
381源码/228历史，以默认Brave及单次Vivaldi验证最终脚手架；后一轮是
判据修正后的独立执行，不作为失败动作的fallback或原记录改判。

最终默认Brave `KKcjBO` terminal exit0，原12步、唯一真实POST、实际
PNG1877×1926及清理通过；根代理和独立审计查看截图，指针/点击圈可见。
744ms四检查点零前台事件。Vivaldi `ntZmPW` diagnosticCompleted=true、
terminal exit0，但task/acceptance仍false：goto73ms、DOM链22ms，原节点
获得可信focus，原fill仍无输入事件且唯一POST空。433ms零前台事件。
两轮独立审计核381源码/228历史/47制品成员、精确host/browser exit0、
私有进程清空、双视图随机注册移除和固定注册不变通过。

本片为progress：同生产版本完整104通过，明确用户操作干扰的旧失败边界，
排除DOM.focus候选并修好可重复诊断。下一片继续Vivaldi无额外点击输入及
其余矩阵缺口；不重复无新假设的同一路线，不放宽前台或真实输入要求。
完整目标仍active，所有代码与证据只保留本地，无推送或PR。

### 仅移动指针的输入对照

从干净 `35d0a95` 继续，上一轮属于progress：同版本主104通过、原失败
边界查明、DOM.focus候选经两轮原生证据排除，诊断判据修复已本地提交。
整体目标和全部矩阵缺口保持不变，不以某品牌单一fixture等同整体对齐。

本轮预选一个独立HOVER_FOCUS诊断：原goto后一次公开input.hover，再
原单次fill/Submit。已有click→fill成功、DOM.focus→fill失败，hover可
进一步判断仅坐标定向移动路径是否足够；不在动作失败后补发或重试。
固定Chromium公开源显示非wheel mouseMoved也在路由到目标widget后调用
Focus；供应商私有delegate未公开，不能据此预定成功或认定底层根因。

复用原INPUT HTML/被动观察器，保留三快照；额外before-hover与原before-fill
记录原节点、值/选区以及只读`:hover`状态和矩形。真实hover事件未额外监听，
hovered状态或坐标仅作行为观察，不要求为true来让采集或实验成立。
全trace独立核1移动→1insertText→Submit三鼠标、实际ACK和同worker序号；
若引擎因actionability产生额外命令，如实保留并判实验不匹配，不改引擎。
无TASK_READY/DOM.focus/force/按键/额外点击，原owner/turn/tab与动作期限不变。
hover可能触发滚动、CSS和页面handler，即使成功也不静默加入通用fill。

HOVER_FOCUS实测 `Fm2cYE` 原goto96ms、hover188ms、fill12ms、Submit83ms。
同worker原生链为一次mouseMoved143→144、唯一insertText167→168，以及
Submit三命令200–202→203–205；目标、参数与ACK完整。原节点`:hover`
false→true且坐标在前后相同矩形内，但hover后activeElement仍为body。
原fill仅产生focus/selectionchange，无beforeinput/input/change；唯一
可信POST的note和inputEvents均空。diagnosticCompleted=true/terminal0
只表示实验完整，task/acceptance=false，无截图或finalize。552ms连续
零激活/零focus/零豁免，精确host/browser exit0与注册、进程清理通过。

默认Brave `zwqwku` 清空所有诊断标志后，原12步/唯一POST/实际PNG与
清理通过；根代理查看1877×1926截图，输入、收据和Submit处AI光标可见。
697ms连续零前台事件。两轮独立审计核frozen-v25的383源码/230旧结果/
47制品成员一致，原INPUT及默认HTML未改。最终脚手架231/231、独立定向
63/63通过，生产/SDK/host/ZIP保持原版本，没有重跑无变更的完整CI。

本轮排除“仅指针移动足以修复输入”，不把click成功归因于单个mousedown
机制。固定Chromium源码的ImeSetComposition与InsertText仍使用同一
focused-widget选择，未发现不同公开路由，因此不继续没有新依据的输入
实验。下一片转P04快照观察元数据；Vivaldi通用fill、Edge焦点及其余矩阵
缺口保持开放。整体目标active，本片progress，只做本地提交，无推送/PR。

### P04 快照位置与 frame 观察

从干净 `e12a378` 继续。上一轮为progress：HOVER候选经实际原生任务排除，
默认Brave和231脚手架通过；本轮不重复没有新路由依据的Vivaldi实验。

本片在原snapshotAI上增加opt-in `boxes: true`，保留默认协议形状。原生
renderer同步采集真实ref对应元素的rect和frame viewport，输出带box的
YAML及结构化geometry。固定字段、原refs/frames限额和原请求期限约束
整个过程；不滚动、不激活、不通过N个单独locator查询拼接。真实Frame
GUID、父关系和ref归属在runtime核验后移除内部字段，再发布capture。

已查到既有引擎child boundingBox只是quad加iframe偏移，不足以正确组合
父级缩放/旋转。因此本片明确使用frame-viewport CSS坐标及ownerRef关系，
不伪称top/global坐标或可点击性。详细契约见[位置元数据](../../references/snapshot-geometry.md)。

验证安排：独立实现vendor patch、三SDK和五入口真实fixture；根代理负责
engine/runtime身份边界并统一启动浏览器。保留原104主case，新增opt-in
专项覆盖root/同源/OOPIF/嵌套、各frame滚动、父级变换和DPR，独立DOM
oracle与实际PNG像素核对；所有焦点规则不变。生产变更需完整CI、制品
检查和主回归，旧失败与旧结果保留。验收尚未完成，整体目标保持active。

首个几何专项 `run-tIVleQ` 实际exit1，10项中5通过。保留其v26冻结和全部
原始caller结果：root在任何snapshotAI前读回DPR1.5，而动态Emulation要求
1或2；PNG尺寸却跟随请求比例。同源child短暂读到请求值后回到1.5，不能
把该不稳定环境的before/after差异直接归因于快照。生产rendering lease未
发送metric override，snapshotAI也不走lease，尚无证据锁定原生原因。
Go失败另有明确测试错误：既有Screenshot结构被直接JSON编码为Base64/
MimeType，检查器要求小写字段。改caller显式映射，不改SDK截图API。

下一次验证使用三个独立浏览器实例的原生启动比例1/1.5/2，每个比例保留
五入口×三布局，共45张PNG；不再动态模拟DPR。每次仍要求测得的DPR匹配
启动参数、DOM/原生box误差不超过1e-6、观察前后深比较相等。滚动改为在
三种DPR下都对应整数设备像素的36/160和12/72，避免scrollTo量化误差，
不放宽几何断言。默认104主用例及生产包保持不变；新脚本需新冻结。

最终脚手架238/238与Go新增截图编码回归1/1通过。v27冻结394源码和233
旧结果，48文件生产包与七个Go调用器/host/运行时hash固定。DPR1/1.5/2
三个实际run `oVaN3m`/`wTM1CH`/`x5s4pZ`各10/10、终端exit0及独立审计
通过：45张PNG、315目标框、180 iframe框、12个capture ref读取均核验，
实测坐标偏差0，观察区间零前台事件；旧动态DPR失败仍不算通过。

新主回归`7YcNf9`终端exit1，原104项99通过/5失败，另focus-ledger-final
失败。JS chooser的dynamic OOPIF首轮ready剩9998ms，新增frame123ms、
点击114ms并ACK，collect约240ms内发出，但原10秒内没有原生chooser
事件和POST；root/静态OOPIF先前成功。现有trace只有attach/nav/swap，
不能区分点击未触发picker与interception路径问题，不能靠加deadline或
重放修补。末段两popup遇inactive窗口，最终root窗口minimized，额外两项
被未知focus账本拒绝。此轮是否有人操作另行询问，未收到回答前不归因。

下一步增加独立opt-in的有界被动native send/ACK与失败后只读DOM证据，
不改原动作/HTML、deadline或重试策略，先定位chooser；焦点失败另核。
本片为progress，P04专项完成而全套未通过，整体目标继续active。

用户随后对20:20–20:24新一轮回复“可能点了点窗口啥的”。因此补记
`7YcNf9`可能存在外部操作；原失败和独立审计保留，不认定所有focus或
minimized事件均由用户造成，也不把更早chooser超时归因于此。该轮不
作为无外部操作的焦点回归对照。继续进行有界chooser诊断。

新增独占 `OBU_TEST_CHOOSER_DIAGNOSTIC=1`，只选择原JS chooser及原始raw
导航对照。按原tab记录native命令/ACK和frame/chooser事件，保留原Promise、
参数、异常与动作；失败后用原scope做总计3秒的只读采集，先于原cancel。
截断、丢失、未结算或失败DOM缺失均标为采集不完整。原HTML、上传字节、
10秒期限及默认104项保持不变；探针会影响调度，不作为时间中性对照。

最终集成脚手架250/250，独立定向15/15及六份HTML字节对比通过。v28冻结
396源码/237旧结果，生产48文件ZIP、host和SDK未改。诊断 `Yh4Yz7` 终端
exit0、原两项通过，三variant共6次真实chooser/POST；动态child拦截ACK
先于原点击，同child事件早于关闭拦截。此次未复现旧超时，不能称修复；
失败后DOM分支未在真实故障中触发，诊断acceptancePassed始终为false。

随后关闭所有专项/诊断标志，默认 `ZzBRWH` 原104/104、真实终端exit0及
独立审计通过。没有诊断对象、variant插桩、额外诊断文件或worker探针。
194500ms同一observer内六激活精确对应原auxiliary窗口创建、四focus
对应原两次设置popup，后台豁免0，root初末normal/focusedtrue。启动和
退出不在此账本覆盖内。原15研究任务的90来源、15真实POST及75创建/
60关闭/15保留另行核验，源文件与生产身份匹配，237旧结果保持。

本片P04及最终默认回归完成；chooser旧失败原因仍未知，没有据成功轮
增加生产补丁或重放策略。Vivaldi无点击输入、Edge原生焦点及其他平台/
完整任务边界继续保留。整体目标active，仅本地提交，无推送或PR。

### P02/P13 MCP 连接实例绑定

从干净`e030358`继续；上一片为progress，P04专项与最终104回归通过。
已确认MCP保留runner/currentTab/control，却在每次invoke和begin重新发现
endpoint。active registry或profile候选变化时，旧数字ID和epoch可能被
带到另一实例；仅缓存路径或持久profile UUID不足以约束同路径替换。

本片让MCP首次浏览器请求选定实际连接，并在整个stdio服务期间复用。
初始化/list不要求浏览器在线；首次连接成功前可重新提交发现请求，绑定
以后不重新发现或自动重放。独立reader持续消费通知，按唯一请求ID交付
响应，避免闲置背压。响应等待超时保留reader帧边界并丢弃迟到回复，可
显式在同连接begin-turn；EOF、帧错误及不确定写入关闭该binding，后续
请求要求重启MCP。原submission期限、控制generation和后台行为保持。

测试覆盖A/B切换、同路径替换、首次连接前失败、超时迟回复、断线零重发、
空闲通知排空、stdio退出清理及原控制用例；根代理统一运行真实浏览器
入口验证和必要主回归。首次selector发现及更广重连能力的边界仍需如实
记录，不把本片完成等同整个能力矩阵完成。

实现及独立复核完成：首次连接绑定、常驻reader、唯一wire ID、未知写入
永久断线及stdio清理；发现各网络尝试共享剩余期限。Go全包与完整CI
Node836+59+258、JS120、Python86通过。初次旧分类测试1ms扫描预算导致
未实际探测，已改为合理预算并检查真实探测次数；超时由独立用例覆盖。
无CGO工具链，race未验。v29冻结402源码/239历史和新主机，48扩展成员
与v28相同；打包容器hash改变如实保留。

专项`ykbo3D`实际terminal0、2/2及独立审计通过：旧进程三次断线拒绝，
新进程显式恢复，两笔实际可信POST、task tabs/targets清理、两个MCP正常
退出，5999ms同observer零事件/豁免。原生Port仍为声明的loopback适配。
同构建默认`k5giEj`实际terminal1、103/104，唯一失败为JS动态OOPIF下载
原10秒等待超时。没有file GET/native download事件，click ACK、DOM与
child初始化顺序缺少原始证据；未定位，不能归因MCP或用户操作。其余
下载入口、十五研究任务及恢复用例通过。本片为progress，目标继续active。
下一步只加原调用阶段、透明原生命令时序及原scope失败DOM诊断，不延长
期限、不重放点击、不激活页面，以确定下载触发失败的位置。

### P10 动态下载触发诊断

从干净`2719d44`继续，上一轮是progress：MCP实际连接绑定与专项已验，
默认`k5giEj`明确保留103/104。当前没有活跃浏览器或未结束的执行句柄。
失败时只记录下载事件，无法区分点击未命中、网页默认动作未触发和child
初始化时序。准备预算未耗尽不能证明native输入已命中，因此先补证据。

新独占`OBU_TEST_DOWNLOAD_DIAGNOSTIC=1`只跑原JS page-download和raw
navigation对照。复用原chooser透明命令记录器的有界逻辑，新增严格
download类型白名单与独立key；chooser默认行为保持。诊断开启时记录
arm/add-frame/click/collect/verify/cancel各原调用阶段，保留原业务异常
和单独的cancel错误。失败后、原cancel前用原scope一次总3秒读取原tab、
window/focus、root与唯一已观察child的DOM；根坐标不推算进child。
不改变原HTML、等待期限、动作参数或次数；诊断侧链可能改变调度。

默认104项没有命令probe或失败DOM读取。诊断结果的任务通过和采集完整
分开，acceptance恒false。先做语义测试与独立复核，冻结原生产制品，再
由根代理运行真实诊断；若出现可归因证据才改生产，历史失败不覆盖。

本片实现并独立复核：全部脚手架284/284、定向32/32、原6份HTML字节一致；
错误阶段/原异常及取消异常分别保留，未改点击次数与deadline。v30冻结
405源码/241历史，host/SDK/48文件ZIP均沿用原身份。
`avWmSX`实际exit0，两case通过且采集完整；独立审计29原生命令/ACK、
78连续记录、3GUID/GET/实际文件12,297bytes及3784ms零前台事件通过。
旧超时未复现、failure DOM实故障分支未触发，acceptance仍false。

随后关闭所有专项开关，`Ve7nKv`实际exit1：原104项87通过/17失败另有
focus最终失败。五入口下载及生命周期通过，后续21:30:52新的focus导致
持续账本拒绝；用户明确回复有窗口操作。原失败保留，不能作为干净焦点
对照，也不把未知下载根因或所有窗口变化直接归因用户。本片为progress，
整体目标active；需要继续定位低频输入/下载触发并补其余矩阵证据。

收尾独立审计确认默认模式未注入诊断，五入口共15个唯一GUID、真实GET
及每个4099字节的本地文件逐字节和nonce一致，均早于新focus事件。
冻结身份与单代host正常退出通过；研究流程整体和焦点审计仍失败，
后续恢复用例未执行到重启动作，不能宣称host重启通过。本片仅脚手架
与文档变更，未重跑全CI；本轮284项脚手架测试不替代上一检查点全CI。

### Windows 预览版交付

用户随后明确授权在自己的GitHub fork推送当前代码并打包先用；不提PR的
约束继续。核实已有`mikyan/open-browser-use`是原项目fork，复用该仓库并
推送`codex/browser-use-parity`，未改其main。发布卫生检查覆盖45个新增
提交、606个当前文件和1308个去重blob，未发现新增真实凭据或私有日志。

已发布[preview-20261011-593a4ba](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261011-593a4ba)，
固定源提交`593a4ba92619efeecc4bc1a48a55387c5a56bcaa`，标记prerelease。
Windows x64便携包包含干净源码重编译的Go1.26.9/CGO0主机、预解压扩展、
Edge/Chrome用户级注册脚本、完整6文件Skill、中文说明及许可证。扩展
48件与已验制品一致，只有manifest添加现有beta public key，固定ID为
`pnbmoicbkopffjjgfgfglopechaiemkp`；没有新增生产功能或Pi专属适配。

新二进制相关SDK/主机23项通过（含真实Windows IPC），无跳过；三ZIP、
源码身份、成员字节、SHA256SUMS、许可证与注册ID独立审计通过。四个
GitHub资产实际下载回核验一致。便携ZIP的SHA256为
`57322cf9a80c53b49b9f2f6af9908bfff70cf371d12592b2e9c4a559dbe4f349`。
没有实际修改日常profile或注册表，安装后连接仍由用户确认。本片是交付
进展，不是全套浏览器回归或完整能力验收；整体目标继续active。

### P10 选择器提交的单次消费与失效边界

从干净`8fc8030`继续。上一问答核对了公司电脑安装步骤，没有推进能力；
本轮重新检查源码后，发现`setFileChooserFiles`在原生命令完成后才删除
chooser，允许两个并发提交进入同一节点；非空上传等待返回后也未复核
原scope。空列表清理在finally通过数字tab/session释放remote object，
尚未证明仍是原attachment。先用可控未决原生命令复现，再修生产边界。

本片保留现有公开入口和文件/清空语义：提交前同步占用原chooser，未知
结果不恢复可重试状态，等待后拒绝控制失效成功，清理只投原attachment。
发送前文档失效必须拒绝；发送成功后change触发的合法导航允许完成，
只重新核对原scope、attachment及实时tab归属，不要求旧DOM节点仍存活。
独立测试覆盖并发、导航/控制结束和attachment替换，随后从正式SDK运行
真实root/OOPIF上传、清空及必要回归。不得凭模拟声称实际文件验收完成。
目录枚举的完成屏障及诊断系统钟跳变仍另行保留，不以丢弃实时日志或
修改既有焦点豁免消除缺口。已发布预览资产保持原样，整体目标active。

诊断边界的先前只读研究另留结论：单次Runtime/Log enable ACK并不能覆盖
renderer自动restore及raw CDP重新enable。按原session/代次在原生入口
标记可摆脱墙钟，但初始和恢复窗口中的实时日志与历史重放没有协议标志
可区分；直接全丢会损失当前日志。未据此替换现有生产fence，下一片不得
把这项语义退化当作系统钟问题已解决。

本片实现完成并独立复核。原HEAD46项通过，新测试对旧源码73项中23项
明确失败；修复后73/73。最后稳定并发失败的CONSUMED分类，初版73/74、
最终74/74。扩展864、脚本59、脚手架296全部通过，文档/卫生/Action固定
检查通过。真实专项`frp1Zt`9/9、6个原POST和97字节文件独立核验通过，
16770ms零前台事件/豁免；初版全套`WUe0YQ`105/105。

最终源码`X2wiUq`实际exit1、104/105。Go root/已有OOPIF上传和清空通过，
动态OOPIF首轮chooser等待超时、没有POST；新单次提交与其余用例通过。
原Go helper仅成功后写结果，无法还原失败时arm/collect阶段或click ACK。
焦点最终校验通过，原六次fixture激活与四次popup focus均保留。不能据
旧轮全绿标最终版本全绿；不再盲目重复全套。下一步给此Go路径保留有界
原调用阶段和失败前证据，复用既有透明chooser诊断，确定超时来源后再修。
目录完成、系统钟隔离和其他P01–P15缺口仍开放，本片是实际修复进展。

### P10 Go chooser 失败阶段与原生诊断

从`ff3f4d4`继续。公司电脑安装问答不计新的开发验收。当前树干净；保留
`X2wiUq`完整失败，不盲目重跑或把相同报错限定为collect问题。源码复核
发现click也会等待chooser拦截屏障，收到事件后的关闭拦截同样可能超时。

先让Go caller在任何失败时保留variant、原arm/add-frame/click/collect/
set-files/receipt/cancel阶段和独立错误。新增显式隔离的Go诊断模式，通过
有界JSONL握手在Navigate后、arm前安装精确tab原生命令观察；原操作失败后、
Cancel前一次读取trace、浏览器metadata和focus。若唯一失败为Cancel自身，
则在该失败Cancel后、剩余清理前采集，以实际阶段为准。Go缺少原scope快照，
本片不为诊断新增SDK接口，也不重新bootstrap或attach，明确不读取任务
DOM。原10秒chooser/默认click及15秒transport不变，无额外点击或焦点
豁免。诊断完整与业务成功分开，原失败证据持续保留；随后跑诊断专项及
无hook原专项验证，依据新证据决定生产修复。

实现和独立评审完成：脚手架339项及Go helper包通过。Go↔Node真实子进程
以无浏览器的非法loopback参数验证失败partial/JSONL与实际exit1；受控
测试覆盖阶段错误先于取消、取消/诊断错误不覆盖原错、超时/错序ACK、
日志限额、晚安装清理和worker身份。诊断`nFsRPz`2/2、普通专项`JWc1eT`
9/9、普通完整`npV0kp`105/105，均实际exit0，没有重复原点击或新增焦点
豁免；旧Go动态iframe超时未再现，不能据此判已修复。

评审发现caller结果对象被成功验证的server/frames注释共享修改，改用
副本验证；总采集完整性同时要求实际失败variant覆盖和落盘/标准输出
一致，缺失文件不再能标完整。最后校正文案：Cancel自身失败的观察在
该次Cancel之后。以上只改报告/守卫，最终诊断`PbIrsJ`2/2、exit0通过；
完整105项运行发生在这组报告修正前，生产、SDK、Go业务及collector未改。
保留全部旧失败和两版报告；不以新全绿抹去低频超时，也不更新已发布ZIP。

### P10 目录上传完成与原节点隔离（进行中）

当前基线为`1f56467`。Chromium 的目录枚举异步于`DOM.setFileInputFiles`
ACK，且`webkitdirectory`仅使用路径列表首项。先保留旧生产基线并新增
真实目录fixture，随后要求恰好一个目录路径，并同时等原生ACK与原节点
可信input事件。cancel、上下文丢失和截止时间不能冒充完成；不把空目录
旧FileList上的cancel当作成功。普通文件仍按原ACK语义，清空仍显式触发事件。

同步单次消费与节点reservation先于原生await；固定isolated world上的
WeakMap guard跨worker/debugger重连保留未定目录，防止迟到结果完成后继
提交。所有setter含普通文件与clear均服从原节点pending；调用撤权只结束
本caller，不以detach推断renderer枚举停止。本次setter单独10秒默认总预算，
不复用chooser等待剩余时间，不重发输入。测试需覆盖可信事件/ACK次序、
超时后迟到结果、同节点并发、跨attachment、原scope撤权和合法完成后导航。

真实JS验收涵盖root、已有与动态OOPIF；同步HTTP witness在方法返回第一
continuation即存在，之后校验实际File字节与webkitRelativePath。覆盖中文、
重复basename、二进制、零字节、空目录、重复选择及无效/多目录拒绝。
已有105项和焦点豁免不删改；单独新case加入默认回归。旧Go chooser低频
故障、其他P01–P15缺口与已发布ZIP继续保留。

前一片完成了真实guard、ACK/input完成契约与SDK期限，但默认inactive页
仍被Chromium156原生取消。完整`Ob0pFy`为103/107，保留该取消及JS/MCP/Go
动态chooser超时，后三项与新改动关系未排除。1311项Node通过不能替代
浏览器验收。后台popup实验`Nl0c74`在dynamic Add frame超时；随后显式
诊断`R1naUp`16轮/13POST/408原文件字节完成、三次新窗口首tab激活、零
window focus，普通chooser诊断`v9GDXO`也通过；诊断未复现不等于修复。

### P02/P10 显式后台窗口（进行中）

已将独立窗口路线接入正式`createTab({backgroundWindow:true})`，
省略/false保留原路径。新建normal窗口、focused:false、唯一about:blank页，
不移动既有任务或用户页，也不自动重试目录提交。SDK先检查
`backgroundWindowVersion:1`，防旧扩展忽略选项；三SDK与现有CLI open-tab /
MCP open_tab均接入，不要求用户另行运行测试脚本。

复用创建事务与fresh-blank初始文档检查，独立record kind与agent origin
保留同session的既有分组和页面。存储兼容旧版本，控制范围失效/暂停/迟到
ACK不能授予控制；用户移动、分组或pin后撤权。finalize只关闭自己的tab，
Chrome自行关闭空窗口；窗口内后来出现的其他页面不能被整窗删除。

v3存储兼容v1/v2；用户移组/移窗/pin后的阻断先同步生效，再保留持久撤权，
不能因回到原组而自动重授。明确reclaim改为user origin。窗口中额外的
非任务页不进入session清理范围，正式接口不会整窗删除它们。

正式验收`UPWXAL`4/5、exit1，inactive fixture冷scope比较错误已修，原
失败保留。最终完整`zyiYQg`106/109、exit1，原105项名称/顺序不变，新增
隔离世界、inactive目录拒绝、后台窗口目录、混合finalize四项全过。目录
16轮、13POST、30份文件载荷共408字节独立核验；12次目录选择可信input，
另一次显式清空沿用合成事件，三项非法提交明确拒绝。成功方法返回的
首条回调即检查同步witness；异步字节随后核对，不以poll补足过早返回。
inactive仍可信cancel且零上传，这条默认限制未改变。

全套账本11次激活由四次新窗口创建、一次额外页自然继任及原六次fixture
动作组成；四次focus仍是既有控制popup，零未知事件，新窗口用例零window
focus，原sentinel不变。精确新任务tab/window/attachment清理及额外页保留
已核验，不扩称全部fixture页/进程清空。Node1347、JS129、Python94通过；
受影响Go SDK87与CLI109个顶层测试通过，另有23项既有平台skip，不称
全平台无跳过。旧发布ZIP不含本feature。

未完成项：JS单次提交、JS双连接及Go双连接在动态OOPIF首轮collect超时，
均未调用本轮setter；原生输入/interception投递证据不足，本轮变更关联
未排除。保持P01–P15完整目标，不以四项新增通过结束本计划。随后一次
精确JS opt-in诊断`Tu6rks`2/2、exit0未复现；接下来只在原失败后读取既有
chooserEvidence，成功前不新增API/监听，以捕获trusted click是否到达。
原生输入表面尚未就绪只是待证假设，不据此改生产或宣称已修复。

固定 Chromium 156.0.8078.4 源码进一步缩小了候选：其浏览器测试用内部
[`WaitForHitTestData`](https://github.com/chromium/chromium/blob/156.0.8078.4/content/public/test/hit_test_region_observer.cc)
检查精确 FrameSinkId 的聚合命中表；当前未找到公开只读 CDP 等价入口。
[`InputHandler`](https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/protocol/input_handler.cc)
的鼠标成功 ACK 不保证 DOM 收到事件，screencast ACK 也只确认流量。
因此不把固定等待、第二张截图或串行 mouse ACK 冒充确定的就绪屏障。
child-session 输入路由可以从 child 开始查找，但仍涉及根命中表，且可能
跳过祖先遮挡；只有保留原定位器的父层命中、坐标和权限检查才值得实验，
不能直接替换通用点击。以上是源码边界，尚未证实本轮故障原因。

默认失败后观察及错误保留已实现，Node1369通过。随后完整`XHmJdq`
108/109、exit1：原105项本轮全过，新增目录dynamic首轮collect失败；无该轮
chooser/setter，尚无点击/原生命令证据。root/static12轮完成9POST/272字节，
11激活/四既有popup focus全归因，精确清理及额外页保留通过。生产/host/SDK
与前轮一致，不能因普通chooser本轮通过就判旧问题已修复。

目录现接入同类post-failure观察，六种HTML、成功动作/期限不变；保留
原document IDs、directoryEvidence与input token，单独3秒预算，不重试。
最终Node1373通过。专项`JwX2Bc`10/13、exit1，四项新检查通过；JSsingle、
JSready及Goready的dynamic首collect失败。三份自然故障观察均完整，6/3/5ms
内精确当前文档读取证明root有可信frameAdd，child没有记录click/change。
JS在cancel前、Go在child取消/关闭后读取；仍缺点击时身份及down/up完整序列。
下一步在显式诊断fixture中记录有界原鼠标事件以区分未投递/部分序列，默认
HTML及原动作/期限不改。没有精确child就绪证明的帧等待、synthetic tap或
child直发鼠标不作修复：后者会绕过祖先新遮挡，tap源码也有命中表同步TODO。
完整P01–P15目标及既有平台缺口不变。

已将上述pointer/mouse被动记录接入现有JS显式诊断。每文档最多256事件/
65536序列化字符，记录原节点、坐标、按钮、可信位及documentToken；空日志
有效，缺失/溢出/错误不完整。成功不读DOM、不增POST，默认六种HTML对
`96d4918`逐字节相同。原3秒诊断预算另补worker API与注入DOM实际执行前
截止检查，防迟到请求读新状态。Node1380及独立22项通过。

一次`Cq7i08`2/2、exit0未复现；三布局原生trace完整，但pointer观察均未
请求（complete=null），故不支持根因或修复声明。不要重复同一成功诊断
来替代故障调查。下一片考虑只保留fixture被动事件记录、复用默认失败后
documentId读取，移除诊断前置握手/原生命令wrapper的额外时序影响；须显式
标明模式、保留原动作/期限/默认HTML，并让未读或不完整证据保持未验证。

上述轻量 `pointer-only` 已实现：单一pointer校验函数，失败读取保留精确
documentId、固定字段/容量及原3秒预算；成功方法顺序不变，未读完整性null，
完整失败证据true不改变业务失败。默认及原native诊断共12份HTML对
`0f90a18`逐字节一致，Node1388/1388、独立54项通过。`S5wSpZ`实际2/2、exit0，
6POST/5份文件共97字节核验；90项源码身份一致，零激活/焦点/豁免，三任务页
已移除。仍无失败读取/实际pointer数据，不证明输入修复。

后续实验保留 `JwX2Bc` 的13项名称与顺序，显式 `pointer-context` 模式只对
JS双连接的三个fixture key启用被动pointer记录；其余页面保持默认HTML。
不新增前置API、原生命令wrapper、成功读取或输入重试，原业务/focus gate
及名单完整性均保留。Node1391/1391、独立57项通过，默认及旧opt-in六种
HTML分别逐字节一致。固定13项的遗漏/增项/乱序强制失败；目标JS结果与
全体业务结果分开记录，不以证据完整性覆盖业务错误。

同一冻结源码的有限三轮为 `yLC7OT` 13/13、exit0，`NuEbdZ` 12/13、exit1，
`HakXg4` 13/13、exit0，均保留原13项顺序。中间轮Go的dynamic OOPIF首轮
collect再次超时：原Upload click已返回、没有chooser结果或setter，Go子进程
原cancel/close之后的6ms当前文档观察完整；root有一次可信frameAdd，child
clicks/changes为空。JS目标三轮通过且未读pointer，collectionComplete=null；
中间轮allOriginalTasksPassed=false且进程确实exit1。没有捕获完整鼠标序列，
不将38/39诊断记录冒充普通验收通过或生产修复。

独立审计每轮114项当前源哈希相符且三轮一致，正式host均exit0；每轮五次
激活均为原后台窗口用例的精确允许项、零window focus，chooser/目录任务页
清理完成。五入口chooser加目录原始POST分别43/41/43（另行核的submission/
lifecycle不计入该数）；每轮目录13POST/30文件/408字节，中间轮Go仅已有
root/static的4POST/3文件/62字节。通过者不覆盖dynamic的零POST失败。

下一步应把现有有界被动记录和失败读取精确覆盖到实际再次失败的Go路径，
保留其原子进程操作与取消顺序，避免继续仅重复成功的JS目标。源码研究的
original move receipt只能证明观察到相符事件，不能绑定CDP request或证明
后续命中；未取得真实投递证据前不增加输入、不引入猜测的渲染屏障。完整
P01–P15、生产稳定性和旧发布包边界继续保留。

已以 `pointer-go-context` 复用同13项顺序，仅Go三fixture key启用原有
被动记录，parent既有失败观察继续在Go子进程取消/关闭后、finalize前执行。
Go成功顶层variants与失败callerResult分开校验；观察必须精确绑定唯一失败
项的tab/key/variant。作者及独立定向60/60通过；原JS模式和已有HTML、Go
helper均保持。生产源码在这一阶段不变，诊断运行全部终止后才开始下述
独立录屏并发修复，避免混淆两类变更。

有限三轮 `N6jxEP` 12/13、exit1，`a95b4d` 13/13、exit0，`gx2jRn` 12/13、
exit1；失败分别是MCP与Python chooser timeout，Go均通过且未读pointer。
每轮114源身份相符，生产及host/SDK三轮一致；原五次精确激活允许项保留，
零window focus。五入口chooser加目录原始POST为41/43/41，实际文件字节
858/893/858，三host分别正常退出。MCP只有error+server，Python另有缺失
partial caller文件，均只证root/static各2POST、dynamic零POST；缺少具体
序号、click ACK、阶段和失败DOM，不能把推断写成已证投递。已知任务页
清理通过，但失败MCP/Python缺少原tab身份；不将此写成其精确身份验收。

这三轮没有取得Go pointer故障证据，目标完整性保持null、全体业务结果
为false/true/false，失败退出没有被目标成功覆盖。停止该组重复实验，保留
跨调用器的动态输入稳定性问题。后续调查应降低观测时序影响并补MCP/Python
原失败阶段记录，而不是继续逐个新增模式追逐未复现的目标。

并行源码审计发现可达的独立问题：内部截图lease期间，同scope raw stop /
start可以绕过rendering队列，原lease的finally stop随后关闭新外部stream，
留下external记录与原生状态不一致。仅在已有流上直接raw start会被浏览器
拒绝，不能误称该路径可接管。计划先留确定性旧源码失败，再共享start/stop
与内部lease的序列保护；原总deadline、scope/attachment复核、Pause/detach及
迟到ACK必须保留。普通frame ACK不可排进该队列以免死锁；观察超时不能
当作原生命令已结束。该问题不作为Go动态点击故障的已证根因。

旧生产源码的并发回归26项中24通过、2失败，保留原始失败记录；新增修复
让root raw start/stop与内部lease共用队列，frame ACK和其他命令不排队。
队尾跟踪真实native Promise，晚到ACK仅更新仍有效的原scope/attachment；
确认detach后的新附件不继承旧队尾，旧Promise仍保留在全局drains集合。
作者及独立定向107/107、零skip/cancel，覆盖原总deadline、迟到start/stop、
撤权、Pause、新旧附件隔离及targetId归一化。完整浏览器验收尚待本轮执行。

本轮开始将前一目标开发轮归为progress：已产生生产修复与确定性新旧测试
证据；随后用户安装说明已答复。恢复时核对工作树与冻结hash相符，未发现
仍运行的browser-integration进程。下一步以真实浏览器的两个公开SDK连接，
受控延迟实际截图结果交付，检验native命令顺序、真实帧/ACK及nonce像素。
该用例明确是ACK并发压力，不能冒充自然故障频率或动态OOPIF修复证明。

后续动态输入调查已确认两个证据丢失点：wire chooser helper只在成功时
返回detail，cancel错误可能覆盖原异常；Python helper仅在run成功后写文件，
因此超时没有partial且close也可能覆盖原错。下一片应在现有caller登记原
tab/key/variant与每轮arm/click ACK/collect/cancel阶段，失败也输出partial，
原业务和清理错误分开保留。成功请求、参数、顺序及期限不变，不加browser
API；parent仅在原进程/连接关闭后、finalize前复用现有3秒失败观察，并校验
精确身份。newTab/arm失败、业务与cancel同时失败、真实Python子进程退出及
成功调用序列需要覆盖；没有身份必须拒读。暂未实现，不扩增诊断模式追逐
逐次变化的失败调用器。

录屏并发新case已接默认路径，pure8/8、复用像素解码器合跑15/15，全部
Node1416/1416且零skip/cancel。真实新版专项`hmPQNY`2/2、exit0；旧生产
负对照`rjMBXn`1/2、exit1，只有background切回`b05ba42`的旧字节，其余
harness/host/SDK一致。旧native顺序为held13→rawstop15→rawstart18→
release27→delivered28→internalstop29，更新phase1后没有新帧。新版先
结束内部lease再执行外部stop/start，两个更新阶段都收到匹配nonce的PNG。
独立核新专项四PNG共64格RGB，公开帧/ACK、精确tab/target清理和hook恢复。
两专项零激活/window focus/豁免，host均exit0。首次旧对照`QlbMqw`因旧
PowerShell错误流处理未生成总results，只保留partial；完整负对照改为直接
Node子进程，未掩盖原失败。测试后已逐字节恢复新版2ce78674…6edfdd。

恢复后的默认完整`0prwDM`实际**110/110、exit0**，对照`XHmJdq`确认原
109项名称与相对顺序完整；新增case和五入口chooser均通过。178702ms连续
focus账本11次激活/4次focus，沿用原精确允许项，无新增豁免；sentinel的
身份/选中状态保持，视口高度1222→1192，不能宣称几何不变。原host重启
case按预期终止第一代host，第二代正常exit0。这是一次完整通过，不关闭
先前动态OOPIF偶发失败或其他P01–P15缺口；下一步仍补MCP/Python原失败
阶段与partial，以完整证据调查实际输入投递。旧preview包保持不变。

### 调用器失败记录与读取前身份校验

安装说明回应没有推进能力实现；本轮按当前工作树恢复未完成的调用器改动，
核对生产background与host仍为前一轮冻结字节，未重启任何已有活测试。
CLI/MCP保留父级partial，Python失败也向stdout及独占结果文件输出相同JSON；
variant在newTab前、round在arm前登记，记录原点击ACK与collect等阶段，
cancel/close错误不覆盖第一业务异常。成功请求、参数、顺序、期限保持。

父级仅以实际child close作为结束证据，kill请求或exit不能代替close。
CLI/MCP/Python/普通Go的失败读取先检查原caller/session、root→oopif→dynamic
的完整有序前缀、唯一tab和唯一末尾失败项，再复用现有3秒精确documentId
观察；缺partial、stdout/file不符、关闭未知或仅连接清理失败均不读取。
默认HTML、生产动作和输入重试策略保持；观察不证明点击时的文档或投递。

Node1467/1467及独立定向106/106通过，零skip/cancel。新增测试覆盖冻结
原异常、并发catch、真实Python失败输出、成功调用序列以及32类拒绝零读取。
普通专项`ulluP9`13/13、默认完整`1OmROv`110/110，actual exit均0。两次
检查目的分别是受影响调用器和全套上下文，不通过重复成功运行推断偶发
输入已修复。专项独立核174项源码/运行哈希与3caller proof、18轮原阶段
及36个child exit0/close；84份原POST的63份File载荷共1071字节与磁盘一致。
20,048ms连续账本仅原5次精确激活、零window focus，任务清理通过。
两轮成功均未实际触发新增失败读取，P01–P15完整范围继续开放。

完整`1OmROv`独立核110项名称/顺序精确同`0prwDM`，生产/host/SDK同源，
36个caller实际close、18轮阶段和原文件字节相符。193,286ms连续focus仍为
11次原精确激活及4次控制popup focus，未增加豁免；sentinel身份/URL/选中
保持，initial高1222，final active查询高1165、同份populate快照高1204，
保留非原子采样差异，不能宣称几何不变。首代host按测试SIGTERM，次代
exit0；chooser/目录页清理，15研究报告保留且60研究页消失。无活测试进程。

后续方案是在同一固定13项上下文统一复用已有被动pointer记录，而非逐个
新增caller模式追逐故障。精确覆盖submission/JS ready/CLI/MCP/Python/Go
各三key及本次目录key，默认HTML字节不变；成功不新读，不改输入或期限。
需要逐case显式报告覆盖与采集边界，现lifecycle和`/transfers`并发页面没有
同等失败接口，不能默认为全13项pointer完整。缺失/错身份/未知close应保留
incomplete；零事件也不单独证明native未发送。该方案尚未实现或验收，
动态输入、跨平台等完整目标仍开放；旧预览资产保持不变。

### 统一指针上下文：首次取得自然误投证据

上一目标轮为progress：`64dc05b`补齐外部调用器partial并推送，真实普通
13/13和完整110/110保持。本轮复核clean工作树与无活测试进程后，实施
`pointer-all-context`：固定原13项，7项覆盖/6项明确uninstrumented，精确
18chooser key及本次目录3key。复用已有被动记录与失败读取，无新增native
wrapper、成功browser API、输入或deadline。新chooser ledger设为不可枚举，
保留submission原成功Runtime.evaluate参数与结果；失败显式读取仍可见。

独立实际求值对旧HEAD的默认/false24组及旧chooser opt-in6组HTML逐字节
相同。Node首轮1481/1482因旧runner源码断言尚未同步，修后1482/1482，
独立定向143/143，零skip/cancel。汇总校验原caller、唯一失败variant、
实际child close、原native documentId及bounded ledger，采集不能覆盖业务。

第一轮`OBaCi6`即出现Python dynamic首轮collect超时，actual **12/13、exit1**。
click ACK97ms，collect9772ms，cancel1ms；两个SDK关闭后子进程exit1，
实际close4ms后parent作7ms失败读取，尚未进入setter/receipt、该key零POST。
当前root/child原生documentId与后续脚本结果相符，process42/41不同；root
14条有界记录中0–6是Add按钮，7–13为父文档IFRAME#upload-frame上的完整
move/down/up/click。child完整空ledger、click/change空，input连接未禁用，
File0。它缩小投递调查范围，但不证明click时documentId、native请求对应
或具体Viz路由根因。collectionComplete=true而业务/acceptance=false。

独立核成功submission18次原CDP读均无pointerEvidence；82份原POST的61份
File载荷共1036字节匹配，原13序列/生产/host/SDK身份相符。29,089ms连续
focus仅原5次精确允许activation、零window focus；host正常exit0，相关
任务页清理。得到首份自然完整故障后停止该诊断组，不再循环追频率。
随后默认`XXyxbu`13/13、actual exit0，诊断关闭；不能用其通过消除本次失败。
默认回归独立核原13顺序与同源生产/host/SDK；20,215ms账本保留5次精确
允许activation、0window focus。sentinel身份/选择保持但高度1222→1165；
host实际exit0。这轮没有重跑完整110项，最近完整证据仍是`1OmROv`。

下一片优先研究原click首次move之后、按下/抬起尚未发送前的真实child
receipt门禁。目的仍是可靠完成点击，不能止于把静默误投换成报错；若评估
同一deadline内的pre-press可验证移动等待/重试，必须与盲目flush及重放
未知完成的按下/提交严格区分，保留祖先遮挡、scope/attachment/Pause检查。
现有证据未提供公开只读Viz就绪条件，不能把截图帧或原生ACK当作替代。

### 按下前确认目标投递（实施中）

上一目标轮的统一pointer诊断为progress；随后安装说明问答没有修改能力。
本轮核对当前HEAD仍为`e9f02e3`、工作树干净，以自然失败`OBaCi6`为依据
实现普通单击的按下前门禁，不以通过现有回归替代原P01–P15目标。

计划在固定CRX的ElementHandle/utility interceptor中独立保存本attempt的
mousemove receipt；保持root输入路由、原节点/context、原ProgressController
及actionability/祖先命中检查。原移动native ACK和receipt均确认后才提交
唯一down/up。receipt缺失仅允许尚未调用down且move真实结算的准备阶段按
原cadence重新检查及move；这会产生hover副作用，不能称无副作用读取。
按下已提交或完成未知后的任何新增错误必须终止，不能被locator自动重放。

共享NativeInputTracker增加attachment级私有ticket，并随CRX原生命令显式
传递；外来raw Input使ticket失效，既有held/inflight输入不得被认作当前
点击准备。Pause、换attachment、原deadline及context检查在原生发送前最后
一次执行，包括等待持久化/transfer之后。DOM可信事件不含CDP请求ID，故
receipt只能证明此观察窗内原目标收到匹配事件，不能认证同位置真人输入。
变换iframe沿用原root路由和interceptor；原ancestor检查对transform的限制
不能被说成已消除。force/trial/多击/修饰键及raw mouse路径先保留原语义，
不以这片覆盖尚未验证的输入类型。

验证先覆盖实际固定bundle与tracker的确定性边界，再在隔离测试浏览器
丢弃首个move且明确合成ACK，证明重新准备后真实child接收、仅一次点击及
业务POST；该controlled negative不冒充自然Viz根因复现。随后运行原13项
和必要完整回归，保留原focus账本与所有失败。根进程唯一启动浏览器。
旧preview包不可变，实施完成后更新协议、history及质量记录。

### 回执坐标兼容性修正（实施中）

上一开发轮为progress：新增门禁与受控证据，但完整回归`hb2m29`实际
100/111、exit1；11项frame/form点击超时，不能发布候选版本。Node1534/1534、
受控`MGOCLU`2/2和原13项`5MjMV7`13/13不能抵消完整回归失败。禁用当前
门禁的反事实`LORGaK`1/2保留：它在首move被合成ACK后直接提交按钮且有
一次实际POST，失败的是投递确认顺序，不能描述成没有业务副作用。
安装问答已完成；本次继续目标先核实无活测试，再沿既有失败收集新证据。

只在隔离暂存bundle包装原receipt observe/read的`9FyKTv`实际2/5、exit1。
三项失败都收到原BUTTON的trusted mousemove，首次read即invalid；跨源frame
expected(306.28,20.33)而actual(306,19)，同源表单expected(50.663328,147.240813)
而actual(49,146)。原±1坐标谓词足以拒绝这些实际送达的移动，未进入最终
geometry读取。Runtime重新启用产生历史console重播，审计必须按原生时间戳/
source/context/payload去重，不能把重播算成新attempt。诊断不改变输入或状态，
但额外DOM读取与日志会影响时间，不能当普通生产回归。

下一步改为以原node在当前观察窗收到的mouse pointermove及其精确局部命中
证明目标投递；不把上游近似framePoint当作浏览器实际坐标，也不增大固定
容差。保留原root发送点、祖先命中、初末framePoint一致、context/ticket/ACK
以及按钮提交后不重放。该证据仍不认证CDP来源，仍不能预留后续按下的路由。
修正后必须重跑受控丢move、受影响frames/forms、Node及完整111项。

修正已实现：原node只接受trusted/primary/mouse/buttons0的pointermove，
以实际小数坐标作本地命中，并在最终读取同时复核实际点与非null预计点。
注册使用固定bundle实际全局interceptor；原mousemove兼容事件不能覆写
receipt。planned-only overlay的完整click测试改为真正进入原retry后才
结束期限，内存负对照移除final status判定则实际提交按钮，避免用超时
掩盖遗漏检查的假阳性。作者24项、独立原105项与最终Node1544/1544通过。

普通`Zth7Xv`14/14、exit0，未启用receipt诊断。独立核三受控分支：丢首
move后一次真实mouse pointermove及move ACK→down ACK→up；各一次POST，
导航真实换doc并唯一GET。丢全部13个move在5017ms失败且零按钮/POST。
七份表单21原POST/25,760 UTF-8字节、14次frame保存和7次唯一最终提交相符；
33秒连续账本零激活/焦点/豁免，任务页清理与host正常退出。真实fixture
断言已要求pointermove字段及down实际ACK先于up调用。

默认完整`FjHwEx`111/111、actual exit0，原111项未删改，Node最新1544/1544。
完整212,380ms焦点账本保留原11激活/4控制popup focus允许项，无新增豁免；
host原测试重启后新一代exit0。当前无活测试。P01–P15范围不变：此片证明
新的按下前契约及本轮兼容性，不证明精确CDP来源、自然Viz根因或全面可靠性。

完整独立审计核原111名称/顺序、50个生产文件内存重建、实际SDK/host字节
及声明的暂存差异。11/4原焦点允许项逐sequence/ID/时窗匹配；sentinel的
身份、URL和选择保持，宽1251不变，高1222→1196，未声称几何不变。四个
外部chooser调用器共24轮及实际child close通过，成功无failureObservation；
受控gate恢复、原POST与任务清理通过，原pending socket关闭且没有迟到click。
