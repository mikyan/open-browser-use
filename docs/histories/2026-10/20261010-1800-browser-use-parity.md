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

### 📁 Files Modified

- `internal/transport/`, `internal/host/`, `cmd/open-browser-use/`
- `packages/open-browser-use-go/`, `packages/open-browser-use-js/`
- `packages/open-browser-use-python/`
- `apps/chrome-extension/`
- `docs/product-specs/browser-use-parity.md`
- `docs/exec-plans/active/2026-10-10-browser-use-parity.md`
