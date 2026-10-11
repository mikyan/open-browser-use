## [2026-10-10 18:00] | Task: 补齐正式浏览器能力与跨平台通信

### 🤖 Execution Context

- **Agent ID**: `/root` and delegated implementation agents
- **Base Model**: GPT-6 family (Codex)
- **Runtime**: Codex desktop / Windows

### 📥 User Query

> 在 open-browser-use 上持续开发，使实际能力与 Codex Browser Use 不相上下；
> 不做 Pi 专用适配，不提 PR，后台操作不得抢占系统鼠标或当前标签页。

### 🛠 Changes Overview

**Scope:** native host、CLI、跨语言 SDK、MV3 extension、执行计划与能力矩阵。

- 合入 upstream 1.0.0，并保留页内光标、点击与目标反馈。
- Windows IPC 改用当前用户专用 named pipe，Unix 保留 AF_UNIX；多实例发现
  使用 endpoint descriptor，权限/超时错误不再被当作 stale endpoint 删除。
- Python 实现无需额外依赖的 overlapped pipe I/O，覆盖完整请求 deadline、
  分片帧、EOF、通知洪流和超时后显式重连。Node 同步修复连接生命周期。
- 实际 Python→Go host 回归发现并修复迟到响应广播：未知 response id 丢弃，
  只广播无 id notification，不允许旧客户端的结果进入新连接。
- CDP targetId 归一到当前会话拥有且 attach 的 tab，保留合法 OOPIF session，
  拒绝目标冲突、extensionId 和无法证明归属的 target。
- 将真实 Playwright 引擎接入公开 browserAction 协议与 SDK；实施过程及未完成
  验收继续记录在 active execution plan，不以原型测试代替最终任务验收。
- 固定 CRX 0.15.0 / Playwright 1.53.0，构建校验上游 chunk 哈希及 transport
  patch 形状，保留 LICENSE/NOTICE/MODIFICATIONS；不提交生成的 vendor 大文件。
- 实测修复已加载 OOPIF 的 frame 初始化，以及动态跨域 iframe 点击落到父页面
  的 compositor 问题。有限指针动作和截图共用有 deadline 的渲染保持机制，
  内部 screencast 每帧仅 ACK 一次；未切换活动 tab 或重试副作用动作。
- Go 高层 navigation、snapshot、locator 改用真实引擎；新增不可变语义链，
  修复实际 finalize 中 nil slice 编码 null 而非空数组的问题。
- Edge Stable 增加独立 manifest/HKCU registry、profile selector 和本地 ZIP
  no-open setup；未知浏览器在任何写入前失败，不再误注册到 Chrome。
- 持久 control epoch 在副作用前落盘，结束时先围住旧请求、取消引擎等待并清理；
  worker 重启后显式恢复。三个 SDK、CLI、MCP 协商版本且不自动重放旧动作。
- 新增历史导航、刷新、逐键输入、滚动、拖放和指针按下/释放；BFCache 恢复
  重新开启原生 lifecycle 事件以读取 Chrome 真实状态，不伪造 load。
- 拖放前确认目标可见；输入已投递后取消只保证有界释放，不宣称应用状态回滚。
  释放可能触发 pointerup/click，保留原始操作错误，另附 cleanup 错误。
- 上传等待与输入共享 attachment 和拦截准备顺序，保留 OOPIF backendNode 来源；
  下载改为 owned tab 的 CDP GUID，拒绝从全局下载列表猜来源或本地路径。
- Host 只向明确登记对应 session 的连接转发有归属通知，heartbeat 才全局发送；
  加有界订阅表。该路由隔离不把 session ID 当成认证凭据。
- 公开 diagnostics 使用真实 Page 事件，500 条/1 MiB 有界记录，不含 headers/body；
  提供 cursor/dropped，detach、epoch 与 owner 改变清理历史，释放 console 远程句柄。
- Host 每连接独立有界 FIFO writer，避免慢客户端阻塞所有响应；写超时或队列
  溢出关闭对应连接并回收 pending，shutdown 等待 writer 结束。
- 三语言 SDK、CLI/MCP 的操作预算覆盖发现、协商、排队和发送；短 newTab(URL)
  预算耗尽时不创建 tab。复合调用固定同一 turn，raw navigation 检查实际 loaderId，
  不接受上一文档的 readyState，不静默重放动作。
- 开发版增加工具栏全局 Pause/Resume，独立持久 gate 阻断新请求，全部旧 epoch
  失效；恢复需要显式新轮次。暂停不关闭或移动页面，清理失败保持阻断并可重试。
- raw CDP 与 CRX 共享 native input intent、真正原生调用的完成状态及 attachment
  token，避免 RPC 超时后迟到按下未被释放。旧 CRX 清理在异步等待前捕获 target
  身份，不能断开后来建立的连接。
- 拒绝自动控制自身扩展 UI 和已知跨 target 的原始 CDP 隧道；popup 消息校验
  使用真实 action popup 上下文，不假定 Chrome 一定提供 sender documentId。
- 真实边界审计修复两项：dragCancel 后保留尚未释放的鼠标状态；生产 CRX
  先取消 Page 调用上下文，再清理原生输入，不等待可选高亮 UI。所有新 CRX
  命令受暂停门约束，避免日期 fill 等 Runtime 动作在暂停后继续改页面。
- 状态读取与 Pause/Resume 的总预算包含排队及存储；未知存储状态不被默认值
  覆盖，超时后的迟到 Resume 不会重开当前 worker。未确认持久写的崩溃窗口
  与 worker 丢失原生按下记录后的恢复限制明确保留。
- 同步开发构建/本地 host 注册、中英文 README、API 最低版本与 skill 暂停说明；
  发行渠道仍不包含这些本地改动。

### 🧠 Design Intent (Why)

公开 SDK 可调用、真实浏览器可完成任务以及跨平台可通信，是能力成立的必要条件。
命令名字一致、私有重写存在或 Linux 测试通过，都不能证明 Windows 产品可用。
后台测试必须排除测试框架自动 focus emulation 对结果的干扰。

### ✅ Validation and remaining work

- Windows Go transport/host/SDK/CLI 回归与隔离 host smoke 通过。
- Python named-pipe 分片、Unicode、deadline、EOF 与真实 Go host 超时重连通过。
- CDP target isolation 已在真实 Chromium 复现修复前后差异；合法 targetId 和
  OOPIF child session 仍可操作。
- Windows 和 Linux 的完整 CI 通过，包含真实跨语言 Go host 集成；Windows
  99 extension、6 build/script、20 JS SDK、17 Python tests 通过，Go 全包通过。
- MV3 实际运行发现 dynamic import 限制，已改静态 runtime 装配；raw CDP
  attachment 迁移到引擎后可读取语义快照，前台 tab 保持。
- 后续扩展与构建回归 117 项通过；正式 Chromium 156 headed 浏览器两轮各
  17/17 通过（`run-MqJ8aA`、`run-84BPZb`），JS/Python/CLI/MCP 使用真实
  host 与生产引擎。断言包括实际 DOM、可信事件、图片尺寸/变更和活动 tab。
- 两轮 `activeEvents=[]`，图片已人工查看，中文、frame 点击结果、AI 光标、
  点击圈和目标蓝框可见。每次结果记录源码与制品哈希，明确 native messaging
  的测试适配层，不能据此宣称用户 profile 的注册安装已验收。
- 冷浏览器首帧仍约 9.6 秒；默认 timeout 保持 10 秒。Go 同组实际入口、Edge
  安装、turn 恢复和 P01–P15 完整验收继续推进，目标没有标记完成。
- 后续 Go 完整入口两轮加入后各 18/18 通过；Edge 153 的两个独立 profile
  通过真实 native messaging 注册完成点击/输入/快照/截图，第二轮同时检查
  CLI Edge selector 与 profile discovery；仅使用随机临时 HKCU key，结束后删除。
- PR 保持关闭；本次没有发布、推送或新增 PR。
- 2026-10-11 定向 lifecycle 与 worker stop/start 正式链路通过；旧 epoch 被拒绝、
  显式 beginTurn 后原 tab 可恢复。新动作通过真实 native Edge 独立 profile 验收
  `actions-native-iCWyQz`，活动 tab 事件为空，临时注册已清理。
- 后续扩展/引擎/构建回归已达 150 项；新变更完整 CI 与文件/诊断验收继续进行。
- 冷引擎正式并发 chooser/click `run-8yaDZF` 验证 root/OOPIF 的真实 UTF-8
  文件字节与清空；P11 native Edge `diagnostics-native-QGDV1r` 验证错误、
  主页面和跨域请求、分页/溢出/截断，以及外部移组后旧 owner 无法读取。
- 2026-10-11 最终 Windows/Linux 全 CI：167 extension、6 build/script、50 JS SDK
  tests 与 Go 全包通过；Python Windows 28/28、Linux 27 通过且仅跳过 Windows
  路径检查。全部真实跨语言 host 集成运行；Linux 测试临时 socket 路径已缩短。
- 冻结同一版本制品后的完整浏览器验收 `run-EGSton`、`run-rRKgiG` 连续两轮
  各 25/25，均无活动 tab 切换。覆盖五个正式入口、文件/诊断、通知隔离、
  生命周期与 worker 恢复；图片人工检查通过，制品哈希一致。
- 真实 Windows/Linux 慢客户端隔离通过，WSL host/transport `-race` 通过；
  编译依赖使用官方包在仓库临时目录解包，未更改系统软件。
- 本地 checkpoint 仍是开发中版本；用户暂停/站点控制、其他平台、完整任务集
  及同组 Codex 对比仍待完成，不将这轮通过等同于全能力对齐。
- 暂停切片的 Windows 完整 CI 通过；最后仅扩展/构建追加的边界修复经全部
  225 项测试复验通过。Go/SDK 运行代码未在此切片中改变。
- 真实原生 Edge 的暂停日期 fill 定向验收 `pause-late-runtime-CSVCcf` 通过：
  目标在暂停后才出现，值保持空，旧调用因 Page 关闭取消；无活动 tab 切换，
  临时 native registration 已清理。测试控制可选 UI teardown 的调度，不把它
  当作已经投递到网页内部的脚本能被撤销。
- Chromium 的 dragCancel 定向修后验收 `drag-drop-audit-gHI5dd` 确认暂停产生
  可信 pointerup/lostpointercapture，capture 清零；未占用系统鼠标。
- 最终原生 Edge `held-pause-final-9iHGCP` 通过正常暂停及注入释放故障后的
  Failed→Retry pause；原 attachment 释放成功，活动 tab 事件为空，临时注册
  已移除。Running/Paused/Failed/重试成功四种界面已截图人工检查，关键生产
  文件哈希与最终本地构建一致。故障注入明确为测试行为，未注入用户浏览器。
- 暂停切片最终 `run-qjsIiJ`、`run-uTXspB` 连续两轮各 26/26；活动 tab
  事件均为空，正常暂停各 110 ms。生产 extension、host、SDK 与 harness
  哈希一致，最终截图人工检查保留 AI 光标、点击圈和目标边框。测试层修复
  action popup 的窗口尺寸参数问题，以及 worker 重启观察页初始化竞态。

- 生命周期/观察审计后，生产 CRX 禁用隐式 popup Page attachment，所有新 tab
  经 backend 归属和 admission；保留独立 upstream 行为与 OOPIF child 自动发现。
  后台真实 onCreated 回归验证未 claim 不 attach、显式 claim 后 snapshot/read/click
  可用、跨任务拒绝和 turn end 释放。该回归使用扩展创建的后台子标签，不能
  替代 renderer 原生 window.open 的完整生命周期验收。
- 修复离屏 OOPIF 元素 screenshot 卡在 stable 等待：在相同 rendering lease
  内由外到内用真实 PW locator 滚动 owner；每步重新核对归属、取消与剩余
  deadline。原生 Edge `observation-production-6gXof4` 的 OOPIF、nested、导航
  和 owner 替换截图通过，233–297 ms；活动 tab 事件为空、临时注册已清理。
- 本片最终扩展/构建 230/230 测试通过；正式同版本 `run-TMvHso`、
  `run-hlLoF3` 连续两轮各 28/28，通过新增元素截图和后台子标签归属用例。
  活动 tab 事件为空；生产 extension、host、各 SDK 和 fixture 哈希一致，
  26 个本地 ZIP 内容与 unpacked 构建逐文件一致。实际图片的中文、导航后
  内容、光标和目标反馈经人工检查。PNG 尺寸使用实测 DPR，不能混淆 CSS 像素。
- 原生 popup 抢前台仍未解决；独立 popup 移组后首次 click 实测卡在 rendering
  lease 等首帧，初始化已完成却无 screencastFrame，不能声称 popup 全面通过。
  waitForURL 先于触发动作也会堵住同 tab 队列。两阶段 network waiter 仅保存
  设计，未实现。公开 AI refs/boxes、批量结构化读取等继续留在长期目标中。

### 2026-10-11 scoped observation checkpoint

- 用户再次明确不用提 PR；继续只在本地修改和提交。
- JS locator 新增 `ariaSnapshot()`，与 Python/Go 的既有 snapshot 动作对齐；
  元素截图在 attachment 前拒绝 page-only `clip`/`fullPage`，包括显式 false。
  正式浏览器回归同时覆盖根元素与 OOPIF 的 scoped 快照，以及拒绝非法
  截图参数后继续成功截图。
- 扩展/构建 231/231，JS SDK 50 项普通测试通过；缺省跳过的真实 Go host
  测试单独启用后通过。正式 `run-zMs5ju` 28/28、活动 tab 事件为空。
  背景截图中的中文、光标、点击圈与目标框，以及嵌套 frame 导航后内容
  经人工检查。本片未重复声称其他平台浏览器或完整 Linux CI 验证。
- 当前 Codex IAB 合成页面的只读快照展开同源/跨源 iframe，没有 AI ref；
  AX 入口另有数字索引。记录有限基准，不将历史私有 API 当作产品规范。
- AI snapshot 隔离审计实证前插 iframe 后 refs 重复与错路由；稳定 Frame
  slot 的原型通过前插、重排、100 次快照及有限 slot 复用。真实生命周期
  测试验证 turn end 和 ownership 变化取消 pending，公开接口尚未实现。
- Popup 对照实证保留独立窗口可点击并出帧，随后跨窗移组即超时；后台
  测试 popup 保留窗口也能收到可信输入且不切走 sentinel。方案文档提出
  显式 auxiliary ownership，未落生产，原生 popup 创建抢前台仍未解决。
- AI refs、popup ownership 和两阶段网络等待均保持未完成；长期目标继续。
- 本地扩展 ZIP、unpacked 与 skill 包已重建；ZIP 26 个文件逐字节匹配
  unpacked，16 个生产 JS/JSON 文件和 JS SDK runtime 哈希与正式验收一致。
  没有重新加载用户正在使用的扩展，没有推送或创建 PR。

### 2026-10-11 bounded recursive observation checkpoint

- 新增生产 `snapshotAI`，递归原生 ARIA iframe 子树并返回 capture ID、真实
  renderer refs、完整性与统计；总 UTF-8 字节、节点、refs、frames 和深度受限。
  不从页面文本推断允许操作的 ref，不将不完整子树作为成功结果返回。
- 稳定 live Frame slot 修复重排后的引用串页；capture 绑定当前 attachment，
  新/普通快照、frame 生命周期、控制变化使旧引用失效。元素改名保留节点
  身份，删除或替换不把旧引用转给新节点；引用级 ARIA 快照可读一次后过期。
- JS/Python/Go 提供快照与 ref 定位接口，CLI/MCP 复用同一 RPC；非法参数、
  未知/过期引用明确失败，不自动重拍或重放。原生 parser 拒绝普通 selector
  中的 `aria-ref`，包括 nested/composite/frame/drag target，同时保留普通字面量。
- 独立审查发现 iframe 备用文本拼接会破坏 YAML；bounded renderer 使用
  原生集合分支修复，普通 ARIA 行为保持兼容。真实 fixture 用 YAML parser
  验证备用文本和 iframe 子按钮处于正确结构。
- Windows Chromium 156 `run-rC27uZ` 31/31、活动 tab 事件为空。五个公开入口
  各自完成 snapshot/ref 读取和可信点击；root/open shadow/same/OOPIF/nested、
  前插/重排、20 次重复快照、8 次替换循环、过期/限额/取消通过。缺失 root/
  child body 分别约 604/612 ms 失败，控制结束取消 pending capture 约 11 ms。
- 扩展/构建 255/255、JS 55/55、Python 32/32、Go 全包通过；JS/Python
  运行真实 host 集成。本片未重复声称 Linux CI、macOS 或其他浏览器验收。
- nested ref 与普通语义 locator 截图字节相同，实测 DPR 1.5、原生整数裁剪
  得到 360×74 PNG；图片显示完整目标按钮。背景截图的中文、光标、点击圈
  与蓝色目标框经人工检查。最初测试误将 CSS 高度直接乘 DPR，已按原生
  enclosing clip 修正精确断言，没有放宽为尺寸容差。
- 本地扩展与 skill 包已重建：28 个扩展文件逐字节匹配 unpacked，18 个
  生产 JS/JSON、JS/Python 源码、Go caller/host 及 fixtures 与正式验收哈希匹配；
  skill 的 6 文件匹配源码。未重载用户扩展，没有推送或创建 PR。
- P04/P05/P07/P09/P15 矩阵、协议/设计/架构/安全与 skill 文档同步更新；
  Codex 对比仍仅限此前只读观察。Popup 与完整长期目标仍未完成。

### 2026-10-11 network wait checkpoint

- 用户再次明确不提 PR，本片仍只在本地实现。新增 `armNetworkWait`、
  `collectNetworkWait`、`cancelNetworkWait` 和独立 capability；监听完成后
  返回 ready，不占住后续触发动作的 tab 队列。JS/Python/Go handle 固定 arm
  提交时的控制 scope；CLI/MCP 通用 call 使用相同协议，不依赖线程或历史轮询。
- 首次 await 前验证并预留容量，原始 deadline 覆盖 discovery/队列/冷 attach；
  匹配完整 URL/method/status，返回有限元数据。终态保留 30 秒，重复 collect
  不重触发；Pause/end/转交/detach/close/restart 使旧等待失效。单元测试覆盖
  早于 ACK、临界事件时刻、迟到 setup、容量、TTL 和不影响后继 attachment。
- 真实浏览器暴露原生 setTimeout receiver 的 `Illegal invocation`，已修复
  并补回归；测试 host 退出期间晚到通知写入已结束 stdin 的竞态也已修正。
  连接失败 fixture 分别记录可信点击、fetch 次数与 transport attempts，避免
  将浏览器对无响应连接的多次尝试误当成 Agent 重放；正常请求仍断言一次。
- Windows Chromium 156 `run-CbeZgJ` 36/36，活动 tab 事件为空。五个入口均从
  冷 raw attachment arm 后可信点击并读取事件；main/OOPIF、headers-before-body、
  redirect/503、历史拒绝、重复/迟到 collect、16 条终态上限和生命周期通过。
  暂停与 worker restart 增加旧 waiter 失效及恢复后零触发断言。
- 扩展/构建 282/282、JS 61/61、Python 36/36 和 Go 全包通过；SDK 含真实 host
  集成。该片未声称 macOS/Linux 或其他浏览器实测。背景截图中的中文、光标、
  点击圈与目标蓝框已查看。协议/skill/架构/矩阵/质量及发布记录同步；完整
  Codex 能力对齐、popup 与其他平台继续未完成。
- 该网络等待片的交付包：29 个扩展文件、19 个生产文件与当时正式验收匹配；
  skill 6 个文件与源码一致，没有重新加载用户正在使用的浏览器扩展。

### 独立 popup 归属与渲染保留

- 新增 `auxiliary-tab-ownership.js`：同步预留、有界反向锁、trusted-context
  session storage、pending/committed/quarantined 阶段和精确 identity 清理。
  已提交 popup 归属加入统一 list/action/target/transfer/event 检查，显式
  claim 保留原窗口，避免跨窗口移组造成无首帧和首次点击超时。
- End/Pause 释放输入和 attachment，保留已提交 membership；worker 重启
  可恢复，完整浏览器重启需重新 claim。外部移动先隔离归属，清理成功后才
  允许新 owner；handoff 保留，finalize 遗漏只释放归属，deliverable 提前拒绝。
- 审查修复了未验证的普通 claim 预留误拆外部 session 冷 attachment 的竞态；
  回归在原生 attach 成功、owner 尚未发布时触发 end，确认外部连接不受影响。
  16 项 store 与 15 项 backend 专项通过，扩展/构建总计 313/313。
- Windows Chromium 156 正式 `run-hpWHwC` 38/38，含五个公开入口既有回归。
  独立 popup 首次可信点击 98 ms，759×495 截图与实际 viewport/DPR 匹配，
  frame、网络、并发认领、移动/关闭、handoff、Pause 和 worker 恢复通过。
  图片已查看，AI 光标、点击圈和目标蓝框保留。
- 原始 tab activation 保留五次新未聚焦窗口自身 sole-tab 创建记录；原 sentinel
  一直 active。首次严格窗口焦点断言失败，经分阶段 trace 确认是测试主动
  `chrome.action.openPopup` 打开控制 UI 时的 `[sentinelWindowId,-1]`，而非
  页面动作。最终验收用精确事件索引和真实 POPUP context 归因，未清空原始
  日志，其他阶段任何焦点变化仍失败；页面动作没有额外焦点切换。
- Claim 的 10 秒响应上限不取消底层存储写；未决写仍被跟踪，end 可能维持
  closing 等待它落定，Pause 有界失败并保持阻断。原生 popup 创建抢前台、
  用户自行移窗后的渲染、完整浏览器/host 重启及完整能力矩阵仍未解决。
- 文档、skill 与本地扩展包同步；仅本地保存，不推送或创建 PR。
- 本地交付包已重建：30 个扩展文件与 unpacked 逐字节一致，20 个生产文件、
  各 SDK/host/fixture 的哈希匹配正式验收；skill 的 6 个文件匹配源码。保留
  本地提交，无推送或 PR，也没有重载用户正在使用的浏览器扩展。

### 导航观察器与 ready handles

- 保留 pinned Playwright 的 URL/glob、当前状态、生命周期和错误语义；原生
  bridge 只补实际监听就绪与精确 Waiter 取消。待完成 observer 不占动作队列，
  setup 在首次 await 前预留，后续同 scope 点击/CDP/attach 等待其注册完成。
- 新增 arm/collect/cancelNavigationWait、独立 capability 及三种 SDK ready
  handle；CLI/MCP 采用相同协议。固定 scope、原始 deadline、容量和终态 TTL，
  不通过新 turn 复活或自动重放。arm 失败也追踪实际原生清理供 Pause 等待。
- warm setup 超时不拆已有 Page；cold setup 只清理自己创建的连接。复核还
  修复了监听就绪后的点击权限检查未扣预算，防止短 deadline 后迟到输入。
- 扩展/构建 361/361，JS SDK 66/66、Python 39/39 和 Go 全包通过；SDK 包含
  真实 host。Windows Chromium 156 定向 10/10，完整 `run-9ZuGbE` 43/43，
  覆盖冷并发 wait/click、五入口、快速/SPA/中间 URL/redirect、独立加载状态、
  超时隔离、end/Pause/移组/detach/close/worker restart。
- 加载测试曾因旧 goto 不支持 commit，以及计数 fetch 未消费响应体失败。
  通过公开 commit observer 与原生 requestId trace 定位后修正 fixture；
  保留实际 loadingFinished、清理前阶段记录，没有改变原生 idle 或放宽断言。
- 完整套件仍保留五次新未聚焦 popup 的自身 tab 创建记录；sentinel 不变。
  窗口焦点仅由测试主动打开 Pause UI 的两个精确索引归因，其他切换仍失败。
  背景与 popup 图片已查看，AI 光标、蓝框、点击圈保留。
- 协议、skill、设计、架构、矩阵、质量、计划与发布记录同步。仍未解决原生
  popup 初始激活、完整 host/browser 重启、网站策略、其他平台及完整 Codex
  同组任务比较；长期目标继续 active。用户明确不提 PR，仅保留本地成果。
- 本地交付包重建并验证：21 个生产 JS/JSON 与验收一致，31 个扩展文件与
  unpacked 逐字节匹配，6 个 skill 文件及全部 SDK/host/fixture 哈希一致。
  新增 JS 导航模块的生成 JS/声明文件一同版本化，用户扩展未自动重载。

### 主动下载与精确文件路径

- 通过原生 `chrome.downloads.download` 返回 ID 建立有限记录，新增
  `downloadURL`/`cancelDownload` 与三个 SDK 固定控制 scope 的 handle。
  `downloadPath` 等完成后返回该 ID 的路径；同网址/同文件名互不猜配。
  CLI/MCP 通用入口补能力协商与从提交开始的预算，短超时不能变成迟到 GET。
- 活 History 数据库正常只读访问失败，未采用锁绕过或复制活库；网页点击
  的 Page GUID 仍无可靠本地路径。只开放有限 HTTP(S) GET 与单文件名，
  不覆盖文件、不接受危险下载，不增加依赖或任意 host 文件读写入口。
- 实际未结 start/cancel/search 保留到原生操作结束；超时不伪装清理成功。
  修复移组后的 progress 通知泄漏、取消唤醒、原生清理提前退出和第二次
  detach 越过迁移清理而迟到启动下载的竞态，独立复测无 GET 或残留记录。
- 扩展/构建 383 项、JS 74、Python 42 与 Go 全包通过，含真实 host SDK 测试。
  下载专项 8/8，完整 Windows Chromium 156 `run-toIMbt` 47/47；五入口验证
  实际 UTF-8 文件和 SHA-256，同 URL 双任务各自独立，cancel 在 finalize
  之前确认断流，无归属 native 下载拒绝越权后仍能完成，Pause 不重放。
- 首次慢下载夹具仅发送 1 字节，阻塞了原生 MIME 嗅探和 ID 生成。依据
  Chromium 源码与 HTTP 证据改为 4096 字节前缀/1 字节尾部门控；保持原
  超时和产品代码，后续真实测试通过，未把 finally 放行算作取消成功。
- 真实图片已查看；光标、蓝框和点击圈保留。前台原始记录只含已解释的
  popup sole-tab 创建与明确打开 Pause UI，原 sentinel 不变。文档和 skill
  同步，用户不提 PR 的要求持续有效；长期完整能力对齐目标保持 active。

主动下载制品复核通过：22 个生产 JS/JSON、32 个扩展包文件、6 个 skill
文件及 SDK/host/fixture 与正式运行冻结哈希一致；实际文件、取消前已发送
4096 字节且尾部未发送、导航阶段和原始焦点事件均独立核验。报告保存为
`.tmp/download-final-verification.json`。文档骨架、仓库卫生与 Action SHA
检查通过；未重载用户日常扩展，未推送或提 PR。

### 大请求的真实 native messaging

- host→extension 严格执行 1 MiB 物理帧限制，v1 私有协商把最多 64 MiB 的
  完整请求拆成 512 KiB 原始字节片。未协商或超限只拒绝该请求；128 MiB
  大请求发送/排队额度不代表整个 host 内存上限。公开调用保持原样。
- 单 port 有界组装，仅完整 commit 进入原有 RPC；UTF-8/JSON、ID、顺序、
  字节数与双时钟 deadline 均校验，断连丢弃无重放。预算从 host 完整收帧
  开始，不把未返回的 stdout 写入描述成已取消。
- 独立审查复现旧异步 handler 将 `obu:1` 回复写进新 host 同号请求的
  串线，改为原 port reply closure；成功/失败回归与独立重现通过。receiver
  先报错、host 后 timeout 的双响应也修复，后续 ping 只收到自身结果。
- 真正 Windows Edge native port `native-u7vkkz` 现代/legacy 两组通过：
  双客户端分别发送 2,097,173/2,097,174 字节，页面哈希准确、各执行一次；
  旧扩展未协商时 host 明确拒绝且小 ping 仍活。同 PID/endpoint、前台事件
  为空、临时注册清理和所有测试进程退出均验证。
- Chromium 156 完整 `run-xMoFkk` 48/48，适配器也强制 1 MiB 上限；两条
  2,520,000 字节内容用 22 个片，最大帧 699,142 字节。420 项扩展/脚本、
  JS 74、Python 42 和 Go 全包通过。图片保留光标/点击圈/蓝框，原始激活/
  焦点记录保留精确 fixture 归因。只做本地提交/打包，不提 PR、不推送。
- 最终制品核验 23 个生产 JS/JSON、33 个扩展包文件、6 个 skill 文件及
  SDK/host/fixture 冻结哈希一致，两个独立真实输入哈希重新计算通过；
  报告为 `.tmp/native-final-verification.json`。配套本地 host exe 与实测
  二进制字节一致，需要和扩展一起更新；未修改用户日常安装。

### Website access

网站策略片新增真实 popup 独占的 exact-origin all/allow/block 设置，保存
复用完整暂停事务并保持暂停；持久 revision、草稿冲突、失败和未知写状态
均显式处理。完整 live frame 树、导航撤权与 native send/结果证明接入
现有控制生命周期；根 blank、混合 OOPIF、未知 selector 引擎均受限。
受限模式保留 core browser actions，未审计的 raw CDP/数据入口明确拒绝；
这是文档控制，不是网络防火墙，完整能力对齐仍有剩余项。

最终真实浏览器 49/49、扩展/脚本 472 项通过。popup 保存 115 ms 取消旧
等待，允许页可信输入与截图、禁止跳转/claim/混合 frame/redirect、worker
重启持久化和三态 UI 均验收；五个新 popup 自身激活和两次主动打开控制
面板的四条焦点事件保留精确归因。原前台不变。只本地开发、打包和提交，
不提 PR、不推送、不改日常安装。

独立最终核验确认 26 个生产 JS/JSON、10 个静态文件、36 文件扩展包与
实测冻结产物一致；skill 6 文件及 SDK/host/fixture 哈希也相符。权限、
包内敏感数据与原始前台事件扫描均通过。

### Page exports

新增公开 `exportPage` 与三种 SDK 的 PDF/MHTML helper，CLI/MCP 在验证结果后
原子创建新文件且不覆盖。PDF 使用流读取并精确关闭，MHTML 返回原生 UTF-8
快照；统一五字段字节对象、16 MiB 上限及原始总预算。受限网站模式允许经
完整 frame 树检查的 PDF，MHTML 暂不开放。

导出绑定控制 epoch、attachment 与 root/child 文档版本；超时和取消不抹去
真实原生工作，迟到 stream 只关闭。审查修复了异步权限检查后迟到发令、CRX
内部 detach 绕过流清理、辅助窗口变更等待自身清理、超时 admission 提前释放
容量等竞态。512 项扩展/脚本回归通过；真实 Chromium 完整 53/53、专项
8/8，JS 82/82、Python 50/50 和 Go 全包通过。五入口 PDF/MHTML 内容、跨域
frame/资源、大小限制、文件不覆盖及受限 PDF 通过。结束时迟到流测试在
真实原生结果边界作明确故障注入，验证无读取、精确关闭和之后恢复。
原五条 auxiliary 激活与四条控制 popup 焦点事件精确归因，导出无新增。

外部 debugger detach 丢失旧 stream 的关闭能力仍明确保留 cleanup-failed，
worker 重启不能充当关闭证明。MHTML 结果上限不代表浏览器内存上限，PDF
中文视觉正确也不代表任意字体逐码点文本提取保真。只本地开发与提交，无 PR。

独立最终核验 `.tmp/export-final-verification.json` 确认 27 个生产 JS/JSON、
37 个扩展 ZIP 成员、6 个 skill 成员和 host/SDK/fixture 与实测冻结版本一致；
产物内容、原始前台事件和包内卫生再次检查通过。测试进程已退出，日常安装
未改动。

### Clipboard

四个既有 RPC 保留，新增统一有限的文本/HTML/PNG 契约、三 SDK facade 和
CLI/MCP 文件入口。原生 API 移入打包 offscreen 文档；唯一 live context、
精确无 tab 原生 target 与 nonce 联合验证私有 Port，页面不能截获正文。
prepare/commit 分离，原始 deadline、归属、文档与 attachment 检查贯穿；
超时仍追踪实际结算，取消不回滚或重放写入。启动 marker 读取失败和未知
原生状态保持阻断，显式 Retry Pause 才重新确认并清理。

修复实际 Port 不带 documentId、原生 createImageBitmap 接收者错误、
Go 转义膨胀超过传输上限、JS 对非法 UTF-8 静默替换，以及恢复 pending
未纳入暂停等待等问题。591 项扩展/脚本、JS 90、Python 59、Go SDK 52
及 Go 全包通过。固定 Chromium Headless 内存剪贴板专项 8/8，五入口实际
三 MIME 内容、独立 PNG 像素、空列表 no-op、无效写入不改变内容、文件
不覆盖、任务结束等待清理与真实 worker 重启不重放均通过。仅使用合成
内容，未读取或修改日常系统剪贴板；这不构成 headed OS 剪贴板验收。

独立核验源码/SDK/host/fixture 哈希与五份产物；41 文件扩展包逐字节匹配，
不含测试 hook。完整 headed 本轮 29/53：主窗口多项动作卡在原生
screencast 首帧之前，独立最小扩展也复现，额外无 clip 截图没有恢复。
改动前 background/manifest 的三个关键场景对照同样失败，其他既有生产
输入哈希相同，不能把该现象归因于本次剪贴板接线。
没有将重试、额外截图或前台切换当作修复；该渲染问题保留为 P09 缺口。
成功截图仍显示 AI 光标、蓝框与点击圈。所有测试进程按各运行清理，
开发包只保存在本地，不推送、不提 PR、不修改日常浏览器安装。

### Headed startup diagnosis

继续使用最小原生扩展对照启动窗口和后续窗口，保留全部失败。普通启动
窗口首帧超时后的第二个未聚焦 normal window 曾成功取得帧、ACK、可信
点击与 PNG；无窗口启动后的首 normal、popup 后的第二 normal，以及
HTTP app 后的第二 normal 均仍超时。HTTP app 原窗口自身成功仅说明该
活动合成页面可绘制，不是后台 tab 验收。所有探针仅使用隔离 profile，
其浏览器进程均已关闭。

源码核对表明 `windowsHide` 会影响 Win32 startup show state，但 Chromium
另有后续 ShowWindow 路径，不能据此推断永久隐藏。DOM 可见、rAF 正常和
startScreencast 成功也不能证明首个原生 capture frame 已存在；窗口未
最小化及 foreground HWND 为空不足以断定锁屏。没有把任一启动变体写入
生产修复，也没有重放用户动作或放大预算。

把最小原生探针沉淀为正式脚本，并修正 start+ACK 共用预算。新增常驻测试
观察页，消除旧验收在 worker 重启期间拼接日志的遗漏/重复窗口；仅允许
创建时实际记录的精确事件，最终快照再次验证，失败也保留最后有效历史。
旧日志不能独自证明重启区间连续无事件。观察页仅加入 staged 测试扩展，
生产插件和现有安装包不含该 hook。

15 项 Node-only 回归通过并纳入 CI；固定 Headless 内存环境 4 项通过，
涵盖同一 observer 下三次真实 worker 重启，两条辅助窗口初始 activation、
零 focus。有界面三项关键场景仍全部首帧失败；正式最小探针同样保留启动
窗口失败及第二窗口真实点击/PNG 成功，不冒充渲染修复或完整对齐。所有
本轮测试浏览器与 host 已清理。

同时记录媒体导出的后续实现方案：精确 locator 的隔离环境来源读取、
原始预算和容量、现有下载 ID 的复用及真实清理。HTTP(S) 图片来源快照
无法和跨进程 GET 原子化，blob/Canvas/video/audio 等继续作为独立验收
范围；本轮未宣称媒体已实现或完整能力已对齐。

### Media downloads：HTTP(S) 图片首片

正式 `downloadMedia` RPC 和三 SDK locator helper 已接入；CLI/MCP 使用同一
generic call。独立版本协商、单 RPC 固定 scope 与原始 deadline 贯穿来源
定位和原生下载。固定 runtime 在 utility world 读取精确图片的 currentSrc，
绕过页面 getter 补丁；不猜测 src、不触发点击、不接受调用者 URL。下载
继续使用 Chrome 返回的精确 ID，真实 source/handle 清理不能被超时替代。

阶段 Headless 验收 `run-yzlAP6` 6/6，包括 mandatory raw-navigation 与五个
公开入口。root、语义、shadow、同源/OOPIF/嵌套 frame 的选源和十份实际
PNG 像素通过独立核验，源码及输入哈希一致，同一 observer 零激活/焦点。
保留完整请求记录，cross 来源没有 cookie，其他 JS 来源携带合成 HttpOnly
cookie；这不证明浏览器第三方设置，也不承诺分区认证等价。此前错误地
要求所有来源带 cookie 的过程轮保留为 5/6 失败。JS 93、Python 63 和 Go
全包阶段测试通过。

最终修复以原生 context 生命周期确认已销毁来源对象，保留对仍存活对象的
精确 release。最终本地完整 `scripts/ci.sh` 通过：扩展/脚本 663/663、
JS 93、Python 63、Go 全包及其余 workspace 检查。Windows 的 npm shell
仅在测试进程切到 Git Bash，默认 cmd 执行 `.sh` 的过程失败保留。
固定 Headless `run-FDmPto` 9/9，同源码
headed `run-XLWzut` 8/9，仅 mandatory raw-navigation 仍失败，八项媒体均
通过。每轮十七份 PNG 和十七次下载 GET、五类 ref 路由、双 session ID/路径
隔离、节点/来源变化及结束/导航清理均核验，冻结输入哈希一致，连续 observer
零激活/焦点。生命周期测试明确暂缓已结算 native capture 的结果交付，验证
迟到对象精确释放或原生 context 销毁，未将注入称为普通浏览器时延。过程轮
6/9 失败原样保留，修正 fixture 干扰后独立重跑。

首片未涵盖 video/audio、blob/data、Canvas 或已呈现字节
导出；重新 GET 不是 DOM 与网络的原子事务。独立 P09 trace 已证明启动
窗口 child surface 激活但 copy request 未完成，secondary 有真实 copy/帧；
没有据此修复生产渲染，Headless 媒体成功不替代 headed 完整回归。仅本地
开发，无 PR、推送或日常安装变更。

最终本地扩展包 43 个成员通过 ZIP CRC 和解压目录逐字节核验；原生代码
哈希与两轮浏览器实测一致。除明确声明的 staged background/manifest 外，
其余生产文件与两轮冻结副本一致，包内没有测试 hook。CI 产生的平台 PNG
压缩差异已还原后重新打包，不涉及生产逻辑变更。

### P09：启动追踪与测试实验配置

为首帧问题增加可复跑的启动前 Perfetto 追踪、原生流保留与关闭、Windows
只读 HWND 快照；修正请求 `streamFormat` 与返回 `traceFormat` 混淆，并用
真实 native event 形状覆盖回归。最终 metadata 失败也不会跳过 trace 收尾。
原配置 root Surface 等待依赖、UI scheduler pending frame 和页面已绘制的
证据被区分保存，首窗口失败仍保留。

通过 trace study/group hash 与固定 Chromium testing config 对照，定位到
包含 100 秒 renderer 延迟的 toolbar 实验组。单 feature 命令行覆盖实际会
跳过整组，因此没有将该对照错误解释为单 feature 修复。验收 launcher
现在显式采用同版本 Playwright 的 `--disable-field-trial-config` 测试基线，
提供 `browser-default` 复现旧配置，保留参数和二进制 hash。只改变测试
环境，不修改生产插件、用户设置、窗口/标签选择或严格焦点检查。

原生对照 `rendering-b4WKbw` 两窗口均完成帧/ACK、可信点击及 PNG，定向
公开链路 `run-Uq8Fkj` 3/3，完整受控基线 headed `run-NJ72u2` **61/61**，
涵盖全部八项媒体及五调用入口。五次辅助窗口初始激活与两次控制面板的
四条 focus 事件有精确归因；连续 observer 最终校验通过，不能将其写成
整个测试期间零事件。测试脚本 **30/30**、文档和仓库卫生检查通过；此次
没有生产改动，不重复完整产品 CI。完整能力目标继续有效，无 PR 或推送。
详细证据与兼容性边界见启动 reference。

### P13：移组撤权与 native host 断线恢复

修复普通 task tab 移组/移窗时旧 debugger 与 held input 未回收、native
Port 断线后已接纳操作仍可能继续的问题。旧 attachment 和 engine generation
在异步清理前撤权，原生输入与资源释放仍保留实际完成屏障；断线使用独立
恢复 gate 和持久 epoch 失效，不改变用户 Pause 状态，不重放原动作。新连接
显式开始新轮次后恢复同一浏览器内的任务 tab。

新增真实 fixture 覆盖 ungroup、转入另一任务组、跨 normal window 移动及
实际 host 进程终止/替换。浏览器、worker、profile 和连续焦点 observer
保持不变；每代 host 独立解析 native 流，真实旧 PID 退出后才触发适配 Port
关闭，丢弃迟到消息。检查真实 locator 等待先于撤权、可信 pointerup/keyup、
原 debugger 释放、迟到目标零点击和显式恢复。测试仍通过声明过的 loopback
Port adapter，不称为原生注册 launcher 或完整浏览器重启验收。

完整 browser lifetime 的数字 ID 恢复另列缺口：task group、deliverable、
active tab、Pause 待清理列表需要共同设计。媒体扩展与其他浏览器安装继续
保留范围。只进行本地开发，不提 PR、不推送。

首次完整 headed `run-ssmjWr` 保留 **12/63** 失败：network lifecycle 正常
关闭 tab 时，迟到的 CRX detach “No tab” 错误被误判为清理失败并触发全局
Pause，导致后续用例全部被拒绝。增加仅 staged 构建的同步原错误观察后，
`run-4NEQV8` **1/2** 精确复现。生产现在凭原 attachment 的 `onRemoved` /
`target_closed` 事件确认销毁，不按错误文本吞异常；未知失败仍阻止自动化。
修后定向 `run-T5lvEC` **4/4**，覆盖原失败与新撤权/实际 host 重启场景。

独立回归继续捕获在 native input release 已经 pending 时关闭原 tab 的
同类晚拒绝；修复原 token 的成功/失败两条结算路径，并在每次私有输入
清理发送前检查销亡或换代。22 项新增 P13 回归、engine generation 回归
及六项 host bridge 回归均通过。最终完整 CI 为扩展/脚本 **706**、JS
**93**、Python **63**、Go 全包和 workspace 检查。最终 headed
`run-PeM3FT` **63/63**，源码/SDK/host/harness hash 与实际冻结副本一致。
三个 tab 撤权和 host 断线分别在 123/122/248/118ms 取消旧动作；每个场景
可信输入释放、迟到目标零点击、原 debugger detached、显式恢复有独立核验。
连续 observer 只包含五个 popup 与一个 normal 测试窗口首 tab 激活、两次
主动打开控制面板的四条 focus 事件；没有额外前台事件。完整浏览器重启
与原生 launcher 崩溃恢复仍不在这些证据覆盖内。

### P13：浏览器 incarnation 与持久输入风险

本轮将 task group、active tab、tab origins、按窗口记录的 deliverable group
及 auxiliary 归属绑定到 `storage.session` incarnation。旧 schema 或 marker
换代先撤归属，保留任务名称与 epoch counter，active/idle 旧 epoch 都失效；
不向同号新页面发送旧清理，不按同名组吸纳用户页面。worker 同 marker
恢复和浏览器/扩展换代因此分开处理。

共享 raw/CRX tracker 在 native Input 前持久登记 opaque risk，实际无 held
input 且 native 工作结算后才能清除；写失败和未知恢复保持阻断。新增回归
覆盖写入等待期间 Pause、turn end、移组、raw timeout、site proof 变化及
attachment 正在释放，防止迟到存储成功后继续发旧输入。风险日志不存键值、
坐标或页面内容，真实未决写入仍参与 teardown。

否定了“session storage 缺失或 target/tab inventory 缺席就代表释放”的
设计。晚首次 startup 也可能发生在同一浏览器的 extension reload 之后，
因此旧风险第一次只获得 witness；符合条件的不同 incarnation 旧 witness
才由后续真实 profile startup 清理。持久 intent→journal→consumed 顺序
使同 witness 的 worker 重放不能误清，当前 incarnation 不被清除，用户
Pause 不自动 Resume。方案依赖 pinned 原生事件语义，并有确定性回归；
详细契约见 [browser lifetime](../../references/browser-lifetime.md)。

本轮初版 focused **110/110**，当时完整 CI 通过扩展 **660**、脚本 **43**、浏览器
脚手架 **42**（共 **745**）、JS **93**、Python **63** 和 Go 全包。主 headed
`run-fLR1kz` **63/63** 与独立源码/制品 hash、连续焦点审计通过；六条首
标签激活与两次控制面板打开的四条 focus 事件精确归因，sentinel 保持。

完整 browser restart 专项的过程失败：`browser-restart-ucmbPs` **0/4** 在恢复偏好
重启后消失处失败，`browser-restart-yH1Qzu` **0/4** 在 inactive restored 页未加载
时提前 scripting 失败。第三轮 `browser-restart-kTnp4S` **1/4** 的未暂停
重启通过；暂停场景任务页已加载、交付页持续 lazy/unloaded，严格两页
DOM 等待超时，后二项受前置失败影响。第四轮 `browser-restart-kmDdeo`
**2/4** 验证未暂停/已暂停的真实重启，保留任务页 DOM/no-replay 并对 lazy
交付页检查 URL/window/group；同浏览器 session 状态丢失后 claim 的首次
fill 被本扩展遗留 debugger attachment 拒绝，worker-input 恢复也未通过。
失败保留，不通过激活或强制重载标签绕过。随后浏览器脚手架先 **45/45**、最新 **48/48** 通过，
与此前完整 CI **745** 分别记录。当时主套件通过不证明四个新场景、原生
launcher 或全部 reload/update 恢复已通过；最终结果见下文。整体目标继续 active，无 PR、无推送。

第四轮确定生产缺口后，新增显式 claim 的 cold orphan 恢复。只读
`Target.getTargetInfo` 成功证明是本扩展 native client，按返回的 opaque
`targetId` detach；Chrome 的 client lookup 同时匹配 extension ID 和
DevTools target，不能用全局 attached 标志夺取其他调试器。当前已跟踪的
Page/attachment 跳过，未知 input journal 先阻断；真实 detach Promise
纳入控制释放，原 scope 取消仍拒绝 claim。已成功的 detach 与随后取消
分开结算，不误报 Pause 清理失败。

独立审查补获已 committed auxiliary 重复 claim 超时后迟到 detach：每次
调用现捕获原 deadline 和取消状态，保留既有 owner，但禁止迟到探测触发
新的 detach/group。新增九项回归后 focused **119/119**。移除 lifetime
中已无消费者的 onInstalled/ambiguity/changed/recovery callback 遗留，避免
误导 startup 安全模型。最后这批生产修复重新执行了完整 CI、63 项主套件
和四项重启验收，未沿用先前通过结果代替新源码验证。

最终新源码重启专项 `browser-restart-ShnPfH` **4/4**、exit 0：同一合成
profile 三个真实浏览器进程先后退出/启动，未暂停及已暂停两次重启都
验证旧 active/idle epoch 拒绝、无隐式 tab 归属、任务 DOM 与未操作交付页
metadata 保持，显式 claim 后可信输入成功且旧动作不重放。同浏览器内
session storage 清空加真实 worker 替换也通过，原生 orphan 在显式领取时
精确清理；这不是实际 extension reload 的证据。

held pointer/Shift 期间替换 worker 后，原文档 input 仍保持，真实 popup
显示 Failed，操作继续被拒绝。原 tab 的真实 onRemoved 才清除已丢失的
输入风险；同一 popup document 完成 Retry pause、Resume，新 turn/new tab
显式恢复，旧 epoch 继续拒绝。未把空 tracker、session 丢失或目标清单
缺席当作释放证明。三个进程分别保存 observer，activation 皆空，focus
分别 0/2/6 条，全部为测试主动打开 popup；重启空档明确不连续覆盖。

前四轮 **0/4、0/4、1/4、2/4** 原结果保留。该通过不覆盖未知输入通过
startup witness 的跨浏览器清理、真实 extension reload/update、原生 host
launcher 或更多浏览器。最后源码完整 CI-final exit 0：扩展 **669**、
脚本 **43**、浏览器脚手架 **48**（共 **760**），JS **93**、Python **63**、
Go 全包及其余检查通过。四场景行为也已独立复核，三段零 activation、
八条 focus 均对应四次明确 popup 打开，同一 popup 的 Failed/Paused/Running
截图已查看。最终主 headed `run-hlPRVD` **63/63**、exit 0，连续 observer
只有六条窗口首 tab 激活、两次明确打开控制面板的四条 focus；无额外前台
事件。重启四场景与重包 ZIP 审计确认源码匹配，ZIP **1,237,392 bytes**、
**44 files / 49 entries**，SHA-256
`01f6e2cafdf4efa032fea6b8222a2883adfdcb3e89b647cd9150715bb32718a1`。本片完成，完整 P13
及 P01–P15 仍有既定缺口，整体 parity 目标 active，无 PR、无推送。

### P10 有限媒体文件与 P11 历史诊断隔离

`downloadMedia` 沿用 version 1 和五种公开入口，增加精确 video/audio 的
HTTP(S) currentSrc 新 GET，以及 data、原 frame 同 origin Blob、Canvas
PNG 的有界字节下载。嵌入内容最多 8 MiB，Canvas 最多 16,777,216 像素，
未完成来源工作预留总计 64 MiB；不新增任意 HTTP utility fetch。
原生 data URL sink 复用精确下载 ID，不增加隐藏下载锚点或 offscreen 文档。
MSE/live/srcObject/DRM、失效或跨 origin Blob、污染 Canvas 与超限明确失败。

取消保留真实 renderer fetch/reader/Canvas 结算与原 attachment/context 的
句柄释放；reader 先 cancel 再 abort，并等待真实 Promise，避免把正常
AbortError 误报为清理失败。双重 cancel/dispose 失败后，显式重试先重做
精确 source cleanup，再确认下载取消，容量不因历史错误永久泄漏。
新增实际媒体文件、五入口、跨 frame/shadow、8 MiB 边界、分区隔离和
四种真实读取待决取消验收。原生 Port 的只读 observer 在 end ACK 前取证，
避免用事后快照宣称清理早已完成；所有观察钩子只存在于测试 staging。

首轮完整 CI **795** 项通过（扩展 697、脚本 46、脚手架 52），JS 93、
Python 63、Go 全包通过；媒体专项 `run-L7XsRk` **16/16**。随后完整
`run-WMOIim` **69/70**，新增媒体均通过，旧 diagnostics 用例失败：
Runtime.enable 重放的历史 console 有时晚于新 collector 注册到达。
该失败保留；旧生产代码定向小样本两次 2/2 并不能否定或确定性复现竞态。
新验收保留真实原生 timestamp/重放、新 root/OOPIF console/pageerror 与
新 owner 消息，同时用固定原 CRX handler 测试控制晚到旧事件的顺序。
最终修复为每个新 CRPage 在 Runtime.enable 前建立 epoch-ms 时间边界，
覆盖 root/OOPIF/worker 的 console、exception 与 Log，原始 CDP 通知不改。
旧事件的对象通过原 session 清理，异步权限等待后再核 attachment 身份；
失败保留原 CRSession 日志，不宣称释放成功。该方案依赖系统钟稳定，
时钟跳变仍是 P11 已知边界，不把时间戳当作原生 replay 标记。

新生产定向 `run-iJIwsa` **2/2**；最终完整 headed `run-XnREpF` **70/70**。
最后全仓 CI **807**（703 扩展、52 脚本、52 脚手架），JS 93、Python 63、
Go 全包及其他 workspace 检查通过。独立审计检查 36 媒体文件的实际字节、
PNG 像素/WAV/VP8、两个 8 MiB 边界、12 负例、四种取消/end ACK 顺序。
新 Page 原生重放 526 条旧 console、新 owner 重放 prior-owner 的原始
时间戳均与旧递送匹配；新 capture 保留当前 root/OOPIF 的四条 console/error，
后继 owner 只保留自身两条。六条创建首 tab 激活、两次明确 popup 打开的
四条 focus 均精确归因，sentinel 不变；真实 host 两代均退出。
只本地开发，无 PR、无推送；完整能力对齐目标保持 active。

最终有限媒体制品已独立核验：ZIP **1,245,340 bytes**、**45 files / 50 entries**，
SHA-256 `f4d720f839a0198ae3c5ccfd97c70930368af0e78eb0d9a8b400f7e3fb634e66`。
每个成员与最终 unpacked 及 `run-XnREpF` 验收静态产物一致，原生 Port
adapter 改写的 background/manifest 单独按生产 hash 核对；没有测试钩子或
私有路径。Host 沿用已验证二进制，hash 与实际运行一致，不宣称重新构建。

### 组合定位与同组表单任务

补齐正式 engine 与 JS/Python/Go SDK 的 `filter(has/hasNot/visible)`、
`and/or`；每链 32 步、整棵动作树 128 步、嵌套深度 8。组合输入在异步等待前
深复制，要求同 client/tab 与匹配的 frame 前缀；递归 parser 继续约束 refs、
隐藏 enter-frame、网站策略与媒体来源。混合 selectOption 逐项转换，保留
字符串 value-or-label 与多字段 descriptor 的联合约束，避免首项决定整数组
转换类型造成错误。公共协议不开放 runtime 私有字段。

新增三个布局变体的共享本地表单，涵盖同名分组、隐藏/停用项、动态提交、
中文/emoji、勾选幂等、Shadow DOM 与同源/跨源 frame。五入口通过真实服务端
保存/提交和准确收据判断完成。测试进程改用 UTF-8 流式解码并等待 close，
真实分块输出/尾部 drain 回归避免中文错误被误判为产品失败。

当前 Codex Edge 扩展实际完成相同三个布局：最终任务 3/3、共享收据检查
3/3，但标签字符串/混合多选和跨源组合需要替代调用，跨源确认由可信 Enter
完成；额外严格指针检查为 0/3。姓名填入后一次 detached 返回经 DOM 核实已
生效，未重放。早期 exact-label 测试脚本问题与零提交失败单独保留。独立
ledger 审计不把最终成功说成每个操作相同，也不推断 Codex OS 焦点或速度。
本项目表单专项 `run-j4jsMy` 8/8；全仓 CI 824（710+53+61）、JS 98、Python 67、
Go 全包及其他 workspace 检查通过。完整矩阵继续，不提 PR、不推送。

最终完整 headed `run-6SwxDM` **77/77**，保留旧 70 项与新增七项表单。
原生 host 两代实际退出，连续焦点记录与已知 popup 例外由独立审计核对。
这完成本轮组合定位/表单分片，未关闭 content-return、原生 popup、更多
恢复/平台和研究/多 tab 同组任务缺口；长期目标保持 active。

独立审计核对七任务各三次准确 POST、五张实际收据 PNG、CLI/MCP 各28次
正式调用，以及旧媒体/取消/诊断证据。六次创建激活与四条主动 popup focus
精确归因、sentinel 不变。最终 ZIP **1,246,279 bytes / 45 files**，SHA-256
`baa12d3e3627305565110172dcd4f0e432e05ad17102aa7311bacc5c99d27dfd`。
每成员与 unpacked/实测静态产物一致、无测试钩子；SDK新增源码和dist均已
追踪，内存重新编译结果一致。Host沿用原已验证二进制，不宣称新构建。

### P13：真实扩展重载、启动见证恢复与用户指导

从 `04a3ecc` 继续本地开发，无PR、无推送。生产新增只读 inputRecovery
状态，区分同session原页关闭、跨session完整退出重开，以及未见证风险可能
需额外一次重启；风险退役后立即撤下重启指导。保留风险退役算法、暂停和
显式Resume门禁，未自动关页/重启/恢复旧动作。

生命周期runner扩大为8项；独立companion拥有常驻focus observer，真实
runtime.reload只调用一次，核对旧worker销亡、新context/Port/session及
同browser/install身份。运行中旧pending动作在deadline内看到迟到目标但
不执行；暂停与原task/output数据保留，必须显式新turn和claim。

最终 `browser-restart-w5chI9` **8/8**、六代真实浏览器：无witness风险首次
真实startup只stamp、第二次退役；有witness风险一次退役，原页关闭仍不能
清跨代journal。均在显式Resume/newturn后才完成可信动作。独立审计确认
0 tab激活、22条focus全部来自11次主动popup，五段进程重启空档不拼接；
20张PNG校验且三张关键恢复图已查看，源码/SDK/host hash与退出证据一致。

本轮失败 `9gmJt7` 4/8、`j31iqu` 5/8、`TIhZUP` 6/8、`bbnMFd` setup失败和
`XJtixZ` 0/8均保留。最终测试安装采用初代CDP引导、普通扩展管理器reload
转换持久安装，等待真实install/update dispatch及新连接；之后不重新安装。
实际profile记录两扩展location4/creation_flags38，不含CDP-only位。原生
launcher/EOF、签名更新、禁启/崩溃与更多平台仍未由Port adapter覆盖。

CI通过839项（719+53+67）、JS98、Python67与Go全包；最终主headed
`run-FPduQP` **77/77**，包括五入口完整表单、媒体与诊断等既有功能。
完整能力矩阵与长期目标保持active。

最终交付独立审计 `.tmp/reload-delivery-audit.json` 通过。ZIP
**1,246,792 bytes / 45 files**，SHA-256
`c6fc5dd9cd9a5711704b97ad607ce0feb62f650bd211124bef31351b2ea047d4`。
全部成员匹配 unpacked、生命周期验收生产 hash，以及主验收的 34 个
JS/JSON hash 和其余 staged 静态文件。无测试钩子或机器私有路径，保留
vendor MODIFICATIONS；主验收六次创建激活、四条主动 popup focus 均精确
归因，两个测试 profile 无进程残留。Host 沿用 SHA-256
`d946f5b64301084094db3bfd85e36af1dbfb513123938fc53ba76eef004be3a5`
的已验证版本；用户主浏览器的已安装扩展未替换。仅提交本地，不推送或提 PR。

### P02/P13：原生 launcher 与重连调度

修复 NativeTransport 断线后每次 heartbeat 重建同名 alarm 的饥饿问题。
仅保留一个 pending retry；存活 worker 使用 best-effort 5 秒 timer，浏览器
保留 30 秒周期 alarm 作为唤醒后备。串行写入 alarm，避免旧连接的迟到 clear
删除新断线的后备。原 Port 身份隔离、同步恢复门禁与禁止请求重放保持有效。
新增七项确定性调度/竞态回归，包含 packed 最小间隔及 timer 丢失；这不等于
真实 packed 扩展唤醒时序验收。

新增 Windows native-lifecycle runner，由浏览器真实 connectNative 启动 Go
host，无 Port adapter。唯一临时注册、独立 profile 和子进程环境隔离；终止
前验证 host 路径、创建时间与浏览器祖先并保留精确进程句柄。实际 reload
要求旧 host EOF exit 0、旧 pipe 不可达和 descriptor 清理，暂停经真实 popup
保持及显式恢复。迟到目标在原 deadline 内出现，持续观察至 deadline 后
250ms，检查原文档、可信事件与 HTTP witness。独立 companion 跨 reload
连续记录焦点，异常不增加豁免；收尾仅删除身份一致的本轮随机注册叶子。

完整 CI 通过 849 项 Node（726 扩展、53 脚本、70 脚手架）、JS98、Python67
及 Go 全包；补充真实子进程 UTF-8/退出和隔离清单测试后，脚手架 73/73。完整主 headed
`run-aZyBs1` 77/77，独立原始证据、源码与焦点审计通过。初次 CI 的 Windows
shell 配置失败、主验收缺三份 Go caller 的 73/76 均保留；配置补齐后才通过。
本次实际 host 为新构建，SHA-256
`ed88871254f833a502b57107167419f04659526e60dd19fa25ba1c3d5a479332`。

最终 Chrome 156 `native-lifecycle-dnAdTC` **3/3**，与最终隔离脚本一致；
此前 `wG1S3Q` 和强化 deadline 的 `ZC9V9W` 各 3/3 作为历史证据保留。
Edge 153 三次 setup 失败促成真实可见开关及 UI/native 双重核验；之后
`nBszxt` 的 host 恢复通过，但在 reload 前出现焦点异常，且发现临时 profile
同步了无关扩展。两浏览器统一禁 sync/background-networking 并用后台设置页
持续核对 API 暴露的完整扩展清单，只留测试扩展与明确 COMPONENT。
最终 Edge `R7MPzo` 清单隔离通过，但 host 恢复过程仍有未解释的本窗口
focus，整个场景失败、两项 reload 未执行。收尾进程及注册清理通过。
不把前次同步干扰当成本次原因，不放宽焦点规则；Edge 验收仍是明确缺口。
全部过程与范围见 browser-integration README。签名更新、packed alarm 实测、
其他 OS、更多恢复顺序和整体同组任务继续待补，长期目标保持 active。

交付 ZIP 独立审计通过：1,247,131 bytes / 45 files，SHA-256
`ba929b2d2df9183e7c792555eba967e12bf51fa52925d568c98eef8189ff3662`。
逐文件匹配 unpacked、主回归与原生验收生产 hash；未含测试钩子、公钥替换、
随机 host 名或私有路径。用户主浏览器安装未改变，仅本地开发及提交，无 PR/推送。

### Edge 原生启动：无操作空闲对照

新增显式 `OBU_TEST_NATIVE_MODE=idle-diagnostic`，默认仍是三场景 acceptance。
复用完全相同的安装、隔离清单和独立 observer，固定观察至少十秒；不发 SDK
动作、不终止 host、不 reload。焦点违规不截断采集，结构损坏或读取失败仍
导致诊断不完整。末尾验证原 host 的 PID、创建时间、pipe、路径、祖先和
连接；清理仍检查所有测试进程及唯一注册。`diagnostic.complete` 与验收
`passed` 分开，诊断模式始终 passed:false；退出 0 只表示完整采集与清理。

Edge `native-lifecycle-XlNQ9o` 采集 10,002ms / 11 样本，唯一 focus 与气泡
日志相差 1ms；Chrome `native-lifecycle-K2qRSM` 采集 10,015ms / 11 样本，
没有激活或焦点事件。两者观测期间原 host 不变、case/witness 为空、清单
始终隔离且收尾成功。它们证明焦点现象无需恢复动作也会发生；未直接检查
气泡 UI，仍不能宣称因果或修好 Edge。没有延长验收启动等待、禁用通知或
放宽焦点规则；上轮 Edge 失败继续保留。

最终脚手架 Node-only 75/75，新结果语义的默认 Chrome 三场景回归
`native-lifecycle-0B1hfL` 3/3。生产代码和交付 ZIP 未改变；完整 CI 与主77项
采用上一片对应证据，不声称本轮重复执行。下一片选择明确的跨连接文件
选择器 ready→trigger→collect 缺口。模糊的 Content-return 尚需当前基准
和语义确认；已有正文、PDF/MHTML 与剪贴板返回不重复开发，不用历史命令
字符串推导新 API。完整矩阵继续 active，仅本地提交，无 PR/推送。


### P10：跨连接文件选择器准备确认

新增协商版本 1 的 arm/collect/cancel 三个 RPC，JS/Python/Go 提供 wait handle，
CLI/MCP 沿用通用 call。确认 root 和已知 child interception 实际就绪后才返回，
另一连接可随后立即点击；新 OOPIF 也加入准备屏障。旧公开并发等待复用同一
registry。每 tab 一个、全局128个；原 scope、attachment、文档和 deadline
固定，并发 collect 冲突、成功只交付一次。超时不重放点击或文件设置，取消
可以按原 scope 在期限后重试真实清理；清理失败继续占容量并阻止假成功暂停。

首轮 `run-cAgqZx` **1/9** 暴露浏览器原生 timer 的 receiver 要求，增加真实
realm 约束回归并改用 global 包装。`run-16fvkO` **4/9** 和诊断 `run-Yzz3ni`
**1/2** 保留了新 OOPIF 首次提交先于父端 swap 的实际事件。现分别记录精确
frame/parent/child session 的首次提交与首次 swap；重复导航、移除、错误来源
及匹配后的变化继续使等待失效。没有用 about:blank 假设或更宽豁免绕过问题。

最终专项 `run-bE4e26` **9/9**，完整 headed `run-3OY97j` **83/83**。五入口各自
以两条独立连接验证冷 root、既有 OOPIF、arm 后新建 OOPIF，实际上传再清空；
独立审计重新核对30条原始 POST body/base64/SHA及文件UTF-8/二进制内容，另有
生命周期6条。并发collect明确一成功一冲突；取消后在原文档观察至旧deadline
后267ms，只有预期3click/2change。原始可信点击与上传change均保留，清空事件
本身是既有合成change，不冒充硬件可信。Pause及worker替换拒绝旧handle。

完整 CI **882** 项 Node（751扩展、53脚本、78脚手架）、JS **105**、Python **73**
与Go全包通过，无跳过。源码、SDK dist、实际host与两次成功运行的hash一致。
全套单一observer覆盖119643ms，六次测试窗口首tab激活与四条明确action popup
focus全部精确归因，sentinel不变。代1host由既有恢复场景明确SIGTERM，代2
exit0；不将故障注入称为正常退出。失败运行及原始trace均保留。

本轮仍用明确声明的loopback Port adapter，不代替实际native launcher验收。
scope证据是保留的caller scope与冻结代码，非完整RPC transcript；部分负例
只保留断言类型。焦点连续区间从observer就绪到末快照，不覆盖启动/退出；
host清理审计依赖退出证据，未新增OS进程枚举。此前Edge原生focus失败保留，
未做当前Codex上传对照，完整P10与长期目标继续active。仅本地提交，无PR/推送。

最终 ZIP **1,251,944 bytes / 46 files**，SHA-256
`8990be12bf0702945e919b6f852246bea01feb56dfba7558939b91a3f85f5f9d`。
两次独立制品审计逐成员核对 ZIP/unpacked、35个生产hash和其余静态文件，
均与专项及完整实测一致；图标恢复为原验收字节后重新打包。无测试插桩或
私有路径，host SHA-256
`1f946d2b407de5fb3829513798ae89223ef785e57cb4038f920f597962e71c37`
保持一致。ZIP外的构建manifest包含本地绝对路径，不作为公开附件；用户
主浏览器的安装未改变。新JS生成模块与声明随源码一并纳入版本控制。

### P10：跨连接页面下载准备确认

新增 `downloadWaitVersion=1` 与 arm/collect/cancel 三个 RPC，JS/Python/Go
提供同步可编排的 wait handle，CLI/MCP 沿用公开 call。准备确认覆盖原
attachment 的 root、既有与后来加入的 OOPIF；另一连接在 ACK 后可立即
点击。首个实际 Page 事件在异步权限校验前固定，原期限包含准备与最终
校验，合法导航不续期。旧 waitForDownload 共用每 tab 一个、全局128个
的注册表；并发 collect 冲突，成功单次交付，结果固定原 scope 和 tab。

取消只退役观察，不取消页面的实际传输；超时后仍可按原 scope 用独立
清理预算重试。真实未完成的 setup 保留清理账本，不关闭共享 Page 事件。
Page GUID 的路径查询和实际取消仍明确报不支持，不猜测文件归属，也不
用新 GET 代替原页面响应。独立评审补齐 Go 结果的 tab 绑定和原始请求
前置校验；确定性测试覆盖首事件校验倒序、最终校验越过期限等竞态。

首轮专项 `run-c0ip6L` **7/9** 中，Python/Go 各有三个真实下载和正确文件，
但独立监控连接未发送 scoped RPC，因此主机没有关联其通知会话。现先
等待公开只读 getTabs 再允许触发，保留原通知要求；真实 SDK wire 回归
证明连接加本地回调本身不发送请求。失败证据保持原样。修复后专项
`run-mRwIs8` **9/9**，独立审计24份实际文件共98,376字节与原始响应一致，
五入口及跨进程 OOPIF、原生 GUID/通知范围、取消观察后传输完成均通过。
19,297ms 连续 observer 内一条创建激活、两条主动 popup focus 精确归因。

首轮完整 `run-Ni9Djz` **87/89**：两个控制面板场景均被浏览器以目标窗口
未活动为由拒绝，其余场景通过。该运行仍为失败，不放宽焦点规则或用
专项结果抵消。新增只读初始/最终窗口state、focused与完整ledger采样，
不主动聚焦或还原窗口，亦不声称异步快照是原子OS前台日志。

最终检查另暴露既有 Windows 管道关闭缺陷：旧 export 参数负例在601秒
超时，Close 等待 doneCh，而 listenerRoutine 已回外层 select、Accept 已
退出。采用 go-winio 正式 v0.6.3 的上游关闭广播修复，同步 x/sys v0.48.0
和其所需 Go 1.26，仓库与构建固定官方已校验的 Go 1.26.9。旧工具链和
失败日志保留，新工具链独立安装。回归分单次/八次并发 Close、无客户端/
立即断连四类真实交错，并检查 Accept 实际退出、端点释放、存量连接仍
可双向通讯；不以测试超时代替清理，不称有界压力为确定性复现。原卡死
参数负例20次通过，相关 transport/host/wire 测试通过；正式CI和浏览器
验收使用新构建的主机及所有Go调用程序，和旧版本证据分开记录。

最终新版本专项 `run-lMFHcB` **9/9**、完整 `run-k3mDiy` **89/89**，独立
16组审计均通过。两次初始窗口normal/focused=true；全套129,574ms连续
observer内六次fixture创建激活与四次真实popup focus均精确归因，sentinel
不变。24份实际文件98,376字节、22个collected GUID及取消后的真实传输
完成再次核验。原主机SIGTERM属于明确重启注入，后继exit0；所有连接关闭。
349份预跑源码/锁文件/二进制与实测一致；72份历史失败results、三份故障
日志和六份旧Go二进制保持原hash。完整CI **906** 项Node（771+53+82）、
JS115、Python82及Go全包通过，无跳过。

该片仍使用明确声明的native Port adapter，scope证据不含完整RPC transcript，
焦点覆盖不含启动与退出。旧窗口最小化原因未确定；未新增当前Codex下载
对照，未解除此前Edge原生focus失败，Page GUID路径/实际取消仍是缺口。
完整P10与长期目标继续active；仅本地开发和提交，不推送、不提PR。

最终ZIP **1,255,479 bytes / 47 files**，SHA-256
`cef6706a1cf69717835f168c4e96bd1f20146f0dfc610e9b28b58434a2c5a0c8`，
逐成员与unpacked及两次实测一致；36项生产JS/JSON hash及其余静态资源
均核对，无测试插桩或私有路径。主机SHA-256
`9ea5b96aaf6a67221aaf87ec634f9e9fad50d36b9761eb2cbcafcd62846c475e`，
与两run和新构建基线相同；源码、生成JS模块与声明一起纳入版本控制。
ZIP外本地构建manifest未作为公开附件，用户主浏览器安装未改变。

### 共享研究任务与来源核验

新增本地合成研究任务：采购要求、三家当前报价与交付条款、过期摘要、
三种DOM/frame布局和每任务不同的来源修订。正确答案只在服务端评分；
JS/Python/Go/CLI/MCP必须各自经公开入口建页、读取可见事实、计算比较、
填写并提交一次报告、核对回执，保留报告且关闭任务及资料页。CLI/MCP
不借SDK代做生命周期。另加独立server供当前Codex使用同一fixture比较。

验收记录保留原始GET请求记录及POST字节、调用器读取与步骤、报告PNG、源码身份；
独立observer被动记录实际tabs创建/移除及最终metadata，防止调用器自报
清理冒充原生结果。专项 `run-AOpN3n` **16/16**，全套 `run-WWWaGP`
**104/104**。每轮15任务、90来源、15单次POST、75创建/60关闭/15保留均
独立核验；专项连续账本零激活/零focus，全套六激活/四focus精确归因原有
fixture及控制面板动作，未增加豁免，既有tabs不变。三份报告视觉检查及
45行事实重新计算通过。跨源frame可见不自动宣称新OOPIF进程证据。

CI **920** 项Node（771+53+96）、JS115、Python82及Go全包通过，无跳过；
最终Go调用器编译及新14项Node定向检查通过。预跑冻结364源码、7二进制、
182旧结果/日志；两轮审核后只改文档。生产没有新增API或修复，已有
1,255,479字节/47文件ZIP保持SHA-256
`cef6706a1cf69717835f168c4e96bd1f20146f0dfc610e9b28b58434a2c5a0c8`。

当前Codex Edge同fixture三布局最终报告 **3/3**，实际read-only DOM读取、
动态展开、普通表单填写/选择、单次提交及保留报告/关闭四页成功，无浏览器
方法失败或替代。任务后的证据导出一次语法错误保留；独立server启动未
保留可写stdin，stop无法发送，核对进程身份后强制退出且保留exit1，不能
宣称正常停机。该端只有工具ACK与最终tabs清单，没有独立OS焦点账本。

这是有限资料核对任务，不能推断开放网页研究、模型规划或性能全面持平。
既有popup前台、Edge恢复、下载GUID路径/实际取消、多平台等缺口不变；
完整目标继续active，仅本地提交，不推送或提PR。细节集中记录在
`docs/references/shared-research-workflow.md`，同步矩阵、计划及质量记录。

### 后台长闲置、并行渲染和独立收尾

新增可单独开启的真实浏览器场景，默认104项保持原范围。三个公开JS SDK
session各有两个后台页；A静默至少310秒，B/C持续可信填写/点击、实际POST
和截图，C中途结束并显式开始新scope，B继续。A恢复后的首条SDK请求是
截图，然后更新并验证新画面。被动原生探针保留原Promise/参数/结果，记录
真实frame/ACK、渲染区间与清理；不修改私有队列或焦点规则。

首轮 `run-8DMNGR` **1/2** 在4.67秒即因DPR1.5元素图高度断言失败，原
四张360×92 PNG和失败状态保留，不能称长闲置通过。原图16色块均正确；
旧检查忽略截图引擎的CSS整数包围裁剪。修正后记录原native clip及截图后
box/root scroll，严格复算尺寸和像素位置；没有放宽错误画面或旧状态判断。
七项纯测试涵盖小数原点和1.25/1.5/1.75 DPR，并验证原Promise、全部分支
settle和native事件顺序；scope结束尝试在发送前登记，未知finalize不重发。

最终专项 `run-ttHLU9` **2/2**，静默310087.7247ms，31轮，172原始POST、
182 PNG共9,783,561字节、2912色块采样独立核验。490原生渲染区间和563对
跨owner重叠实际存在；C收尾与B成功操作重叠、原scope继续，8页真实关闭、
无pending，原4tabs不变。连续账本零激活/零focus/零新增豁免。关键首次
恢复、更新和跨源截图已查看。初始8页及恢复2页visibility均visible，保留
生产focus emulation；该证据不等于hidden/intensive节流或OS鼠标测量。

完整CI **927** Node（771+53+103）、JS115、Python82及Go全包通过；早期
缺zip PATH、默认pnpm shell不兼容的环境失败日志保留。预跑冻结361源码、
7二进制、192历史记录；旧基线和失败原图未覆盖。生产代码与原47文件/
1,255,479字节扩展ZIP保持不变。系统调钟日志隔离、原Page GUID路径/实际
取消的只读机制审计仍未给出普通扩展内可靠解法；既有缺口继续开放。
全部修改仅本地，不推送或提PR。

独立默认回归 `run-NDr4vF` **104/104**，case集合与既有主套件逐项一致且
不包含长测。15研究任务、90原始来源、15POST与75创建/60关闭/15保留再次
独立核验；连续六次激活和四次focus均精确来自原有fixture/控制面板动作。
两轮冻结源码/runtime/产物/历史身份一致，无新增焦点豁免。正式runner
保留opt-in入口、可重跑fixture和证据检查，具体边界另记
`docs/references/background-parallel-workflow.md`。本片完成，整体目标active。

### Windows 品牌安装与实例发现

新增 Windows Brave、Opera Stable、Vivaldi catalogue、安装 selector 和真实
profile 布局，Opera 兼容根目录 profile 与 Default；Linux 仅加入有官方源码
依据的 Brave。三个 Windows 品牌共用 Google Chrome Native Messaging
namespace，安装前验证现有 manifest 和双视图注册，在进程锁内重新检查并
合并合法 origin；拒绝冲突、损坏和不明字段。保留合法非默认 manifest 路径。
单文件替换原子化，整体安装不宣称事务回滚。ZIP 在覆盖前验证真实 public
key 及 Windows 路径别名；新品牌需手动安装，不隐式套用自动分发/启动流程。
重复实例 UUID 保留歧义，不能把多 profile 的复制数据当成唯一 live 身份。

Go 完整测试与 Windows/Linux/macOS 编译通过。新 host 的默认真实浏览器
回归 `run-Ov7GEM` **104/104**，独立核对全部 case 名及15研究任务、90来源
GET、15原始POST、75建页/60关闭/15保留；六激活/四focus均为既有明确
fixture动作，没有新豁免。该主套件仍用已声明的 Native Port adapter。
生产扩展及原 ZIP 保持不变。CLI/MCP每次RPC重新发现endpoint可能漂移的
既有缺口已在架构与债务中纠正，不再误称启动时固定连接身份。

新增单独 opt-in 原生品牌验收：官网下载签名程序仅解包，每次建立隔离
profile，真实 connectNative、CLI 实例发现和后台 JS SDK 任务均保留证据。
只注册事前不存在且有所有权标识的随机 HKCU 叶，生产固定注册只读比较。
失败不改写；原生与浏览器精确句柄正常退出、endpoint 和自有注册清理是
通过条件。PS5模块继承、中文版本页、Brave自定义开关、pending标签URL四次
脚手架失败保留，针对实际证据修复；外部输入法后代进程记录并保持未触碰。
Brave 最终 `native-installation-brave-f2CLp5` 通过，独立核实真实输入/点击、
唯一原始POST、准确PNG及finalize，连续零激活/零focus，无新增豁免。
这不等于固定注册安装、重启/签名更新、其他平台或完整品牌能力验收。

真实 Opera 暴露安装发现漏读：实际 Secure Preferences 用 `opsettings`。
仅按已知 Opera catalogue 读取该表，其他品牌仍读 `settings`；增加七品牌
冲突表、缺失记录和 Default/根 profile 回归。修后 `b2zz2L` 的公开发现及
选择器通过，newTab 却报组不存在，保留整项失败。Vivaldi 实际 native 与
发现已通过，但 `V8o50Q` fill 返回成功后提交为空、无输入事件；新增只读
观察的 `eNV0Su` 在 goto 超时，未到输入。两种产品缺口继续保留，未为通过
测试激活页面、改 DOM 输入或重试副作用。品牌 setup 的版本页、vendor UI
诊断页与内置禁用条目处理都基于实际记录，未改变生产扩展权限。

最终新 host 与脚手架的 Brave `eF73Op` 再次通过，独立原始输入/POST/PNG、
连续零前台事件、正常退出与清理核验通过。完整 CI **947 Node**
（771扩展+53脚本+123脚手架）、JS115、Python82、Go全包通过，新增 Go
修复也通过 Linux/macOS 交叉编译。原生产 ZIP 与四个图标保持已验证字节；
CI新生成候选另存，没有覆盖旧运行证据。仅本地开发和提交，不推送、不提PR。

最终默认回归 `run-ewJVHf` **104/104**、终端exit0；独立审计精确case集、
15研究/90来源GET/15POST、75建60关15留及原六激活/四focus归因通过，
无新增豁免。364源码、203旧结果、最终host与六调用器身份一致。该默认
套件仍是声明的Port adapter，不替代真实native品牌测试；Opera/Vivaldi
失败与既有更广缺口继续开放，完整目标保持active。

增加显式原生命令诊断，记录有界 API 调用/返回、被动事件与实际 task GET；
默认验收不启用，诊断 passed 恒为 false，完整采集与真实任务通过分开。
初版 Opera `BnR9eF` 在 worker body 执行前读初始快照，保留整体失败；
改到原有 native 握手后读取，没有增加轮询、激活或输入替代，定向测试
34/34。最终 `pmcGIj` 确认 group 创建成功后先收到离组/移除事件，再发生
update 拒绝；事件只证明顺序，不冒充内部原因。Vivaldi `6TvJ0U` 则在
CRX attach 的九条 renderer 初始化命令处持续 pending，未发送导航/输入，
实际 GET/POST 均零。两轮诊断完整、真实任务失败，原生退出/清理通过。

官方 Vivaldi snapshot 8.3.4185.3 另行解包验证；`l5U4my` 在安装前管理页
求值失败，尚未启动本扩展和 host，不能比较新版任务能力。独立审计保存
冻结源码、历史结果、真实制品与各轮失败边界；授权后生产改动不混入旧
运行身份。整个过程仅本地推进，不推送、不创建 PR。

普通无组任务页复用 AuxiliaryTabOwnership v2；原生新页提前预留、只按实际
返回 ID 绑定，以本次真正新建的 singleton ACK 判断兼容路径。既有 grouped
页离组仍撤权；同组重复 claim 保留 agent 来源。创建失败后的清理持续观察
用户接管，已存在组中的保留失败页以精确 `excludedGroupId` 持久撤权，
Pause/worker 恢复不重新枚举授权，明确 claim 才按 user 接管。遗漏 agent 页
关闭，user 页释放，无组 deliverable 保留实际非活动页面并撤权。公开 API
不变。扩展 806/806 与独立定向 76/76 通过；完整CI为1,001 Node、JS115、
Python82和Go全包通过。新ZIP1,260,454字节/47文件，原图标不变，旧制品
及所有失败记录保留。

新增 opt-in 原生多页验收，要求 A/B 隔离、handoff、显式新 turn 恢复、A
再次提交、C 交付及遗漏 A 实际关闭。原始四 GET/五 POST、具体拒绝原因、
新旧 scope、非活动保留页和零新增焦点豁免均纳入断言；默认单页流程不变。

同一 v15 冻结版本的 Opera `7IDBb7` 和 Brave `vC2mkf` 均真实完成上述
任务并独立审计通过，各12步标准任务+35步ownership、四GET/五POST、
十个连续焦点检查点零事件/豁免，准确关页、交付撤权与native/browser
exit0及随机注册清理。实际PNG已查看；Opera三任务页无组，Brave真实
任务/交付分组正常。Vivaldi `b9p876` 则在独立观察页首次求值20,003ms
超时，已经完成安装/native/发现但未开始task，完整清理且保留失败边界。

默认 `run-5TPsWz` **104/104**、terminal exit0；独立审计核369源码/
210旧结果、新ZIP全部47成员、host/六调用器和精确case集一致，15研究
任务90来源GET/15POST、75建60关15留正确，六激活/四focus仍全属原fixture。
审计自身的两处字段误用有原失败日志，修正读取实际静态成员和既有HTML
hash后通过，运行证据和源码未动。完整目标仍active，未推送或提PR。

本片新增独立 Vivaldi 首文档诊断，默认路径与生产插件不变：只对管理页和
观察页，在首次目标连接前核真实tab/window/非活动状态、committed URL、
complete及原target，创建至求值共用25秒期限。失败另留最多2.5秒只读
tab/target快照；迟到create/connect不能继续发操作，诊断恒不算acceptance。
15项新增回归加现有脚手架共157/157，独立审查、文档/卫生检查通过。

真实Vivaldi `7y16Q1` 两设置页229/155ms内通过后进入生产任务，但fill ACK
后value仍空、inputEvents为空，唯一POST也为空，task失败按原样保存。
两检查点408ms零焦点事件/豁免，host/browser exit0及完整清理；独立核
371源码/214旧结果、原47文件ZIP、host/SDK通过。关闭诊断的默认Brave
`t8wpE8` 标准任务与独立审计通过，后台PNG已查看。生产ZIP保持原hash，
未重打包、推送或提PR。单轮设置成功不证明Vivaldi已修复，后续继续核
文本提交实际路由；完整目标保持active。

本片新增独立 Vivaldi 原生命令/页面事件诊断及任务首文档检查，生产文件
和制品保持不变。被动事件账本有界，保存原note节点和document身份、
真实HTML与单次POST；日志失败不伪报完整。任务检查只在原newTab/goto
之间只读同一非活动tab/target，最多5秒，不激活、重建或重发动作。
末次保存受同一预算约束，超时后不继续goto。新增23项后脚手架180/180、
独立定向77/77，文档/卫生检查通过。

`PI0rSV` 在任务初始化超时、未到输入；独立核373源码/216历史及严格
清理，失败保留。`QAMMuD` 在blank提交检查106ms后goto成功，原生输入
目标/完整文本正确且ACK，但原节点值与唯一POST仍为空，无输入事件。
诊断完成与任务失败分开记录，不宣称根因或生产修复。默认Brave
`QC0zdV` 标准任务、零前台事件、实际PNG及独立审计通过；生产原ZIP未
改，也没有推送或PR。完整目标继续active。

本片新增独立逐键与指针聚焦诊断，保持原native wrapper、生产及默认
fixture字节不变。逐键只预选pressSequentially；指针对照只预选一次
输入框click再原fill/Submit。分别保存真实命令、可信DOM事件、原node/
document身份、唯一POST和有界记录，不将ACK或采集完整当输入成功。

`HrDsGN` 正确78条逐键命令全部ACK，但原文档没有键盘/输入事件、POST
仍空；`ttYgKb` 原输入框收到可信pointer/mouse后，唯一原fill确实写入
39字符并正确提交，截图/finalize/关页全通过。两轮分别508/1068ms零
前台事件，精确进程与注册清理、源码/历史/制品独立审计通过。默认Brave
`TKisEN` 标准任务和独立审计通过，实际PNG已查看。诊断模式仍不算正式
acceptance，显式先click流程成功不等于可无副作用地修改通用fill。

最终脚手架198/198、定向独立94/94，文档/卫生检查通过。全套初轮唯一
失败为form单测随机端口命中Node fetch禁用列表；保留日志，将该单测
传输改为真实node:http，并覆盖UTF-8、状态码、解析错误、reset、截断
和超时。未改系统端口范围、浏览器fixture或生产；只做本地提交，无PR。

本片将首文档提交检查接入生产冷连接，共用动作、observer和transfer
原期限；创建marker先登记后admit，raw/shared连接、晚到结果、撤权与
分阶段清理均有回归。新增21项生产测试，作者154/154、独立108/108；
完整CI为827+53+199项Node、JS115、Python82及Go全包通过。INPUT诊断
透明记录已有tab/target读取，不新增任务gate。47文件新包仅两生产JS
变化，1,262,151字节，SHA256
`8e5d9a2777efe36fd01135c9117cf8257668c72951e5d1347766544a7c2ae9f7`。

Vivaldi首轮 `wv2kHQ` 在扩展安装前About求值超时，失败保留。同冻结版本
独立 `yeWkzC` 无TASK_READY即读到blank提交后唯一attach，原goto82ms；
原单次fill仍ACK但无输入事件、POST为空，未宣称通用输入修复。默认
Brave `i40fyX` 完整任务/实际PNG/零焦点及独立审计通过。Vivaldi有效轮
与Brave均真实native/browser exit0，精确进程和注册清理通过。

主回归 `run-chNw0r` 实际exit1，原104项41通过/63失败，另最终focus
检查失败；连续账本出现未知窗口focus及两次tab激活，终态minimized。
保留失败和旧104/104，不增加豁免或归咎未证实的外部操作。下一片优先
调查该完整回归边界；整体目标仍active，无推送或PR。

用户随后明确确认上述失败轮期间操作过测试浏览器。保留原结果，补记
该干扰证据，不把每条事件精确归因给用户。同生产源码/包独立重跑的
`run-p0iiaM` 原104/104、终端exit0，焦点规则完全不变；六次fixture激活
及两个明确popup的四focus精确对应，最终窗口normal/focused。独立核
379源码/226旧结果、host/六调用器/四runtime/47制品成员，以及15研究
任务90来源GET/15POST、75建60关15留通过；根代理查看后台实际PNG。

新增独占Vivaldi DOM_FOCUS脚手架：首次原fill前经公开SDK/CDP执行一次
getDocument/querySelector/describeNode/focus，共享5秒总预算。原INPUT
HTML和三快照不变，另存之前的原节点观察；无TASK_READY、额外点击、
按键或fallback。完整采集、空值/未focus前提、ACK和任务成功分开报告。
代码不进入生产扩展，生产/SDK/host/ZIP未变；无推送或PR。

DOM首轮 `YMxiBJ` 原任务空POST失败，同时暴露诊断比较器的对象字段顺序
和跨进程Date.now假阴性。原terminal1/diagnosticfalse与审计v1保留，独立
审计v2补记语义正确而输入失败。判定改用同worker序号和结构语义，本地
期限另验，不加时间容差。最终脚手架217/217，新18项独立复核通过。

最终 `ntZmPW` goto73ms、四DOM命令22ms，原节点获焦却仍无输入事件和
有效文本，完整诊断exit0不算任务通过；433ms零前台事件。默认Brave
`KKcjBO` 原12步/POST/实际PNG通过，744ms零前台事件。两轮独立核381
源码/228旧结果/47制品成员及精确host/browser退出、注册/进程清理通过。
此候选没有进入生产，Vivaldi输入与其余整体能力缺口继续保持未完成。

新增独占HOVER_FOCUS诊断：原goto后一次公开input.hover，再原单次fill/
Submit，不开TASK_READY/DOM.focus/按键/force或重试。复用原INPUT HTML
与三快照，另读原节点身份、`:hover`和矩形；同worker核完整原生命令链，
采集完整、实验成立和任务成功分开，诊断passed恒false。脚手架231/231、
独立定向63/63通过，原默认/INPUT/DOM HTML与旧观察表达式保持不变。

Vivaldi `Fm2cYE` 的原输入框确实进入悬停状态，唯一移动、原insertText和
Submit三命令均ACK，但原fill无输入事件，唯一可信POST仍为空。诊断
exit0不算task/acceptance成功；552ms零前台事件，精确进程退出与清理
通过。默认Brave `zwqwku` 原12步、真实POST、实际PNG及清理通过，697ms
零前台事件；根代理已查看截图。两轮独立核383源码/230历史/47制品成员
与随机/固定注册边界通过，生产、SDK、host及ZIP未改，旧证据均保留。

固定Chromium源码排除IME入口可提供不同focused-widget路由的假设；未
新建IME实验。下一片转P04观察元数据，保留Vivaldi通用fill兼容缺口，不
把显式click成功转为通用fill隐式副作用。整体目标仍active，无推送或PR。

本片开始补P04位置观察：`snapshotAI({boxes:true})`增加原生ref对应的
frame内CSS位置、结构化frame/ownerRef/viewport信息。默认响应保持原样，
框与视口由同次renderer读取；真实Frame身份在发布前核验、内部GUID不
对外泄露。原限额、期限和capture失效路径保持；不滚动、不激活、不用
逐ref调用拼接。JS/Python/Go及CLI/MCP共用公开协议，没有新增Pi适配。

原生patch和runtime已交叉审查，补正空子frame标识末尾换行的严格校验。
坐标不假设父iframe仅平移，也不当作可点击性保证。完整CI通过：扩展836、
scripts59、harness236、JS120、Python86及Go全包，零跳过。首轮几何
`tIVleQ`实际5/10：动态Emulation的截图比例与DOM DPR不一致，原生原因
未锁定；Go调用器另有截图JSON字段大小写错误。改成三个独立browser的
固定原生启动比例，并修caller编码；最终harness238/238、Go新增1/1通过。

v27冻结394源码/233历史，48文件ZIP与实际扩展/静态文件/依赖补丁及
host、七个Go调用器和运行时hash逐项核对。DPR1 `oVaN3m`、1.5 `wTM1CH`、
2 `x5s4pZ`各10/10和独立审计通过。45张PNG的nonce/阶段像素与原生
marker ref位置匹配；315目标框和180 iframe框与DOM误差0。12个当前
capture ref真实读取成功，各观察区间16557/14793/15427ms零前台事件，
无新增豁免。根代理查看初始和变换后实际截图。最初auditor对原始base64
与处理后PNG元数据格式的误判记录保留，修正后的审计不改实际运行数据。

新完整回归`7YcNf9`实际exit1，原104项99通过/5失败另有focus最终失败。
动态OOPIF的JS chooser在原10秒内未收到原生打开事件，root和静态OOPIF
先前上传/清空成功；点击ACK不等于picker打开。末段窗口minimized并出现
未归因focus，两个popup无法打开，后续两项受账本失败影响。原因未锁定，
不改超时、不重放点击、不宣称全套通过。下一步补被动原生命令/失败DOM
证据，继续定位。生产位置功能专项通过不等于整体目标完成，仍仅本地提交。

用户对新失败轮时段回复“可能点了点窗口啥的”，补记存在外部操作的
可能。保留原99/104及focus失败，不据此判定焦点回归，也不把更早的
chooser超时或所有窗口事件直接归因于用户。

新增opt-in chooser原生命令诊断，保留原动作/HTML/10秒期限与默认104项。
原Promise及异常不被替换，命令与事件共用有界序列；失败后原scope只读
采集总计限3秒，过期不继续发读取，不附加点击/attachment/焦点操作。
完整trace与失败观察分别判定，原任务成功与诊断完整分开，acceptance恒false。
脚手架250/250、独立定向15/15及HTML字节一致检查通过。v28冻结396源码、
237旧结果及原生产制品；真实诊断 `Yh4Yz7` 两项通过且终端exit0。动态
child的拦截ACK早于原点击，随后收到对应chooser事件，三variant共6条
真实上传/清空POST。旧超时未复现、原因未定；未据成功trace修改生产。

随后默认 `ZzBRWH` 原104/104、终端exit0及独立审计通过。结果/variant/
worker均无诊断探针；194500ms连续账本仅原六次auxiliary创建激活及四次
明确设置popup focus，后台豁免0，root初末均normal/focusedtrue。十五项
研究任务的90来源、15POST、75创建/60关闭/15保留核验通过；396源码、
237旧结果、48文件ZIP及实际SDK/host/caller身份匹配（运行后只改文档）。
新通过不改写旧失败，也不证明其根因已修复；P04完成，完整目标仍active。

### P02/P13：MCP 固定实际连接

MCP此前保留当前tab、turn与epoch，却为每个浏览器工具重新发现endpoint。
改为stdio服务持有首次实际连接，绑定后不随active记录、profile候选或
同路径同UUID替换而改选实例。持续reader消费有界帧，唯一wire ID隔离
迟到回复；响应等待超时不重放，健康连接可显式begin-turn。EOF、坏帧及
不确定写入永久关闭本服务绑定，后续明确要求重启MCP。stdio退出释放连接。
发现的网络尝试共用剩余预算；同步文件读取仍不能被socket deadline抢断。

Windows真实named-pipe/stdio黑盒覆盖A/B相同数字tab/epoch、替换实例、
半帧迟到、通知背压、写超时、丢失结束ACK及清理。另测完整回复紧接EOF、
16种坏响应、合法业务错误与null结果。初次全Go测试发现旧分类用例将1ms
同时当作文件扫描预算；改为合理分类预算并断言实际探测发生，期限另由
专门测试验证。修正后Go全包及完整CI通过：Node836+59+258、JS120、Python86。
当前环境无CGO竞态工具链，未宣称race检测通过。

专项`run-ykbo3D`实际terminal0、2/2。同一旧MCP进程跨真实host重启后
三次连接失效，新MCP显式领取新轮次；只有两次可信页面POST，最终回收
两页及debugger targets，两个MCP正常退出。此处使用同浏览器的Native
Port adapter，不是双浏览器或OS launcher验收。独立审计原始stdio、HTTP
及制品通过，5999ms连续焦点账本零事件、零豁免。

v29冻结402源码/239历史，新Go1.26.9主机；扩展48个制品成员与v28逐字节
相同。重打包ZIP容器hash改变，不能称整个ZIP字节不变。默认`k5giEj`
terminal1、原104项103通过/1失败。唯一失败JS动态跨源iframe下载达到
原10秒等待期限，无文件端点GET和原生下载事件。其余四入口同类下载、
全部15研究任务和恢复用例通过。现有trace没有原点击ACK和失败DOM；
生产engine/下载模块/vendor/JS SDK与旧成功轮相同，不能证明本次新竞态
或MCP因果。保留失败，不增加超时或重放；下一步补有界诊断定位。
独立失败审计另核原104集合、402源码/239历史、新主机/调用器/48成员，
十五研究任务90来源GET、15POST、75建/60关/15留；209160ms同observer
仅原六次auxiliary激活、四次明确popup focus，初末root均normal/focused。
其他检查通过不改变全套失败结论。本片仅本地提交，完整目标继续active。

### P10：动态下载失败的可观察性

针对`k5giEj`缺少click ACK/DOM证据，新增独占下载诊断开关，沿用原三个
布局及raw对照。复用有界native记录器，严格download类型分别记录原命令
及事件；原receiver、参数、Promise与错误保持。setup/finish身份与截止
防止晚安装和误清外部probe。原业务阶段、一次3秒原scope失败只读DOM及
独立cancel错误补齐因果线索；不延长10s/5s期限、不重放输入或新增attach。
默认没有probe或失败DOM，业务原异常也不会被cancel异常覆盖。

脚手架284/284、独立定向32/32及6份HTML字节核验通过。v30冻结405源码、
241旧结果，生产扩展48成员、ZIP、主机与SDK都未变。`avWmSX` terminal0，
两原case通过；78条连续native记录、29命令/ACK和12 Input完整，三GUID
与真实GET/文件12,297bytes一致，动态child enable ACK早于原下载输入。
3784ms同observer无前台事件或豁免。旧超时未复现，失败DOM分支仅有语义
测试，diagnostic acceptance恒false，未以成功样本添加生产补丁。

默认`Ve7nKv`实际terminal1：原104项87通过/17失败另有focus最终失败。
五入口下载和生命周期通过；后段21:30:52的focus使账本持续拒绝。用户
明确确认当时有窗口操作，记录外部干扰背景；不据此断言所有事件或用例
失败都由用户导致，也不作为干净焦点对照。全部旧失败继续保留，目标active。

独立审计进一步核实五入口15次下载的唯一GUID、真实GET、scope通知及
各4099字节原始文件逐字节一致，且均发生在新focus前。默认没有下载
诊断注入；原结果未改。研究流程整体与焦点审计仍失败，单代host退出
通过不等于后续重启用例通过。本片未重跑全CI，仅报告上述定向验证。

### 首个 Windows 可试用预览包

按用户新增授权，复用其已有`mikyan/open-browser-use`fork，推送开发分支
`codex/browser-use-parity`，未创建PR。发布卫生检查覆盖待上传45个提交及
当前606个文件，未发现真实凭据、私钥或私有诊断日志。

发布`preview-20261011-593a4ba`，固定源提交为`593a4ba`，保留预览标记。
便携包包含Windows x64主机、扩展、双浏览器注册脚本、完整Skill与许可；
主机来自干净提交，扩展仅新增现有beta public key以固定手动加载ID。
新主机相关SDK/IPC测试23/23、独立包审计及四资产下载回SHA核验通过。
未执行日常浏览器安装或完整新制品浏览器验收，已知限制写入发布说明。
源码推送与预览包交付完成，不等同完整Browser Use能力目标完成。

### 文件选择器的单次提交

修复`setFileChooserFiles`在原生命令返回前可被另一连接重复提交的问题。
同chooser在首个原生await前占用，已开始的提交不因失败重新开放；纯参数
校验失败仍可纠正。清空时只释放原attachment/child的remote object。
提交前文档销毁拒绝旧节点，成功ACK后允许change导致的合法导航，但
Pause、turn结束、attachment替换或tab撤权不能得到成功回复。移出再移回
且detach仍未完成时，原撤权token继续阻断，不能只靠当前tab列表判定。

新增确定性回归在旧HEAD上复现23项失败；首版扩展863、构建脚本59、
浏览器脚手架296项通过。新增实际双连接验收保留原root/静态及动态OOPIF
页面，上传和清空均一成一拒，消费后重复调用拒绝，不安装命令探针。
专项`frp1Zt` terminal0、9/9，独立核验6个原POST/97实际文件字节、同scope/
文档及真实childsession；16770ms连续零激活/焦点/豁免，三新页实际清理。
这是新case加原上传五入口及raw对照，不代表全能力矩阵完成；目录异步
枚举完成与更广平台仍待验证，已发布预览资产不变。

消费错误分类再补一条延迟live验证的回归：初版73/74、最终74/74，最终
扩展864/864；构建59与脚手架296亦通过，无跳过。初版完整`WUe0YQ`
105/105；最终源码`X2wiUq`实际exit1、104/105，新增case通过，Go动态OOPIF
首轮等待chooser超时。已有root/静态OOPIF各两个POST，动态页无POST；
调用器只有成功时输出阶段文件，故无法区分arm/collect或确认click ACK。
保留失败，未据此重放或延长期限，也未把错误推给本次set修复或外部操作。
最终focus校验通过，原六激活/四popup焦点，没有新增豁免；整体目标active。

### Go chooser失败证据与有界诊断

修复Go caller仅全成功后才落盘导致失败阶段丢失的问题。每个variant/
round及arm、add-frame、click、collect、set-files、receipt、cancel保留
开始/完成/错误；原操作错误优先，取消、诊断和close错误另存。普通模式
仍原JSON输出和请求顺序，原10秒chooser/默认click、15秒transport不变。

新隔离诊断模式在Navigate后、arm前用有界JSONL ACK安装精确tab探针；
原操作失败后、取消前一次总3秒读取trace、浏览器metadata和focus；若
失败来自Cancel自身则在其失败后读取。不取得新scope、不attach、不重放
点击、不读任务DOM。setup nonce及身份检查防晚安装/外来wrapper被清理，
最终等待子进程真实close并保留输出限额及退出证据。采集完整不等于验收。

339项脚手架和Go helper包通过，真实Go↔Node失败协议交叉检查通过。
原生诊断`nFsRPz`2/2、普通专项`JWc1eT`9/9、普通完整`npV0kp`105/105，
均实际exit0；完整焦点保留原六激活/四focus。评审后修复验证注释污染
原caller结果、文件不一致仍可能标完整的报告问题，最终诊断`PbIrsJ`
2/2、exit0。完整运行早于这组报告修正，浏览器动作与生产文件未改。
旧`X2wiUq`原超时未复现、根因未定，没有据新全绿宣称修复。整体目标
仍active，旧证据和已发布预览包不变，目录完成等能力缺口继续开放。

### 目录选择的完成契约与默认后台限制

修复目录枚举启动后 `DOM.setFileInputFiles` 已 ACK、文件尚未进入原节点
却提前返回成功的问题。setter 在首个原生 await 前消费 chooser 并占用
精确节点；固定 isolated world 读取真实 `webkitdirectory`，目录仅接受
一个绝对路径。成功需要原生 ACK 和该节点可信 `input`，`cancel`、合成
事件、超时或撤权均不能代替完成。普通文件及显式清空共享同节点 guard，
保留原有 ACK 与合法 change 导航语义，不自动重放未知提交。

新增独立 setter 总 deadline，默认10000ms、可选1–120000ms；三 SDK 有
向后兼容的可选超时入口。未知目录提交的 renderer guard 保留到真实终态
或文档销毁；跨 attachment 不凭旧 remote object 向新连接清理。实际 CDP
异常还可能返回 Error object，现将其单独释放，不能当成 controller。
Node 1311项通过，定向 transfers85项及目录模块26项亦通过。真实隔离
世界用例确认同文档 guard 经 detach/attach 仍阻挡后继；该用例刻意没有
发送文件写入，不冒充枚举中的 worker 重启恢复。

旧源码 `cz5yAz` 在3ms ACK后返回、当时没有完成 witness 或文件POST，
随后只有可信 cancel，原失败保留。新默认路径 `C15wWx` 则如实拒绝原生
cancel。固定 Chromium 156 源码表明目录枚举会拒绝 hidden WebContents
或非本窗口选中的 tab；这解释了后台 inactive 路径的限制，但不是实际
C++ 分支探针。该产品路径仍未解决，不为通过测试激活用户标签页。

实验 `Nl0c74` 为每个任务另建不聚焦、单选中 tab 的 popup，root 与既有
OOPIF 完成实际目录文件、重复选择及空目录检查；root另验证清空和无效
路径拒绝。动态布局停在 Add upload frame 动作超时，未进入目录 setter，
整体仍失败。三次新窗口首 tab 激活和零窗口focus如实保留；没有把实验
窗口加入默认产品路径或扩大主套件豁免，也不将局部成功称为正式能力。

最终默认完整 `Ob0pFy` 实际 exit1，**103/107**。相对 `npV0kp` 原105项
名称/顺序不变，新增目录完成与隔离世界两项。目录首轮 setter 16ms后
拒绝可信 cancel，原520字节 witness已核验，0文件POST。另三个 JS/MCP/
Go 动态 OOPIF chooser 超时：JS和Go首轮 arm、建frame与click RPC均完成，
collect耗尽原10秒，尚未取得chooser或调用本轮setter。JS只记录四个
attach/child navigation/root swap事件，没有chooser事件；默认无原生
Input/intercept命令或失败DOM。MCP只保留错误及已完成的root/OOPIF POST，
动态首collect是依据执行顺序的推断，不能声称有完整阶段证据。

独立审计核38个生产文件、新模块/SDK快照、调用器及声明的测试适配差异；
成功分支24POST、19文件共380字节与原文件相同。200596ms连续焦点账本
仍只有原六激活/四focus，未知事件为零；14个已记录任务tab在终局清单中
消失，另一个独立chooser生命周期页仍在，不宣称所有fixture页均关闭。
首host按恢复测试主动终止，后继host正常exit0。四项失败保留，增加的
chooser故障密度与本轮生产变更关系尚未排除，不能一概归为旧问题或声明
无回归。整体P10未完成，已发布预览资产不因这些本地改动自动更新。

### 显式后台窗口与目录上传正式验收

正式 `createTab({backgroundWindow:true})` / SDK `newTab` 新建独立、不聚焦的
normal 窗口及唯一任务 tab。省略/false 保留原创建路径，不搬移既有页面。
三 SDK 与 CLI/MCP 以 `backgroundWindowVersion:1` 防止旧扩展静默忽略参数。
这条路径会增加可见窗口，默认 inactive 目录限制仍保留，不把额外输入或
激活用户窗口作为自动补救。

新增独立 background-window 归属及 v3 存储，兼容 v1/v2；同 session 原
分组保持不变。创建事务、原控制期限和 fresh-blank 保护沿用，迟到结果、
Pause/end 或用户接管不能重新授权。搬移、分组或 pin 先同步阻断，再持久
保留撤权记录，重新进入原组仍拒绝；明确 reclaim 按 user origin 处理。
finalize 只删除自有 tab，由浏览器关闭空窗口；其他页存在时保留该窗口。

Node **1347/1347**、JS129、Python94通过。受影响 Go SDK87与CLI109个
顶层测试通过，另有23项既有平台 skip，不能称 Go 全平台无跳过。
首轮正式 `UPWXAL` 实际 **4/5、exit1**：inactive 负例提前保存原 owner 的
scope，之后与第二连接比较时仍使用旧快照，未进入实质测试。修正仅将
scope 快照移到原本已有的 `getTabs` ACK 之后，没有新增 bootstrap、API
或浏览器动作；旧失败未改。该轮后台窗口目录与混合 finalize 已通过。

该轮完整 `zyiYQg` 实际 **106/109、exit1**。原105项名称与顺序完整，新增
隔离世界、inactive 目录拒绝、正式后台窗口目录、混合 finalize 四项全过。
三布局目录16轮、13个真实文件 POST、30份载荷共408字节，包含中文、嵌套
同名、二进制、零字节及空目录；原文件与原始请求逐字节核对。12次目录
选择收到可信 input/change，另一次显式清空沿用合成事件。成功 setter 的
首个返回回调即读到同步 witness，未以事后轮询代替完成；三项非法提交
拒绝且无新增成功 input/文件 POST。默认 inactive 负例可信 cancel、零上传。

JS 单次提交、JS 双连接、Go 双连接三项在动态 OOPIF 首轮 collect 耗尽原
10秒，均尚未取得 chooser 或调用该轮 setter。JS 双连接只保留 frame
attach、child navigation 和 root swap，没有 chooser 事件；原生 Input/
intercept ACK 与 trusted click 投递证据不足。不能据此归因新目录 setter，
也不能排除本轮变更关联或将其一概视为已知旧故障。

独立复核生产/暂存脚本、SDK、最终 v2 host 身份及真实字节。全套203738ms
连续账本有11次精确激活：四次新窗口创建、一次额外页自然继任、六次旧
fixture动作；四次focus均为原有控制popup，未知事件为零。新窗口两用例
没有window focus，原sentinel保持不变。新建任务tab、窗口及attachment
按各自清理记录消失；混合测试先保留额外非任务页，再由fixture清理它。
不声称所有fixture页或浏览器进程均已清空；host恢复测试主动终止第一代，
第二代正常exit0。旧失败保留，旧发布ZIP未更新且不含本功能，P01–P15
目标不缩小、不标整体完成。

随后同源一次精确 JS opt-in 诊断 `Tu6rks` **2/2、exit0**，未复现 collect
失败，不能称修复。下一步仅在原失败后读取既有 chooserEvidence，确认
原输入是否收到 trusted click；成功前不新增 API 或监听。原生输入表面
尚未就绪仍只是待检验假设，后续结果单独记录。

普通 chooser 失败后观察已接入默认 JS 与 Go 路径，保留单独3秒总预算、
loopback URL/key/variant和原生documentId检查；晚执行不能读新文档。Go观察
在原子进程取消/关闭后的partial读取阶段，JS在原cancel前。主错误不会被
观察、cancel、finalize、close或落盘错误覆盖，冻结Error也保持原身份。
该版本Node1369/1369通过。随后完整 `XHmJdq` 实际 **108/109、exit1**，
原105项名称/顺序全部保留且本轮通过，四项新增通过三项。生产38脚本、
staged39脚本、host和SDK身份与前轮一致；普通chooser均过，观察分支未触发。

唯一失败是后台窗口目录dynamic OOPIF首轮collect；Add frame及Upload click
均返回，arm到cancel约10005ms，chooser和setter尚未开始。root/static的
12轮核验9POST/20文件载荷/272实际字节，8次可信目录选择、一次合成清空、
三项拒绝。连续186630ms的11次激活/四次既有popup focus精确归因，零未知
事件；原sentinel、任务清理和额外页保留通过。目录失败时没有DOM点击或
原生命令记录，不能据此定位投递/interception，也不称普通故障已修复。

因此将同一失败后观察接入目录round：只读原有directoryEvidence、input
token和有界事件摘要，不读取File字节，不增加原动作/重试/监听。六种目录
HTML与先前stage逐字节相同，成功路径与原10秒期限保持；目录parent使用
同一错误保留清理器。最终Node1373/1373通过，包含dynamic collect失败时
observe先于cancel/close、无setter/重复输入及frozen Error回归。真实浏览器
运行与故障观察结果需另记，测试通过本身不证明偶发超时已修复。

该最终代码的专项 `JwX2Bc` **10/13、exit1**：四项新检查全过；JS单次提交、
JS双连接、Go双连接在dynamic首轮collect超时，均无setter。三份自然失败
观察首次成功取得完整证据，分别6/3/5ms，精确root/child documentId+URL
对应且无截断；root各一次可信frameAdd，child clicks/changes均空，输入框
连接、未禁用且无文件。JS观察在cancel前，Go在原子进程取消/关闭后。
该证据只约束失败后的当前文档，不证明点击时身份或down/up序列，更不把
观察complete当作业务成功。后续先调查鼠标序列，不重放输入。

固定Chromium156及CRX源码排除了直接换路由的捷径：child直发可绕过父链
检查后新出现的遮挡，变换/嵌套坐标也不等价；interceptor零观察不能排除
更早stopImmediatePropagation或文档销毁。synthetic tap只等首次renderer
初始化，源码明确仍待命中表同步，且改变捕获/清理语义。保留这些边界，
不据未证假设修改生产；旧发布包保持不变，完整目标继续进行。

显式JS chooser诊断继续增加原页面被动capture的pointer/mouse有界序列：
每文档256条/65536序列化字符、单字符串128字符，保留原目标/节点身份、
坐标、按钮、可信位、documentToken及原事件时间。空序列可完整，缺失、
截断、溢出、安装或记录异常均不完整。只复用原失败DOM读取，成功不新增
DOM调用或上传字段；默认六种HTML与`96d4918`逐字节相同。worker API和
序列化DOM函数在实际执行前检查原3秒deadline，迟到执行不能再读现场。

Node1380/1380、作者及独立定向22/22通过。一次真实`Cq7i08` **2/2、exit0**
未复现；root/static/dynamic原生trace完整，pointerEvidenceExpected=true，
但pointerObservationRequested=false、pointerObservationComplete=null。
该运行没有读到失败时鼠标序列，不是输入修复或新的完整验收。此前专项
`JwX2Bc`独立核13POST/408文件字节与47551ms连续焦点零window-focus；三项
collect失败及其6/3/5ms当前文档观察保持，完整目标继续active。

轻量 `pointer-only` 继续去掉额外原生命令wrapper和预先握手，保留原有被动
native事件trace。失败后复用精确documentId读取的同一3秒预算，固定字段与
容量；单一pointer校验函数由两种诊断共享。未读保持null、缺失/不完整false，
完整失败证据true也不改变原业务失败。Node1388/1388、独立54项通过，默认
及原native诊断12份HTML与`0f90a18`逐字节一致。

真实 `S5wSpZ` 2/2、exit0未复现，三布局6次POST、5份实际文件共97字节核验；
90项来源身份一致，零激活/焦点/豁免，三任务页清理完成。所有pointer观察
均未请求，完整性为null；没有原生命令wrapper，也不能宣称获得Input ACK
证据。随后回到原13项测试上下文，仅目标JS双连接页面启用被动记录，
保留业务错误与验收边界，尚无生产输入修复。

随后新增显式 `pointer-context`，固定原13项顺序并检查缺失/额外/乱序；只在
JS双连接三key安装原被动记录，其余页面保持默认字节。key集合有界且构造
时快照，生命周期不增加probe；单目标结果与全13项业务结果分开。Node
1391/1391、独立57项通过，默认和原native诊断各六份HTML逐字节一致。

同一源码有限三轮 `yLC7OT` 13/13、exit0，`NuEbdZ` 12/13、exit1，`HakXg4`
13/13、exit0。中间轮Go dynamic首轮collect再次超时，原click返回而无
chooser/setter；原取消/连接关闭后的6ms精确文档观察中，root有可信frameAdd、
child无click/change。JS目标三轮未读pointer，完整性null，不能证明生产
输入已修。实际失败路径应成为下一片记录目标，不继续只测成功的JS路径。

独立审计每轮114项当前源码哈希相符、三轮一致；host正常exit0、任务页
清理完成。每轮五次激活都匹配原后台窗口用例允许项、零window focus。
每轮目录13POST/30文件/408字节，中间轮Go仅root/static的4POST/3文件/
62字节通过；dynamic零POST保留为失败，诊断没有获得完整原鼠标序列。

Go目标的 `pointer-go-context` 复用固定13项与有界记录，只更换精确Go三key；
原子进程参数、动作、取消/关闭均不变，parent既有失败读取仍在其后执行。
成功顶层variants与失败callerResult分别只读验证；观察须精确对应唯一失败
项的tab/key/variant。旧JS模式、原fixture HTML和Go helper均保持，作者及
独立定向60/60通过。

生产不变下三轮 `N6jxEP`12/13、exit1，`a95b4d`13/13、exit0，`gx2jRn`
12/13、exit1。MCP/Python分别chooser timeout；Go全部成功且未读pointer。
两失败均只有root/static各2POST、dynamic零POST，缺少点击ACK、完整阶段与
失败DOM，不能定位实际鼠标投递。114项源身份及生产/host/SDK一致，每轮
原五次精确激活允许项、零window focus；五入口加目录41/43/41POST、实际
858/893/858文件字节核验。已知任务页清理通过，失败MCP/Python的精确tab
身份不足另行保留。停止本组三轮，未把目标成功或证据未读当成问题修复。

独立录屏并发修复将root raw start/stop纳入内部渲染队列，frame ACK保持
直通；原总期限不刷新、迟到ACK只更新仍有效的原scope/attachment。实际
native Promise未结算时保留队尾；确认detach后新附件使用新队列，旧Promise
仍列入全局cleanup。旧26项回归24通过2失败，作者及独立定向107/107，
完整Node1416/1416且零skip/cancel。

新增真实双连接 `js-screencast-concurrency`，仅延迟第一次实际截图结果的
交付，300ms重叠窗口不当作queue admission证明。新版`hmPQNY`2/2、exit0，
两张截图及两个更新阶段的原生PNG均核16格nonce像素，公开帧ACK、精确
任务清理和hook恢复通过。旧实现负对照`rjMBXn`1/2、exit1：held期间raw
stop/start已成功，release后的内部stop结束新流，phase1不再收到更新帧。
两轮同harness/host/SDK，生产只切换background；两轮零激活/window focus，
host正常退出。第一次旧对照`QlbMqw`因PowerShell 5错误流提升未落总results，
其partial保留，不作为完整验收；改用直接Node子进程后才取得上述完整对照。
工作树已按原始字节恢复新版；旧发布包不变，动态OOPIF问题仍未解决。

最终默认完整`0prwDM`110/110、exit0，原109项相对顺序核验完整。连续
178702ms账本保留原11激活/4控制popup focus允许项，无新增豁免；sentinel
身份和选择保持，视口高度1222→1192。预期host重启后新进程exit0，当前
没有活测试进程。完整通过不替代此前动态OOPIF失败的根因调查。

### 调用器失败证据完整性

补齐CLI/MCP/Python chooser的partial与原操作阶段：创建tab和arm之前先
登记，保留原点击ACK、collect及取消结果；原业务错误与清理错误分开。
Python即使失败也写相同stdout/独占JSON文件并exit1，成功API、顺序、
参数和期限不变。父级保存真实child close，不能把kill请求或exit当作结束。

所有普通外部调用器失败观察都先校验caller/session、原有序variant前缀、
唯一tab及唯一末尾失败项，再按现有3秒预算读取精确当前documentId。
缺失/错配artifact、未确认close及成功后的close-only错误均零页面读取；
finalize与各连接close仍各自尝试，清理失败不能盖住原异常。生产代码未变。
Node1467/1467、独立定向106/106、普通专项`ulluP9`13/13通过，均无跳过。
最终默认完整`1OmROv`110/110、actual exit0；专项也为actual exit0，独立
核18轮原阶段、36个child close/exit0、原POST字节和精确任务清理。
专项20,048ms连续账本保留原5次精确激活、零window focus。两轮未复现
故障，新增失败读取仅有确定性测试，不能声称动态输入修复；旧包保持不变。

完整独立核110项原名称/顺序和同源制品。193,286ms连续账本仍为11次
原激活及4次控制popup focus，无新增豁免；sentinel身份/选择保持，初始
高度1222、末active查询1165、同份populate快照1204，不能称几何不变。
host按测试重启后新进程exit0，任务清理通过；当前无活测试进程。

### 统一指针诊断与自然故障落点

新增`pointer-all-context`复用原13项上下文：7项可采集、6项显式未覆盖，
18个chooser key及本次目录key精确启用，默认/旧诊断HTML30组字节相同。
成功原API/参数/输入/期限不变；chooser ledger不可枚举，避免被原submission
成功整对象读取带出，失败仍显式读取。Node1482/1482、独立143/143通过。

首次真实`OBaCi6`12/13、exit1，Python dynamic首轮click97ms返回，collect
9772ms超时；cancel和进程实际close后7ms观察完整。父文档14条pointer记录
包含Add序列及IFRAME#upload-frame上的完整move/down/up/click，当前child
为空且无上传；没有据此断言native请求关联或已证明具体路由原因。成功
submission18次CDP读均无新ledger。原POST字节、身份/清理通过；29,089ms
账本仅原5激活、零window focus。取得故障即停止该诊断组，默认`XXyxbu`
13/13、exit0仅为受影响上下文回归。生产输入尚未修复，旧发布包保持不变。

### 按下前目标投递与坐标兼容性

以自然故障`OBaCi6`为依据，普通无修饰单击新增目标投递门禁：原root move
实际结算、原节点收到本观察窗内的可信移动后才提交唯一down/up。共享输入
tracker签发attachment私有ticket，原scope/context/deadline在原生发送前
再次核对；外来Input使ticket失效。只有按钮未提交、前次move已结算时才能
按原actionability节奏重新准备，hover副作用明确保留，按钮提交后不重放。

首候选Node1534/1534、受控`MGOCLU`2/2、普通13项`5MjMV7`通过；完整
`hb2m29`却为100/111、exit1，11项旧frame/form超时，因此候选未发布。
受控禁用门禁的`LORGaK`1/2中首move被合成ACK后仍有按钮与一次POST，
证明的是缺少投递确认顺序，不是复现自然Viz失效。所有原失败保留。

暂存诊断`9FyKTv`2/5仅包装原observe/read，并精确声明被动读取及console
记录对时间的影响。去重原生Runtime历史重播后，三个失败各有21次可信移动
已到原BUTTON，首read全部invalid；坐标偏差超过旧±1条件，未到最终复核。
这不证明具体路由根因，只证明旧近似坐标模型不能作为本地投递判据。

修正采用可信primary mouse pointermove的分数局部坐标及原节点命中证据，
不通过增大固定容差掩盖误差。保留原root点、祖先命中及初末framePoint
一致性；最终同时复核实际收到点与非null预计点击点，防止hover局部遮挡。
DOM事件没有CDP请求ID，仍不能排除同窗用户事件或保证后续按下路由；
force/trial/多击/修饰键和既有transform边界未扩大。

修正后Node1544/1544、专项`Zth7Xv`14/14、完整`FjHwEx`111/111均actual
exit0；所有原失败保留。独立专项核三受控分支的真实pointermove、move ACK
及down ACK→up顺序、唯一POST和导航；drop-all5017ms/13次丢move且零按钮。
七表单21原POST/25,760 UTF-8字节与14次frame保存、7次唯一最终提交一致。
专项零焦点事件；完整212,380ms账本保留原11激活/4控制popup focus允许项，
无新增豁免。负面测试补原planned-point overlay在实际retry中的零按钮，
内存mutant删final status门禁会发按钮，避免提前expire造成假阳性。
完整独立核111名称/顺序、50个生产成员、SDK/host及暂存差异；sentinel
身份/URL/选择保持，高1222→1196，几何变化保留。外部chooser24轮及真实
child close、host预期重启与新进程exit0均确认。此结果不关闭自然Viz根因、
跨平台与完整对齐目标，旧preview资产未修改。

### 多击与显式修饰键

普通clickCount与dblclick扩为同一原deadline内的完整按钮序列。真实move
及目标receipt确认后按1…N逐对await down/up ACK，保留原delay；从首down
提交起不重放。每次后续按下复核原root点祖先命中、原receipt及已观察到的导航，
不重新定位、不移鼠标补救；检查不能锁定DOM或预测未来native通知。

显式modifiers从每attempt设置前保存baseline，以finally覆盖准备重试及
部分设置失败。Keyboard/RawKeyboard透传私票，过期或撤权不补发普通键盘
操作，由原attachment账本清理未知held input。force/trial、已有held
modifiers及hover/drag/raw路径仍保留原边界，整体对齐目标继续。

固定bundle定向45/45、独立bundle/transport/tracker70/70、最终Node
1569/1569均通过且零skip/cancel。新的独立fixture保留旧三分支七份HTML
逐字节相同，21项本地测试包含modifier重试区间负例：漏掉中间抬键和
重新设置不能仅凭最终状态成功过关。首次启动沿用旧selector只执行两项
且通过；该结果不算新增计数验收。修正选择器后`vulf6j`实际3/3、exit0。

四个真实新场景为root双击、同源三击加Shift、OOPIF受控丢首move后双击
加Shift及首击导航后拒绝第二击。8次真实click、3次dblclick和4份唯一
原POST吻合；新文档零后续点击，OOPIF重试有两对独立Shift设置/恢复。
8,860ms连续账本零activation/焦点，host正常退出。该受控丢move不冒充
自然Viz根因；旧preview资产保持不变。

首次完整`NNr3Bp`111/112、exit1；原111项通过，新导航验收在server GET
后立即读取URL而失败。3条真实Input及唯一可信POST证明首击已提交且第二
击被阻止，随后仍为旧文档/loading快照；没有证据表明其后来一定完成。
修正只涉及验收的条件观察，保留原5000ms剩余预算和原输入，不改生产
行为或把旧失败重写成通过。

最终fixture的只读导航观察在原5秒预算内验证新active文档及complete；
外层超时后迟到结果不能更新样本，worker在native API前后核同一deadline，
已发出的读取不能冒充取消。fixture28/28通过。随后发现并修复另一生产
缺口：首击移动iframe时，原local receipt仍可能ready。旧候选三个实际
bundle反例（祖先遮挡、framePoint变化、断开）均漏拒绝，原红证据保留。
后续每次down现在先在原root点重核祖先命中，再由原receipt检查framePoint，
不换坐标、不重选或重放。第三pair、祖先读取期间撤权/到期/换context及
原异常保留也纳入回归。定向50/50、独立75/75、Node1581/1581通过；
transform shortcut与非原子检查限制继续保留。

最终冻结专项`uLGdWq`3/3、完整`WLM6bV`112/112均actual exit0，原111项
名称顺序保留。四场景27条Input逐条ACK和4唯一POST共19723字节经独立
核验；首击导航350ms确认新root文档，原5000ms剩余预算仍有效，目标零
后续点击。专项8283ms零焦点事件，完整212803ms仍只有原11激活/4控制
popup focus；sentinel身份/选择保持，视口高1222→1202。4任务tab已回收，
host预期重启后新进程exit0；无最终debugger target清单，范围不扩称。
生产50成员、暂存允许差异及源/SDK/host身份一致；专项不运行Go表单而
缺少相应hash字段，完整binary仍与原配置/前轮一致。完整和新增场景两份
独立审计互补，不拿新通过抹去旧失败。旧preview不改，完整目标继续active。

### 正式 locator 文件上传

新增三SDK locator `setInputFiles` / `set_input_files` / `SetInputFiles`，
CLI/MCP沿用browserAction。严格唯一真实file input允许隐藏；utility定位后
固定原node/context/frame/child target，原documentToken早于异步describe
捕获。提交复用chooser的DirectoryUploadRegistry，同节点未知ACK不重放；
普通文件、目录双完成屏障及显式清空共用一条提交核心。没有点击、chooser、
scroll或渲染租约。remote handle释放失败保留原entry清理闭包，阻挡新attach，
Pause/显式清理可再次释放，不能把未确认的释放当成功。

三SDK在原scope、排队与总期限内协商`locatorFileUpload=1`；新路径数组有界、
绝对、有效Unicode，客户端不读文件或解析cwd。旧扩展明确拒绝；旧chooser
路径校验保持兼容。独立审查发现省略wire epoch的legacy请求误拒，修正为
同步从已准入ledger冻结epoch；原turn结束/换代仍拒绝，四回归包含root/OOPIF
上传与clear、等待中turnEnded及successor重attach。旧候选确实在三项失败。

新增五入口×三布局真实隐藏input业务夹具，另有独立backgroundWindow目录
路径。原POST bytes、唯一提交、可信上传/合成clear、精确backend node和
原生target、零Input/chooser、外部进程actualclose及任务回收分别核实。
CLI/MCP/Python/Go执行自己的业务；父进程仅观察与核验。目录额外metadata
witness证明完成早于API返回，不把这些witness计为文件业务上传。

最终`tQEVZJ`118/118、actual exit0；原112名称/顺序保留。16唯一POST/17909B、
50文件实例/563B、16原生写/同节点clear与40外部进程actualclose独立核实。
223212ms focus账本仅原11激活/4控制popup focus与1精确目录own-window
首tab激活；sentinel身份/选择保持，高1222→1165。16任务页/targets与目录
窗口回收，旧host预期SIGTERM、新host exit0；51生产/53暂存成员、SDK与
Go源/构建制品身份通过独立审计。Node1642、JS134、Python99通过，Go全包
通过且保留26项平台skip；CLI六平台构建及开发包/Skill打包通过。

首专项`QL84QJ`6/7的目录scope准备错误、旧源专项`Plei2M`7/7与完整
`DSSqzQ`118/118均保留。最终runner修正Go .go源哈希空表，旧运行仅通过
独立构建manifest补验；source-anchor签名同步后四subprocess旧断言恢复。
旧preview保持原字节，未提PR；更多文件frame组合、Codex同组文件/诊断
比较、Page GUID路径及原生恢复等继续开放，不把本片验收当完整持平。

### 元素自身变换的显式 position

单一已解析HTML padding plane采用fractional CSS尺寸和原生padding quad，
经renderer local-root映射处理叶元素缩放、旋转、zoom与有限透视。初始和
hover/后继down几何指纹包含叶元素；hover变化可重准备，首击后变化终止
后继按钮，不重放已提交点击。SVG/非替换inline/fragment仍保留原AABB约定；
hover/drag仅复用初始投影，没有获得click的后置门禁。

旧生产rj4xe2八场全失败、9原POST均误位；最初候选fRwtGy6/8的两OOPIF
严格局部亚像素失败保留。无扩展raw CDP对照也有同类native量化；DPR1
三原点与取整预测吻合，而后续DPR1.5探针没有pointerdown，不能记为通过。
最终分开校验root请求投影与实际事件量化，原热点、节点、可信事件和
唯一正确POST断言不变；不是生产硬编码补偿，也不宣称OOPIF亚像素相同。

最终gQRNO2专项八场通过，3150ms零focus。完整DF0lUQ120/120、actual exit0，
Node1699/1699、零skip/cancel；旧119项名称和顺序保留。新增25Input、8唯一
POST/83571B、11原文档/HTML及八页/targets回收独立核验。227112ms账本
仅原12activation/4controlfocus，无新增豁免；sentinel身份和选择保持，
高度1222→1187。root请求逐轴最大误差0.010545CSS；OOPIF原局部0.173981CSS
与实际root0.256823物理像素的逐轴最大残差保留。51生产/53暂存成员与普通扩展ZIP
逐字节核验；旧preview ZIP未替换。Go/SDK未重跑，既有Go源及八个复用
bin匹配build manifest。更广几何、文件/诊断和平台验收继续开放。

### 变换元素边界框与截图

正式locator boundingBox和元素截图按实际renderer local-root投影native
border四角再求root AABB，修复旧local AABB加iframe原点丢失旋转/缩放的
问题。保留离屏、负坐标、零尺寸和已知无布局null；路由/期限/不支持平面
错误不吞掉。私有locator至dispatcher沿原剩余期限运行真实progress，
有限剩余0/-1不转成无限；截图沿用原progress。公开wire和系统鼠标不变。

旧`6khFx1`五个OOPIF phase错误边界与crop保留，独立边框见证发现仅看
内部像素会漏掉四次。首候选`9QZ5oF`因fixture误判getTargets.type失败，
改为原native target ID/URL/session关联；不改几何/像素阈值或重写失败。
最终专项`yXtuCJ`2/2；完整`iRrKtt`121/121、actual exit0，原120名称/顺序
保持。七场八phase、223原native调用及唯一ACK、零Input、15原文档/HTML、
八PNG/118442B原字节/CRC/十像素见证和精确任务清理均独立通过。237085ms
focus仅原12activation/4controlfocus，未增豁免；sentinel身份/选择保持，
高1222→1190。Node1723/1723无skip/cancel，51生产/53stage与源码重建相同，
普通ZIP逐成员核验通过，旧preview保持。Go/SDK未重跑，沿用build manifest
核原49源/八bin。跨renderer退化、广泛透视/DPR、非原子及best-effort handle
释放限制保留；本片真实browser仅证明所列affine场景，完整目标继续。

### 拖放提交与原生清理

普通dragTo固定原source/target，复用可信准备move及原几何；仅down前允许
重准备，提交后失败不重放。目标在原生over后与drop事件时复核，原文档
guard覆盖individual transform、border/padding原点及祖先/viewport变化。
捕获指针保留合法source投递。私有ticket贯穿mouse与DragManager，原
attachment登记实际guard及迟到异常对象；HTML dragCancel确认后才清理
按钮。固定lease逐条native核剩余预算，已确认cancel/release不重发。

原生产`WUVqsn`确有错误source业务POST及replacement drop；七场中间版
`7ZpaaO`新增非中心热点后暴露两项同AABB误投，原错误POST字节保留。
首候选公开void契约错误、中间完整旧timeout断言失败也保留，最终要求
按下后原目标丢失为明确terminal错误、唯一source down及零drop。

最终专项`rxSklf`2/2、完整`I0B25O`122/122均actualexit0，旧121名称/顺序
保留；Node1788/1788零skip/cancel。十场/12原文档、110记录native调用及
唯一ACK（77Input、11guard生命周期）、5正确POST/完整28633B及五拒绝零
业务提交独立核验，10任务tab/12 fixture URL回收。专项4328ms零focus；
完整237777ms仅既有12activation/4controlfocus，无新豁免；sentinel身份/
选择保持，高1222→1165。51生产/53stage同源；最终普通ZIP仅一处notice
范围说明较实跑更新，其余50成员相同。旧preview未改，Go/SDK未重跑，
49构建源/8复用bin按已有manifest核验。

正常500ms清理预算区别于原action期限。force/trial/PW预持输入保留继承
分支，其他tracked held/unconfirmed输入由admission拒绝；检查非原子，
捕获释放可触发业务。持guard时worker丢失后的恢复尚未实机验证，保留
guard可能影响人工drop；更广CSS/跨文档及P01–P15仍开放，不宣称全面持平。

### SDK连接身份审计与后续计划

拖放实现`27843a1`已推送到fork，远端与本地一致。随后只读检查SDK实际
重连路径，JS当前TS/dist逐字节一致；6项Windows原生named-pipe对照通过，
EOF/显式close后替换端点收到带旧scope的新RPC。生产ControlLedger同session/
epoch条件接受、未知session和不同epoch拒绝；真实tab归属和incarnation
仍是必要门禁，未执行真实浏览器误操作验收。更新已过期的MCP技术债条目，
新建三SDK连接身份计划；本次未更改SDK生产行为，整体目标继续。

### SDK连接身份修复与真实恢复验收

本次SDK连接身份修复：三SDK的client及handles固定首次实际连接，EOF/丢弃
stream/close后终态。后续有效调用报`OBU_SDK_BROWSER_DISCONNECTED`，原在途
错误保留；首次从未连接成功允许重试。新client/handles与明确新turn才能
恢复。完整RPC错误、本地编码及发送前预算失败保留健康stream；JS健康
socket响应timeout仍可继续，Go/Python wire timeout丢弃stream后终态。
交叉审查补修Python本地预检与迟到factory，未扩展线程安全承诺。

真实Windows pipe反例：Go A/B同时live且active切换时健康client仍在A，
A断线后旧实现才迁移B；保留实际解码请求。Python旧四组各13条旧scope
请求到B，修复后零条且fresh恢复；JS连接身份专项17项旧12fail、新全过。Windows
Node1792、JS142、Python110全过零skip/cancel，Go519 test/subtest通过，
26平台skip及8无测试helper包编译通过另记，workspace typecheck通过。

真实专项`aZMiIx`4/4、完整`yVGT4D`125/125均actualexit0，旧122名称/相对
顺序一致。三SDK各EOF/close两场逐原HTML/POST/RPC字节、document token、
四入口拒绝、旧零click、fresh唯一可信点击、actual exit/close、relay
两端close及精确任务回收独立核实。实机relay仍连同一backend；跨实例
碰撞是原生IPC证据，未声称真实浏览器误点击已复现。

专项2753ms零focus/activation；完整244620ms连续16事件均匹配原12activation/
4controlpopup focus，SDK六场零事件，新增零豁免。sentinel身份/选择保持，
高1222→1165；原host重启测试SIGTERM、替代hostexit0。9新Go bin/50生产
构建源、10 JS产物与当前TS编译、15 Python源码独立匹配；40扩展runtime
hash与旧完整一致，41stage仅原adapter动态地址变化。旧preview三ZIP按
原checksum确认未变，未创建PR。原始审计报告hash前缀为专项f55fc11e、
完整15d356d7；边界见[SDK连接身份](../../references/sdk-connection-identity.md)。

Linux WSL2 Ubuntu真实Unix socket补验Go523pass/10平台skip、JS142/142、
Python109pass/1 Windows路径skip，全新host、helper与JS重建通过，外层及
六子命令actualexit0。186源码/测试及20重建dist匹配，Python四组替换端
零旧请求、新client恢复。首次临时目录被环境清空的启动失败保留，后续
新持久短路径一次完成；未跑Linux浏览器、macOS或CGO race。

### 📁 Files Modified

- `internal/transport/`, `internal/host/`, `cmd/open-browser-use/`
- `packages/open-browser-use-go/`, `packages/open-browser-use-js/`
- `packages/open-browser-use-python/`
- `apps/chrome-extension/`
- `docs/product-specs/browser-use-parity.md`
- `docs/exec-plans/active/2026-10-10-browser-use-parity.md`
- `scripts/browser-integration/`
- `scripts/patch-frame-geometry.mjs`, `scripts/patch-pointer-delivery.mjs`
- `scripts/patch-drag-delivery.mjs`, `scripts/patch-media-source.mjs`
- `scripts/build-chrome-extension.mjs`
- `docs/references/shared-research-workflow.md`
- `docs/references/element-position-geometry.md`
- `docs/references/transformed-element-bounds.md`
- `docs/references/drag-delivery.md`
- `docs/exec-plans/completed/2026-10-12-drag-commit.md`
- `docs/exec-plans/completed/2026-10-12-sdk-connection-identity.md`
- `docs/references/sdk-connection-identity.md`
