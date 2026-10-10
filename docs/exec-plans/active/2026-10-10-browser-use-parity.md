# Browser Use parity development

## 目标

完成 `docs/product-specs/browser-use-parity.md` 的全部能力和端到端验收，持续迭代直至
实际 Browser Use 能力与 Codex 不相上下。任何单次修复或 CI 通过都不代表此目标完成。

## 当前基线

- 分支 `codex/browser-use-parity`，已将 upstream v1.0.0 合入现有光标反馈实现。
- 不创建或重开 PR；本地开发提交保留在本项目。
- 当前源码已确认私有 rewrite 未接入正式入口、Windows SDK 通信不兼容、targetId 越过任务归属。

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

## 下一片：用户暂停控制

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
