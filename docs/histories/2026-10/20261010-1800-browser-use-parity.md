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

### 📁 Files Modified

- `internal/transport/`, `internal/host/`, `cmd/open-browser-use/`
- `packages/open-browser-use-go/`, `packages/open-browser-use-js/`
- `packages/open-browser-use-python/`
- `apps/chrome-extension/`
- `docs/product-specs/browser-use-parity.md`
- `docs/exec-plans/active/2026-10-10-browser-use-parity.md`
