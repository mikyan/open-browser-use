# 显式隔离浏览器会话

## 目标

为用户增加一个显式选择的独立浏览器会话：Agent 可运行页面、打开原生子页，
用户可查看实时画面与现有 AI 光标、点击和元素高亮，并能暂停或结束任务，
不会占用系统鼠标。它是完整 Browser Use 目标的一条新部署路线；普通已登录
浏览器的后台弹窗焦点问题仍按原计划处理，不能被此模式的结果替代。

## 2026-10-23 独立 Agent 多页研究（有限任务验收完成）

2026-10-23，[Managed 独立 Agent 多页研究](../../references/managed-agent-research.md)的原六阶段及独审通过，
正式 managed 运行 `mra-Ldr4sE` 实际退出 0，67/67 项定向检查通过。两轮各读六份
当前来源并唯一提交报告，保留原 blank 页与前轮报告；四次真实 viewer 解码及正式 Stop
清理完成，29 个原进程退出。此结果只覆盖固定 Windows 的有限采购研究任务；旧 24 次
比较的分母与失败不变，未作同材料 Codex 比速，P15 及整体能力目标继续开放。

两轮业务用时分别为 55.998 / 58.014 秒，原 900 秒业务与 60 秒清理预算保持不变。
记录器准备失败和联合 viewer 原页清单断言失败均保留，分类与独审证据见专题；
本片未改变生产代码，也不证明浏览器进程重启后恢复或普通公司 Edge。

## 2026-10-23 恢复后的完整任务接续

[专项已完成](../completed/2026-10-21-worker-recovery-continuation.md)：固定浏览器经历
真实 worker/Native 替换后，显式恢复保持暂停，人工 End 后一次 Resume，新 SDK/新轮次
认领原结果并完成独立后续确认、再次交付和正式 Stop。48 项定向检查与六阶段真实
流程通过；原失败 61 项、成功流程 74 项独审留存。生产与最新 `preview-20261021-afb415a`
相同，本轮仅补验收。输入中断、浏览器进程重启及完整对齐不据此关闭。

## 2026-10-18 用户要求的新包

用户再次明确要求打包，已从干净提交 `853ea9211b15ccdebe84dd3fe0df955853b80a0b` 发布 [preview-20261018-853ea92](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-853ea92)，首次将已验证的 worker 替换恢复放入 Windows 包。
离线 CLI/MCP 30 工具、独立制品 8,437 项检查、4 个资产回下载及 103 个本地文件校验通过。
完整包/扩展/Skill 分别为 99/72/6 文件。本轮未重跑网页业务；发布 EXE 单独重建，原始功能验收和失败证据保留。
下一轮 workflow/OS 观测脚本及 Skill 草稿未纳入本包；完整能力对齐仍未结束。

## 2026-10-17 同 worker 的 Native 连接恢复（限定流程已验）

当前源码保留同一原 Browser、profile、worker target/context/workerBootId，在
Native host 退出后由用户显式 `managed recover` 重新连接。原结果 tab、target、
document 和页面内容必须保留；不重新打开 URL，不重放业务或输入。恢复成功后
Agent 仍暂停，新 viewer 使用新地址和一次性票据。真正 worker 替换后的结果
权限恢复不在此片，当前仍拒绝；展示标记不能升级为控制权限。

- Module `managedbrowser.Session` 分离 Browser 生命周期与 Native 代次，
  以 `RecoveryStatus`、`Changes`、`Recover` 为管理 Interface。每代保留原
  进程句柄、creation time、descriptor、binding 与退出回执；Native 退出转为
  degraded，Stop 始终关闭原 Job。恢复失败不能丢弃已启动资源。
- 扩展在 managed Native 断线时同步暂停准入并完成原资源清理。旧 channel
  只有 cleanup-only 退休入口，可等待原真实释放，不能再执行普通操作。新
  Native Port 挑战原 Browser 后仍核验原 worker/context，保留暂停状态。
- CLI 管理 pipe 保持原 runId，在 degraded/recovering 时不交付任务 endpoint。
  旧 controller 与 HTTP viewer 实际退休后再建立新 viewer，全部就绪才发布
  新 Info 与 URL；view 不隐式恢复，Stop 取消恢复并等待原资源结算。
- Viewer 将原 backend 的实际关闭回执作为全通道退休的 Seam，不把已失效
  backend 的普通 `select:null` 拒绝当作资源已释放。未知回执仍阻止恢复。
- 验证包括代次/旧权限/错误 worker/未确认清理的定向反例，以及固定推荐 CfT
  的独立原流程：一次提交并 finalize，先确认原结果查看与人工 Begin/End，
  再按已持有的原 Native 进程句柄断开、显式恢复、核验原页面及旧票据拒绝，
  最终 Stop 核对每代 Native、原 Browser、Job 和注册清理。原失败报告保留。

首轮 `managed-native-recovery-LPY0ZE` 实际 exit 1：原唯一 POST 和 finalize
成功，随后原结果页只读 select 失败，因此尚未注入 Native 故障或执行恢复。
原文档、草稿、receipt 保留；正常 Stop、browser/native exit 0、Job 清理与
停止后独审通过。该结果不能计为恢复通过。

固定版本官方源码确认 CfT 155 的 screencast metadata 没有原生捕获
`monotonicTimestamp`，其 `timestamp` 是构建 metadata 时的系统时间，不能
代替现有 TimeTicks 屏障。此前结果页/人工接管验收使用 Chromium 156，155
安装验收只覆盖普通实时查看。保持捕获屏障，升级推荐版本至固定兼容 156；
缺少能力时提供明确用户错误，同时保留实际 ACK/stop/detach 清理义务。
旧版本共存安装、推荐版本真实安装与限定恢复验收已完成，详见下方记录。

后续 `managed-native-recovery-4J5sp6` 在 CfT 156.0.8078.12 已显示原结果并完成
首次人工输入及 End，测试随后错误地读取 public API 未暴露的 `cleanupPending`
而实际 exit 1。原 public 回执已有 `viewerCleanupComplete: true`、原租约清理
确认和 paused 状态；测试须使用正式字段。原记录保留，尚未注入故障或执行恢复。

`htYjeo` 在同一冻结生产构建通过该基线后，因关闭 viewer 页面后观察器未收到
WebSocket close 事件而超时，实际 exit 1。测试改用已有正式 `managed view`
入口等待原 reader、workers 和清理完成，再签发旧代次的未消费票据；页面关闭
回执与观察器是否收到事件分别记录，不伪造事件。原失败保留，生产代码未改。

最终 `managed-native-recovery-A6UPE3` 六步实际 exit 0：唯一原 POST 和 finalize，
15 项原人工输入回执、17 原帧、两次 Begin/End、旧查看器真实清理屏障均通过。
终止一次预持有句柄的原 Native host 后，显式恢复发布第二代 Native/controller/
viewer；原 Browser、worker/context、target/document、草稿、receipt 保持不变。
旧未消费票据在旧 listener 和新 listener 均被拒绝；新 viewer 保持 paused，
只修改原结果的本地备注和一次 review，没有 Resume、再次 POST 或 URL 重开。
原故障 exit 4294967295 及错误文字保留且有 exitConfirmed；第二代 Native、
Browser、supervisor、viewer 均正常退出，Job、注册和 endpoint 清理通过。
原结果 SHA-256：`0c1b90c272f9bc92a75c5758728ac0b54edbb951eb2b4e7d7212ba5be79cc74a`。

完整 Go test/vet/build、扩展恢复测试及完整旧基线、改动的人工模块 70 项、
runner helper 9 项通过。生产安装/离线复用与升级独审确认旧 309 文件不变、
新 305 原文件与官方 ZIP 一致；完整恢复后缓存 status/reuse 仍离线通过。
旧 viewer 历史清理失败先于 Native loss 通知的竞态已用红绿反例修复：等所有
HTTP/WS 工作结束后，仅同一已失效 backend 的真实完整退休结果可结算原义务，
历史错误保留，活 backend 和未知清理不放行。完整能力对齐仍开放；本片未重新打包。

停止后独审 9 组通过，20 张 PNG 完整解码，30 个原进程身份均已退出；5 份原
lifecycle 字节、两代原 Native 回执和注册/pipe/endpoint 清理均匹配。
独审 SHA-256：`421267e9d1ba316adff641a629c74325c875d4511d5cb577017215f0c8e35e2b`。

### 2026-10-17 用户请求的新包已发布

[preview-20261017-a4e6b0c](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-a4e6b0c) 从干净提交 `a4e6b0cb5142d7e34c94c2857e4420ce28804a61`
重建，包含同 worker Native 恢复和固定 CfT 156.0.8078.12。离线 CLI/MCP 30 工具、独立制品 5,510 项检查、4 个发布资产回下载哈希及本地副本核对通过。
完整包/扩展/Skill 分别为 98/71/6 文件，499 项源码输入逐项匹配。
原发布 EXE SHA-256：`0db5e597ed164bc356d348245eccfcfe93eac2d393a47a9d6879bc213b5de0b7`。
制品独审 SHA-256：`4bf6d55f5313d3c932d2910870369897a123f456563f1bcb7d2e92890bc4482d`。
本轮只打包，未重跑网页业务；原验收与全部失败记录保持独立，不新增功能通过声明。

### 真正 worker 替换后的显式恢复（限定场景已验、已入 853ea92 包）

853ea92 新包已包含此能力，旧 6588984 包不包含。当前源码保留原 Browser/profile/result target/document，分别验证原
执行上下文终结、新 context uniqueId/workerBootId 和新 Native 绑定；targetId 可能
复用。worker 死亡不能替代截图流 stop/detach 或 held-input 释放。先实现无遗留
输入风险的恢复，并为活动只读查看取得原目标实际清理回执；持键、指针或未知
输入风险继续阻断，由 Stop 等待原 Browser/Job 退出。扩展新增绑定 run/
incarnation/原文档的持久候选记录和启动暂停门禁；旧 task、human lease、viewer
票据不恢复，不重开 URL 或重放输入。最低真实验收包括原页 worker 替换正例及
held-input 恢复拒绝负例；以下记录实际实现、失败及最终限定验收。

实施契约（2026-10-17）：

- `ManagedResultJournal` 单独管理原结果与只读查看附件的持久记录，IndexedDB
  事务以 run/incarnation/journalId/workerEpoch 约束所有写入。新 worker 只加载
  隔离候选，不凭展示标记或空内存状态恢复权限。原 Go controller 保存首次可信
  open 的 journal 身份；替换握手核验该身份及 fresh nonce，不允许丢失记录后
  重新创建空 journal 并冒称原资源已清理。
- finalize 在原 ending fence 内等待 durable commit，事务完成是结果交付的
  线性点，随后同步发布；丢失返回值不等于事务未提交。任务重新取得页面前等待
  持久撤销，原结果授权导航后的 currentDocument 必须在新代画面前持久更新。
  旧 writer 的迟到写不得覆盖新 epoch。同 worker 观察的撤销立即禁用；已经
  持久提交的撤销不因位置返回复活。强制结束前尚未提交的事件，不宣称其完整
  历史可跨崩溃保存；新授权仍须通过下面的原 lineage 和当前身份校验。
- 显式 recover 对原已提交 lineage、当前精确 target/document/placement 和当前
  网站策略重新授权，返回新 deliveryId；旧 deliveryId 始终无效。此授权不声称
  能证明 worker 停止间隙没有瞬时移位；它不是旧 capability 的延续。
- 只读 view 在 attach 前记录 intent、实际 attach 后记录确认；新 worker 只用
  原目标记录执行 stop/detach 并等待真实 ACK。未知 attach、未知输入或原清理
  未确认继续拒绝。不得补发 keyup/mouseup 来猜测业务状态。
- Go 将原执行上下文终结证明、旧 Native 真实退出、原传输退休和原页面资源
  清理分开记录。新上下文与 boot 必须不同，targetId 允许原生复用；socket 断开、
  flat session detach 或新 worker 的空 tracker 均不能替代这些证明。所有失败
  候选仍由原 Session/Job 持有，Stop 取消并等待实际结算。
- 未知人工输入阻断恢复时，新 worker 仍可能自动建立 Native 连接。Session
  必须独立观察原私有 run 的候选，只经原 Job、确切程序和真实进程句柄登记
  清理归属，不 bind/open 或提供任务权限；Recover 复用同一归属登记。Stop
  等待原观察、进程和 Job，再清理已确认的 descriptor。未持有过的已退出
  未知记录不能凭路径删除；短命进程的完整观察覆盖仍须独立证明。
- 正向验收保持原唯一 POST 的结果只读 view 活动，真实 stop/start 原 worker 后
  显式 recover，保留原 document/receipt 并人工追加内容，不再 POST。独立零业务
  held-key/pointer 负例须持续拒绝；原位置变化负例拒绝旧结果且不自动搬回。
  固定正式 EXE/扩展后再执行；失败原样保留。本片不自动发布新包或创建 PR。

2026-10-17 接续状态：用户要求的新包已作为 `preview-20261017-6588984`
交付，生产功能与 a4e6b0c 相同，排除了本节 WIP；文档提交为 0ca41a6。
本节继续扩展 journal/backend/bridge 接线、Go recovery/清理归属和真实双场景
runner。既有 journal 9 项、Go exact-context 反例和 runner helper 8 项只证明
各自局部行为，不能代替完整接线或实际 worker 重启验收。

2026-10-18 接续：本节接线后的完整扩展测试 2,071/2,071、Go 全包 test/vet/build、
三份 bridge fixture 核对及 runner helper 10/10 已通过。旧的 27 项扩展失败保留；
修正的是测试 fixture 的显式准入、真实结果登记器和策略写入期间的拒绝断言。
另用先失败后通过的三类反例修复 journal 结构检查抛错后缺少 abort handler、
导致原事务永久等待的问题。Native observer/Recover 共用句柄；未知 held input
仍拒绝恢复，但 Stop 等待观察、原 Job 和新 Native 的实际退出。既有历史故障
退出不改写，也不冒充这次 Stop 清理失败；Stop 期间新增异常仍报错。

首个真实 `managed-worker-recovery-result-8COMjs` 实际 exit 1：初始 bridge open
失败，零 fixture 请求，尚未发生 worker 故障或恢复。原 Browser/Native exit 0、
Job 清空和正常清理已记录。Chrome 日志显示 IndexedDB 的 LevelDB manifest
创建失败；原 manifest 绝对路径长 262 字符。随后 `wrd-anHKur` 同冻结 EXE、
扩展和 CfT 的短目录零业务对照 actual exit 0：181 字符 manifest 实际创建、
journal epoch 1 和 ready 确认，随即正式 Stop、原进程及资源清理通过。该对照
支持此固定环境的路径长度诊断，不是 worker 恢复验收，也不宣称任意 Windows
配置的统一长度阈值。Go 另补 15 个固定生命周期错误码，保持不输出任意浏览器
消息、堆栈或通道凭据；新冻结构建的 Go 全包 test/vet/build 通过。

缩短测试目录后的 `mwr-r-uxaaTx` actual exit 1：原唯一 POST、finalize、活动
结果查看和真实 worker stop 均完成，原执行终结和 Native EOF exit 0 已确认。
浏览器随即自行发出 `starting`，测试原先要求等显式 Start 的假设失败；未执行
recover。原正式 Stop exit 0、Browser/Native/Job 清理已记录。原诊断 worker
连接已由 helper 关闭，失败后的重复观察另报 Diagnostic CDP closed；该错误
也保留。测试已分别记录浏览器自动启动和必要时的一次显式 Start，两者
均须有原 stopped、新 running、新 context/boot 和新 Native 的实际证明；
12 项 helper 反例及四文件语法检查通过，自动路径不伪造人工 Start 时间。

随后 `mwr-r-awiD3K` 正向六阶段 actual exit 0：保留原唯一 POST 和结果文档，
真实 worker 替换后明确 recover，原只读附件取得 stop/detach 回执，新 delivery
及查看器保持暂停，旧权限拒绝；新人工接续不重复提交，正式 Stop 通过。
这是正向有限场景，尚不能替代独立 held-input 负例和停止后独审。
`mwr-h-DSpGDB` 前五阶段通过、最终 actual exit 1：原 Shift/鼠标按下保持不变，
recover 正确拒绝，未补发 release 或重放输入。最终原 Browser、两代 Native
均 exit 0，Job 归零且 controller 取得 session-terminated 回执，但 runtime
无条件保留停止前“等待原 Browser 退出”的错误，使 Stop/supervisor 返回 1。
该产品缺陷及失败证据保留，正在区分预期的暂时等待与真实清理失败。

最终修复用确切的 pending-owned-exit 错误区分等待：只有原 Session 和同
controller 最终清理均成功才消除该临时错误；其他失败、超时、包装或组合错误
保持。11 场景及真实 WS 生命周期反例先红后绿，原会话终止仍不授权恢复。
另一次只读审查复现 detach 后、journal finishView 提交期间接纳晚到原帧的
清理竞态：旧源正式回归 4 项中 1 失败。修为 detach ACK 后同步封闭原监听，
排空已接纳 ACK 后才删除 view 义务；相关 111 项通过。未知 ACK 保持拒绝。

最终冻结 v3 的 Go 全包 test/vet/build、扩展 2,075/2,075 与构建均通过，
输入前后哈希一致。扩展验证驱动首次在测试已 exit 0 后因 Windows 输出编码
失败，未生成构建或完整 manifest；保留该日志，修正驱动并在新目录完整验证。
三份跨层 fixture、UI 54 项和 runner helper 12 项的既有通过记录仍单独保留。
最终两个独立真实场景各六阶段 actual exit 0，均使用浏览器自动启动路径：

- `mwr-r-esLC1h`：同原 Browser/profile/页面与唯一 173 B POST，原只读 view
  活动时停止 worker，新 context/boot/Native 后显式恢复，新 delivery/viewer
  保持暂停，旧权限拒绝，9 项人工输入接续且不重复提交。11 原帧、3 张截图；
  正式 Stop、两代 Native/Browser/viewer/supervisor exit 0，Job 与资源清理通过。
  停止后独审 12 组通过，670 源/运行输入与验证来源核对、14 PNG 完整解码，
  32 原进程身份现时退出；一个额外 favicon GET 单列，不算业务重复提交。
- `mwr-h-Fv7gx8`：独立零 POST 场景，原 Shift 和指针按下经 3 项真实输入
  ACK 确认；worker 替换后恢复持续拒绝，四次原文档观察事件不变，无补发
  release 或输入重放。正式 Stop 与 supervisor exit 0，原 Job、Browser 及
  两代 Native 清理通过，controller 的 session-terminated 不变成恢复权限。
  停止后独审 8 组通过、4 PNG 完整解码，31 个去重原进程身份现时退出，
  双注册、两条私有 pipe 和 endpoint 清空；构建与运行输入一致。

正向恢复报告 SHA-256 `bf69cd50c50e8ec5d6ca047e9646507cbf9b58ec0bbb68eca962f1eb6b47804d`，
held 报告 `16e229ce3de9cf5099ea9dc503065226006919dbc434ffe7de14af95ff17555c`。
正向/held 独审 SHA-256 分别为
`65db2dd170e28277b6f98217c77c3fa1803cd60a4742ad14dcbb09aa5e6ebec0`、
`ee490e5b4dcae80b052d984195c61ef71f939958e8b29ee666295cb122de2024`。
真实清理依据为生产 typed 回执及原 target attached 前后读数，不称独立逐条
CDP 抓包；后续 placement 在 runner 断言中比较，未另存每次原始快照。输入
不重放的文档证据截止于 Stop 前，不能观察已销毁文档。当前路径校验包含
windowId/groupId/pinned，不证明完整停机事件历史或 tab index；详细边界见
[worker 恢复契约](../../references/managed-worker-recovery.md)。

用户的重新打包请求已由上一轮 `preview-20261017-6588984` 完成。本次上下文
恢复时短暂误读历史请求，只生成了未执行的打包草稿；没有新制品或发布。
上述为前一轮状态。2026-10-18 用户再次明确要求打包，已交付本页顶部的新包；
后续开发不因此自动重打包，完整能力对齐仍未完成。

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
   用户随后再次要求打包，已交付 `preview-20261017-f2d3421`，运行功能与
   dde4d40 相同；隔离构建、离线检查、制品独审和上传回下载校验通过。
   开发中的 viewer/control 未入包，整体目标继续开放。

## Module 与 Interface 决策

### 独立浏览器的获取与默认选择（2026-10-17，限定流程已验）

上一目标轮提交 `c88d419` 并核对 fork，完成真实下载和启动身份修复，属于
实际进展。本轮核对现状后优先补使用门槛：Windows 包虽不需要 Go/Node，
`run/setup` 仍强制用户自找兼容浏览器，`run` 另须手填扩展目录。

- 新 `managedruntime` Module 只负责显式安装、离线检查及推荐 runtime 路径。
  固定 Chrome for Testing win64 `155.0.8059.84` 和审核后的 ZIP SHA-256；
  不在每次启动时查询浮动 Stable，也不选择日常 Chrome/Edge 或用户 profile。
  官方 [CfT 下载目录](https://github.com/GoogleChromeLabs/chrome-for-testing)
  与版本元数据用于确认唯一下载来源；本地摘要不冒称 Google 签名。
- `managed browser install/status --browser-cache ...` 提供正式 EXE 入口。
  Install 校验有界 ZIP 和完整文件摘要后原子发布；取消/失败不能发布半成品。
  只清理本次创建的 stage，已有损坏版本不覆盖，未知目录或 reparse 路径拒绝。
- `run/setup` 可省略 browser-path，从已安装的推荐版本离线选择；显式路径
  优先且不触碰 cache。`run` 省略 extension-dir 时只找 EXE 相邻 extension。
  缺失时给出可执行的安装/参数指引；浏览器选择不隐式下载或修改既有 profile。
- 用生产安装入口实际下载，再以同一 EXE 和所得浏览器验证默认选择、正式
  Native Messaging、原页面业务/实时帧和实际退出。离线状态/优先级、损坏、
  截断、取消、越界 ZIP 和并发安装用接口测试验证，不以 mock 代替实际启动。

同 worker 的 Native Port 恢复与跨 worker 结果页恢复已经只读分析，仍为后续
工作：旧 controller 永久绑定原身份，native 退出当前会终止原浏览器；展示
marker 不足以恢复用户权限。本轮不同时修改恢复协议。用户随后明确要求“再打个
新包”，因此本轮安装与默认启动验收后制作新的 Windows 预览包；不创建 PR。

实现与验证已完成：runtime 专项 60 条通过记录、CLI 8 组定向、Go 全包/vet/build
通过。Windows 目录替换负例发现 Lstat 的 file ID 延迟读取会误认同名替代目录；
改用原打开句柄 File.Stat 捕获身份后原负例通过，修前日志保留。
生产 EXE 的首次 install、离线 status 和重复 install 均实际 exit 0，进程 PATH
仅保留 System32；305 个原文件共 455,706,289 B 与独立 ZIP 清单逐项相同。
正式 `managed-viewer-7dxhON` 四步实际 exit 0：从全新 cwd 省略浏览器/扩展参数，
自动 Native binding、38 张实时帧、原生子页唯一 POST、Pause/Resume/Stop 及原
browser/native/supervisor 正常退出均通过。原始 lifecycle 字节和 uint64 保留。
此轮未运行可见 setup、普通公司 Edge、真实登录或重启恢复，不计为完整能力持平。

首轮运行后独审发现 Chrome 在 EXE 旁新增 `Dictionaries/en-US-10-2.bdic`，
原 305 文件未变，但正式 status 实际 exit 1。失败审计原样保留；按该版本
Chromium 的 Windows 路径实现，只额外接纳确切目录直接子级的普通单链接
locale-version.bdic（BDic 头、64 文件、单个 32 MiB、合计 128 MiB），不删除
字典、不把运行数据计作原 ZIP 成员；原 manifest 文件优先严格校验。
修后 runtime 75 条通过、Go 全包/vet/build 通过；新缓存生产安装和正式
`managed-viewer-1wBVEd` 四步实际 exit 0（40 帧、唯一 POST、正常退出）。
运行后 status/install-reuse 离线通过。停止后独审 10 项与 47 PNG 完整解码
通过，原光标及目标高亮已目视确认。新包以此修后源码为基线。

用户请求的新包 `preview-20261017-81cfdae` 已从干净提交发布到 fork，包含
安装、字典兼容和 c88d419 启动修复。离线 CLI/MCP 30 工具、独立制品 5,488
项和四资产回下载哈希通过，完整包/扩展/Skill 98/71/6 文件；本地副本一致。
发布 EXE 单独 trimpath 重建，没有在发布 EXE 重跑网页业务。旧7dxhON失败
审计和原生产 status 拒绝保持原样，不以新版通过覆盖。整体目标继续开放。

### 正式隔离会话的原文件下载（2026-10-17，限定流程已验）

上一轮已交付 `preview-20261017-d0605b1`。本片验证正式 `managed run`
自动建立的真实 Native Port/Browser binding 能否交付原网页文件，并真正取消
正在传输的下载；它不触发重新打包，不替代暂缓的普通公司 Edge 人工安装验收。

- 复用现有生产原文件路径接口及默认网站策略，不改下载目录、不用测试 Port
  adapter，也不由 URL 重新下载。只读隔离 profile 的首选项或当前用户的 Known
  Downloads 目录，作为独立路径边界，不枚举该目录中的其他文件。
- 一次有限真实流程包含根页面、原 OOPIF、ready 后才创建的 OOPIF，各自的
  原 POST/Blob 下载；随后各做一次在途真实取消和只取消 waiter 后原传输完成。
  每个尝试固定原 scope/tab/target/frame/GUID，保留一次性请求、原生事件、
  公共 API 回执与原文件字节。外部 session 的路径/取消请求必须拒绝。
- proof Module 管理原请求证据，runner 管理正式启动、冻结源码身份和原退出。
  仅在原文件字节与文件身份已证明后清理确切文件；失败留下已取得的原证据，
  不重放业务。实际取消须在 Stop 或 fixture close 前证明传输已关闭且未完成。
- 本片没有捕获 Native Port 私有 RPC 的原始传输，不把公共取消回执或 Page
  事件表述为完整 Browser 私有命令 trace。停止时仍独立保留原 lifecycle 字节、
  Browser.close、进程退出、Job、注册和 endpoint 的实际证据。

先做脚本定点检查与独立预审，再运行固定 Chromium 的隔离验收。只有真实
行为暴露缺陷时才修改生产代码；本片通过也不代表所有下载、平台或完整能力对齐。

首轮 `managed-download-IGwZHd` 实际 exit 1，在下载前启动失败：user CDP
事件身份/协议校验拒绝。原 binding 已成功；约 2.7ms 后关闭浏览器，原
Browser.close、browser/native exit 0、Job=0、注册和 endpoint 清理均有回执，
没有强制结束或业务请求。报告 SHA
`a0285d20aaec06451e66bd3928c1409b4252fb5003085e1b433c265fce31b34a`。
runner 的补充 Stop 在已结束 supervisor 上返回失败，照实保留。

只读检查发现 UserController 的确定调度窗口：reader 收到原 attach 回复并
唤醒调用者后，可在调用者发布 `sessionID` 前处理后续 scoped event，将它
误判成 foreign。原失败没有保存具体事件，所以该窗口尚不能视为首轮已证
根因。先构造确定性反例，再把原回复的身份接纳收进 reader 的同步结算边界；
只允许原 pending 回复授予 session，foreign event 继续拒绝，不重试 attach。
补充固定类别的事件诊断，不记录原 payload、通道密钥或任意错误文本。

该确定性反例先失败，原回复同步接纳修正后通过；晚回复、取消后原 detach、
错误 session、锁序和诊断脱敏边界通过。Go 全包/vet/build 已通过，168 项
输入在验证前后保持一致。新 EXE 的后续两轮还暴露了验收脚本假设：
`CGCzdj` 将 CLI 多行 JSON 按单行解析，未执行下载；`a1GGbR` 完成两项 root
下载并取得原 OOPIF 文件后，错误要求 root frame tree 包含 remote child。
该轮 Stop 原回复为 `{runId,state:"stopped"}`，脚本却检查 `stopped:true`。
这两轮均保留失败及正常原退出证据；三个已确认字节/身份的文件后来逐个
精确清理，另存清理回执，不修改原报告，也不将失败案改成通过。
修正后的 proof 在点击前读取原 OOPIF attachment 对应 session 的原生树，
runner 按实际 CLI 对象核对原 runId。

修正后的 `managed-download-LWwtqG` 五步实际 exit 0：8 个原始尝试，6 个
root/OOPIF/dynamic OOPIF POST/Blob 文件及 1 个仅取消 waiter 后继续完成的
held 文件共 17,524 B，逐字节与原响应一致。另一个 held POST 的公共取消
回执、原 Page canceled 和 HTTP 未完成关闭均早于 Stop/fixture close。
16 次外部 scope 的路径/取消请求拒绝，17 条全局原请求恰好对应全部 case。
7 个确切文件核对身份后删除，正常 Browser.close、进程退出、Job=0、注册和
endpoint 清理通过，无强制终止。原报告 SHA
`34100f88ecd6090eaa7dae4677e15d4355c9a8a8ce894e1f8b03bee8c66171c3`。
Go 修正仍在源码中，未重新打包；原有 viewer/result 的浏览器流程未重复运行。
停止后独审 2,959 项通过，核对原冻结源码、构建、原 uint64 lifecycle、全部
原字节与确切文件清理。首次 auditor 错把 generation 放在 worker 私有 proof
读取而失败，保留原记录；改为直接对照原 host binding 与公共 client metadata，
不重跑浏览器。最终 audit SHA
`9e45a4671a1b5e9d9d3d87d3519fb61681368a8f3fb84b3b9aba1b30b6c90708`。

### 原结果页的用户接续（2026-10-17，限定流程已验）

上一目标轮完成提交 `5d105c2` 并核对 fork，属于实际进展。当前源码检查发现：
`finalizeTabs` 已保留结果页并释放任务 attachment，但 viewer 列表与人工接管
只认 live task attachment，导致原结果页从用户入口消失。本片补齐同一原页面
的只读观看和明确人工接管，不重新请求 URL，也不自动恢复 Agent 权限。

- 独立 managed result Module 记录本次 finalize 的原 tab/target、browser/run、
  当前文档和最终位置。只在原清理、disposition、存储与最终校验完成后发布；
  原有 presentation-only marker 不迁移成权限，`turnEnded` 不自动交付页面。
- 私有用户列表区分 task/result，给出 `watchable`、`takeover`；结果选择及
  接管携带 opaque `deliveryId`。每次操作复核原记录，不把旧 tabId 选择升级
  为新交付或新任务权限。关闭、移位、替换或 Agent 重新取得控制会撤销旧记录。
- 共享 ManagedHumanControl Module 的原生帧与导航清理，增加创建时固定的
  view Adapter。view 不提供 Input、暂停、焦点模拟或输入风险标记；明确接管
  必须先等 view 的原生关闭，再建立独立 human 租约。任务 admission 同步撤销
  view 发布并等待实际清理。不会用附加 debugger 失败充当互斥机制。
- 状态增加独立 `view` 租约及 generation；帧使用 `user-view/viewLeaseId`，
  不能伪装 human。Go/HTTP/UI 先接纳当前代次状态，再接受原帧；旧回执、
  排队帧、迟到解码不能污染后续观看。结果在正常运行或已完成暂停时可用。
- 人工导航后继续保留同一 delivery/target 的已验证当前文档。End 后仍保持
  Agent 暂停，用户可重新查看/接管原 B；Resume 明确关闭 view 后才恢复任务。

验收从正式 SDK 创建并填写原草稿开始，正式 finalize 原页，核对旧任务权限
失效、原页面未重载；用户只读观看后从暂停状态接管，导航并唯一提交，End
后再次观看原结果。保留原请求、输入回执、PNG、进程退出及失败记录。先做
跨层定点测试，再做隔离真实浏览器。用户本轮再次要求新包，验证后从干净提交
打包并推送 fork，不创建 PR。

本轮实施及原始证据：

- 扩展全套 2,053 项、UI 54 项、Go 全包/vet/build、实际 bridge 生成样本
  核对通过。有限结果登记和后台专项 30 项通过。修正旧任务请求误撤用户
  权限、finalize 发布时序及旧导航验证晚回覆盖新状态的竞态。
- 首次 `managed-result-vaiv5h` 实际 exit 1：原 A 已交付并成功跳转 B，
  测试仍期望旧标签文字，未包含新的“已交付结果”前缀。保留原始失败，
  只修正精确界面预期，未改变生产代码。报告 SHA-256：
  `77a933f248dc731a21439d688724d3cd713ea3d123a124854cabb99d080ba77d`。
- 修后 `managed-result-VGrDlV` 六步实际 exit 0：50 项精确输入回执，原
  302/子 frame/SPA 和唯一 483 B POST；两次 Begin/End、三次结果观看保留
  原交付、tab/target、当前文档、草稿与回执，不执行 Resume 或 Agent 接回。
  查看期间原页面输入事件未增加，尚未主动尝试只读画面输入。报告 SHA：
  `a132925e39d5f827342289a6eb93a04166ce4aff5c437389e9220198d83af177`。
- 同一冻结运行源码的普通 viewer 回归 `managed-viewer-o6PuJl` 四步实际
  exit 0，原子页、暂停/继续和停止清理通过。报告 SHA-256：
  `b57bb329bf79d62b59f07c4160f8cbfa06394320ee5e98f3fed9853c8435cd11`。
- 该轮结果登记仍限定当前 worker/run；当时 worker 重启恢复、Stop 后保留可见
  窗口、真实登录/IME、公司 Edge 和跨平台均未验收。整体目标保持开放。
- 停止后结果独审实际 exit 0：868 项原证据检查、44 PNG 完整解码；审计 SHA
  `7d29246e7edc110d1648dfd865118b17f813824581412944d22e453dc13181c3`。
  普通 viewer 独审 8 项通过、45 PNG 完整解码；审计 SHA
  `d7b0ac2217bb424a27c2dea9e96661a2b2ba2c5ea39aabbf5824cac638662771`。
  首次审计器字段名错误和短时 TCP 探测超时保留，无业务重跑。
- 用户要求的新包 `preview-20261017-d0605b1` 已从干净提交重建并发布到 fork。
  离线 CLI/MCP 30 工具、独审 5,442 项、98/71/6 文件和四资产上传回下载
  哈希通过；本地 102 文件复制一致。初次上传有重复资产 422，核对三个已传
  资产后仅补传缺少的完整包，没有覆盖；再核四资产通过后发布。完整包 SHA：
  `c4132c5022cae9d84efb8b6bfe81d920618bacd63e4dbc75baa1c541d4fa4fe3`。
  发布 EXE 与提交前验收 EXE 分别保留身份，未声称发布 EXE 已重跑网页流程。

### 连续人工接管（2026-10-17，限定导航流程已验，未重新打包）

上一轮新包交付属于实际进展；发布基线为 93f54a1。接下来沿用同一个人工
lease、原 tab/target 和暂停状态，支持一次 Begin 经页面跳转/重定向和 SPA
后继续输入。不能用自动 End/Begin 或反复要求用户接管替代这条原始流程。

将文档代次生命周期收进 ManagedHumanControl Module；其 Interface 仍是
Begin/Input/End，补充 typed `navigating` 状态与代次通知。跨层 Seam 约定：

- 状态 `active(g) → navigating(g+1, viewport:null) → active(g+1)`；导航
  同步撤旧发布/输入，保留租约和 durable held-input 风险。序号按
  `(leaseId, generation)` 从 1 开始；连续重定向可合并状态，但代次单调。
- 旧原生调用、held input 释放和原渲染清理必须实际结算，才能恢复新代。
  每代独立 tracker token/队列/回执；已发送且 ACK 成功的输入仍返回原 tuple。
  明确未发送的旧代请求用 typed `HUMAN_GENERATION_STALE`，与未知原生结果区分。
- 新画面不能只依赖 stop/start 或 streamId。需验证原 tab/target、当前站点
  和 document/loader，使用原生同一 TimeTicks 时钟的捕获时间屏障排除旧编码帧。
  缺字段或无法证明时不开放输入；静态页、跳转页的真实帧需分别验证。
- bridge/Go/UI 接收更大代次时退休旧画面和队列；旧回执、异步解码、超时
  不得关闭或更改新代次。新代真实帧匹配并解码后才启用 UI 输入。End/Stop/
  Pause/断线仍是整个租约的释放，不能被导航恢复越过。
- CDP 输入没有 documentId 条件参数。只能保证观察到导航栅栏后，尚未发出
  的旧请求不再提交；不能宣称撤回了已交给 Chromium 的输入。实际在途结果
  单独记录，不重放、不以事后 document 读取伪造原子归属。

验证包括定点跨层竞态及一次真实业务：A 页面原始点击经重定向到 B，保留同
lease/target，B 输入后 SPA 继续输入，最终唯一提交和原清理。另测子 frame
导航、held input 导航释放、旧回执/旧编码帧迟到与 End/断线。每次原尝试的
失败和清理记录保留。此次开发不自动更新已发布的 93f54a1 包。

本轮实施及原始证据：

- 独立零业务时钟诊断 `human-navigation-clock-7T29sj` 实际 exit 0：静态 A、
  302 后静态 B、B 的 history 跳转均取得晚于原 Performance 屏障的原生帧，
  三张 PNG 完整解码；实际 Browser.close、原浏览器 exit 0，无强制终止。
  结果 SHA `1e16b025a32ae699b6b2d06a9b09926f513d936bd6525f4a17ff9fbd0bb39448`。
  它只验证这组原生时钟观察，不替代生产接管流程或原子输入证明。
- 跨层检查修正了已提交输入被 generation context 取消遮掉原回执、状态合并
  跨过首帧、迟到 Begin 清掉同代唯一首帧，以及 publication 收尾时遗漏无帧
  导航通知。后两项有明确修前失败（`aaafaa`、`20f457`），修后确定性回归
  通过；旧输入未知失败仍整租约撤销，不能借导航吞掉错误。
- 原生产导航 `managed-human-navigation-yI1c1P` 六步实际 exit 0：一次 Begin，
  同 lease/tab/target 经过 302、子 frame 和 SPA，47 项精确输入回执，唯一
  483 B POST。原进程/Job/注册/endpoint 清理正常，无强制终止。报告 SHA
  `8942b42b934ff39c666ae1b53e26060af7dc7f0e5c8191fb04cf0a741356f75c`。
  目视发现接管中标题/地址仍显示原 A，不能把这轮写成元数据显示通过。
- 元数据改为来自当前已验证候选，导航期间清旧值；新增 5 个反例先失败后
  通过。修后原导航 `managed-human-navigation-fRIjwN` 六步实际 exit 0：
  保持同样的单接管/47 输入/唯一提交，三次导航的实际 DOM 标题、选中项和
  URL 均匹配当前原文档，包括 `#spa`。报告 SHA
  `69fe80235ebebb1dc2a843d3a0c23b620b4e607ed8a6e6f86124bd7589e1b6f6`；
  独审 SHA `518c45d465f5942e4aa1487a16942252bd8667d3e4c1ecd7ce9913f1d5d40311`。
  独审完整解码 53 个原生 PNG 和 6 张截图，核验原生命周期字节、原 4 类
  进程退出 0、Job 归零与清理回执，不靠事后进程不存在替代退出证据。
- 首轮独审曾把超过 2^53 的 nativeCreationTime 经 JS Number 投影误判为
  生命周期不一致，原 audit 失败保留；修正只核验该字段的 IEEE-754 投影，
  原 Go JSON 精确整数仍作权威。新 runner 另存原生命周期文件 bytes/SHA。
- 修后扩展全套 1,995 项实际 exit 0；UI 47 项、Go 全包/vet/build 与原
  bridge fixture 一致性检查通过。Go 导航专项重复运行覆盖旧队列、迟到原
  回执、未知失败和 Begin 首帧竞态；不能把次数当成新增业务覆盖。
- 附加同文档回归 `managed-human-paPWuq` 在启动检查实际 exit 1：测试脚本
  仅按 PID 遍历，误把复用父 PID 的旧系统进程列入 viewer，进程归属断言和
  后续名单消失检查失败。0 网页请求、0 人工输入、0 POST；原测试 browser、
  native、supervisor、viewer 均 exit 0，Job 归零，无强制终止。原报告 SHA
  `fe277e8fcb5500d15e5c84d75be29a10ce17d34359f3cc4aeb508bf407b761fc`。
  这是验收观察器问题，失败记录保留，不视作人工断线释放已验。
- 四个 managed runner 共用只读进程树 helper，逐条父子边核对完整七位 UTC
  CreationDate，断开父 PID 复用产生的旧边，不按进程名删除或终止进程。
  合成反例修前实际 exit 1，修后相关 27 项测试通过。修后同文档原回归
  `managed-human-w1KteZ` 六步实际 exit 0：30 项精确输入回执，原文档中
  Shift/左键按住时断开原 WS，实际可信释放后再明确 Resume/new turn，
  同一文档唯一 299 B POST。四类进程 exit 0、Job 归零，无强制终止；
  原报告 SHA `b70b2f128a1cbe0f7e52d422d40eff39fe1170ae5db03bded45919641fabb865`。
  这次 helper 修复未改变生产运行源码；前一轮的失败不被后续通过覆盖。
- 停止后独审实际 exit 0，复核 30 项 ACK、原连接未补发释放、原文档唯一
  提交与正常退出，完整解码 32 张原生 PNG 和 5 张 viewer 截图。运行扩展、
  EXE、SDK 与导航验收一致；审计 SHA
  `1568fcce7beefeeaeb5f70e6eb585b3090107d4ea5ea36be1ad8fc3e884e0cf2`。
  旧同文档 runner 没有 `lifecycleSource` 字段；独审单独绑定原 Go lifecycle
  的字节哈希，仅对 nativeCreationTime 比较 JavaScript 数值投影。

限定导航不证明 held-input 导航的真实释放、跨站/OOPIF 内输入、完整 IME、
真实 SSO/MFA、普通公司 Edge 或跨平台；这些仍为后续目标。

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

viewer 是独立用户 Interface，使用现有 rendering Module 的有界原生帧订阅，
并提供真实暂停/继续/停止控制，不另抢 debugger
附件。现有任务 socket 不授予用户暂停/恢复权；若新增 supervisor 控制 Seam，
必须具有独立管理能力、真实 cleanup 回执和 revision 检查，并保留原 popup
鉴权。这不能抵御同一 OS 用户任意执行代码，契约与当前本地通信一致。

### 实时观看与可信控制实施（2026-10-17，有限真实验收通过）

现有截图/页面动作已依赖原生 screencast 推动画面，viewer 必须借用同一
rendering 生命周期，不能第二次 attach 页面或并行启动另一条原生流。
`BrowserRendering` 管理长订阅、短动作借用及原 start/ACK/stop 的真实在途
回执；每帧只做一次原生 ACK，网页/HTTP 接收速度不控制这个 ACK。caller
显式 raw screencast 撤销 viewer，结束后不自动恢复；Pause/end/detach 撤权
与实际清理仍属于已有 backend 屏障。

仅 managed 配置的 worker 安装不可变 `__obuManagedUser`，由原生绑定的
run、extension instance、worker boot、Native Port 和私有随机 channel key
共同约束。Go supervisor 在自有 Browser root 的独立连接上只 attach 原
extension service worker，以固定 Runtime binding 接收帧，不开放一般 CDP
代理或任务 RPC 用户 setter。10 秒 lease/3 秒 heartbeat 丢失后撤销观看，
不自动 Resume；事件和调用均保留原 worker/context 身份，不重连原任务。
桥保留一帧信用和一个最新候选，PNG 编码前上限 4 MiB。CDP screencast 的
sessionId 不是帧序号，native、bridge 与 UI 的顺序分别记录。

`internal/managedviewer` 提供仅绑定 IPv4 loopback 的 HTTP/WS 用户界面，
精确核验 Host/Origin、一次性 fragment 票据和一个活跃观看者。`managed run`
只在用户启动结果附带查看链接；`managed view` 经原管理连接和 run 身份签发
新票据。Info、普通 status、task RPC 和生命周期文件均不能泄露该能力。
浏览器不会自动打开查看页。HTTP 私有投影将桥的 nested status.automation
转成公开 UI 状态，去除私有身份字段；UI 只显示经确认的运行/暂停/停止状态。

Pause 释放观看并实际清理任务控制。Resume 校验用户看到的 revision 与
worker boot，不恢复旧 attachment、观看或输入；需要新 turn 和显式选择。
Stop 直接经 supervisor 结束原 Session，即使 worker 控制连接失联仍可用。
原 Session.Close 完成后才能确认停止，WS Stop 回复须真实写出再关服务器。
Close 调用截止只限制等待，不能证明原 stream、进程或 HTTP 资源已清理。

当前扩展专项 1,873 项、builder 25 项、Go 全包及 vet、UI/辅助 20 项通过。
原真实 `managed-viewer-5xVYLn` 四步实际 exit 0，38 个原生 PNG、同一原始
子页唯一提交、真实 DOM 暂停/继续/停止和实际进程清理均确认，无源码漂移。
结果 SHA-256 为 `4ced0acb55a4e2d21f4d834baa051f381d65270fb2345f0fc37d1f9dd752f585`。
用户再次要求打包，已从干净提交发布 `preview-20261017-41577de`，离线检查、
独立制品审计及四资产上传回下载核验通过；此前 f2d3421 不包含这些
工作。登录接管、普通 Edge/公司电脑、OS 前台观察和整体能力对齐仍开放。

### 登录准备实施（2026-10-17，限定范围已验）

新增显式 `managed setup`，仅此命令打开用户可操作的独立可见浏览器。
`StartSetup/Info/Done/Close` 复用原 Session 的目录归属、name/profile 锁、
Windows Job 与原进程退出回执；同一资料目录的 setup/run 必须串行。
setup 固定从 about:blank 开始，由用户手动导航；不从命令行收集登录地址、
密码或验证码，不复制日常浏览器资料，也不自动接着启动 Agent。

setup 不加载任务扩展、不注册 Native host、不发布任务 endpoint 或 viewer。
原管理连接只提供 `state: setup`、明确 mode 和实际 stop 回执；CLI/MCP
任务选择必须拒绝 setup，不得把空 socket 当成默认发现。自然关窗后的原
browser exit 0 和 Job 归零是正常结束；显式 stop 仍等待原 Browser.close
及进程树退出。不能在收到窗口事件后先释放 profile 锁。

原始真实验收 `managed-setup-QyXNkx` 五步实际 exit 0，使用唯一私有 profile
和同一固定 Chromium：独立测试 actor
在本地 fixture 中完成一次登录 POST、持久 HttpOnly cookie/localStorage；
原 setup 正常退出后，正式 SDK 在新 run 访问受保护页并完成一次后续提交。
同时验证同名互斥、任务连接拒绝、旧身份不可用和原进程清理。另一独立
setup 只验证自然关窗，不重放登录业务。不使用真实网站或个人凭据；日志
只保留认证结果/必要哈希，不能把测试 actor 等同真人 MFA 或 OS 焦点验收。
`managed-viewer-cOCeeU` 四步回归实际 exit 0，停止后独审 19 项通过。
原零业务 `XjPnhh` 扩展断言失败、`ocDaKN` 端口文件 EBUSY 失败保留；
后者独立 viewer 强制清理且未取得完整原进程清单，不能记成正常清理。
修正只涉及测试身份检查和原期限文件观察；生产源码没有因失败而变更。

此功能解决登录准备，不保留原 Document、sessionStorage、仅内存令牌或
未提交表单。任务中途的同文档人工接管仍需要独立 human 控制租约和输入
生命周期，不能临时 Resume 或放宽现有任务附件权限来代替。Chromium 的
[资料目录说明](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md)
与[统一 Headless 说明](https://developer.chrome.com/docs/automation-and-testing/headless)
支持串行 profile 复用的设计；上述合成原流程验证了持久数据，真实网站
兼容仍开放；独立同文档接管的后续实现及限定验收见下节。

## 验证阶段

### 同文档人工接管实施（2026-10-17，限定流程已验并交付预览包）

用户再次要求打包后，已发布 `preview-20261017-93f54a1`，包含下述已验证
同文档人工接管；运行源码与 9ac3a04 相同，新增修改限发布指南。离线 CLI/MCP、
独立制品检查及四资产回下载校验通过，网页流程未重跑。以下保留原开发过程
及旧包范围；该次打包时跨文档接管仅完成设计审查，没有进入该包。后续源码
实现和限定验收见上方连续接管记录。

上一轮完成并发布登录准备，属于已验证进展。本轮继续补完整目标中尚缺的
任务中途人工操作；自动续做期间不自行重复打包。用户随后再次要求新包，
本轮将已验证提交 `2547e6e` 隔离重建，人工接管 WIP 保留且不进入该包。采用扩展内独立
`ManagedHumanControl` Module，显式选择原任务标签页并冻结原 target 身份。
先同步撤销任务输入，再等待原 Pause 和附件清理，之后才取得独立人工附件。
不临时 Resume、不把人工 token 放入任务归属表，不给任务 RPC 增加控制权。

人工输入和原生画面复用独立的输入跟踪、渲染和 BrowserLifetime 风险日志，
保持原文档和未提交数据。按真实解码帧与文档/几何代次限定输入，有界顺序
传送指针、键盘、已提交文本和滚轮；禁止任意 CDP/脚本代理。结束、页面失效、
用户连接断开和原 worker 丢失先撤销接纳，再等待原调用、按键/按钮释放、
原生帧 ACK/stop 与 detach。任何未知清理都阻止从 popup 或 viewer Resume。

UI 独立显示“接管此页”“完成接管”，人工期间 Agent 保持暂停。完成接管
只回到已暂停，用户再明确继续；必须新 turn/新句柄，旧人工和旧任务能力
均不能恢复。观察模式保持原语义，任务暂停不能被误当成人工帧失效。

真实验收使用同一个原表单：Agent 填一个字段，真实 viewer DOM 接管并点击、
输入合成文本、滚动，交回后新任务取得同一 target/Document 并唯一提交。
保留原点击/输入/帧/回执与清理证据。另行验已确认 held input 后断开原 WS
的实际释放，不重放业务来刷通过。完整 IME、SSO/MFA、原生文件选择器、
新弹窗接续、操作系统前台行为仍须分别取证，不能由这一原流程推导。

用户要求交付时的开发断点（尚未提交、尚未真实验收）：

- 独立 human backend、VM/builder 接入及定点测试已写；相关 131 项实际
  exit 0。模块不支持几何改变后自动续租，必须重新明确接管。
- UI 27 项行为测试实际通过；完整 UI 套件仍有旧 bridge fixture 不含
  `human:null` 的跨层差异，尚未更新，不能记为全套通过。
- 原始单次业务 runner/fixture 已写，4 项辅助测试实际通过；未启动浏览器。
- 根 bridge 和共享 Go typed schema 仅部分接入，尚未测试。继续时先补
  `humanCleanupIncomplete` 屏障、原 `lastInputSequence` 回执、generation
  和 lease 验证、pending Begin/Input 时断线的同步撤权；再完成 Go viewer
  projection、顺序输入队列、结束/断线优先清理及旧 fixture。
- 必须完成上述跨层测试和真实浏览器原流程后，才能提交该功能、更新能力
  文档及考虑下一包。当前包的离线/制品检查不验人工接管。

续做进度（2026-10-17，仍未交付人工接管）：

- 已完成独立 backend、bridge、Go/HTTP 输入队列、UI 和 shared public fixture。
  修复 Shift 按住时的已提交文本、旧释放回复影响新 Begin、旧失败请求撤销
  后继接管、断线清理先后顺序与私有字段误用。扩展 1,920 项、UI 35 项及
  runner/fixture 6 项通过；Go 全包/vet 和冻结源码构建实际 exit 0。
- 首个真实 `managed-human-EO2bNJ` 实际 exit 1：启动阶段读取原
  DevToolsActivePort 遇 Windows sharing violation。没有网页请求、人工输入
  或 POST。缺少 Browser root 的原清理记录为强制终止、browser exit 1、Job
  归零；尚未确认 native 身份的 endpoint 保留为清理错误，不能记作正常关闭。
  结果 SHA-256：`7ec0e57104ef5cdf9364519629ff986e9e3a94c648c19ea87c6b743fa087d038`。
- Windows 启动仅对原文件的 `ERROR_SHARING_VIOLATION` 在原期限内继续观察，
  不换端点、不重启浏览器；真实独占文件句柄专项、Go 全包/vet 通过。随后
  `managed-human-wrP0ID` 启动及非业务 Begin/帧/End/Resume 成功，实际 exit 1
  来自验收器误把普通 Tab 包装对象视为固定旧轮次。修正为核验明确携带原
  session/turn/control epoch 的请求；该失败未发生主表单请求、人工输入或 POST。
  原报告 SHA-256：`35b1d45a41522edfce4d1b6c1d053bf0efe1170abd0dc7306d5afeea3556d431`。
- `managed-human-XLQ6VS` 实际 exit 1：原 Agent 已填写未提交表单，第二次
  Begin 在首帧处失败，0 accepted humanInput、0 POST。正常 Browser.close、
  browser/native/viewer/supervisor exit 0 与 Job 归零不改变业务失败结论。
  原报告 SHA-256：`cd1732846c0032c3e0c1431efde72d686681c5fe44fdaa3b8a5f7b93a3c4c974`。
- 独立零业务 `human-geometry-cEDK4O` 实际 exit 0：短页 client/frame 均为
  778×446，长页和 RTL 长页 client 为 763×446、frame/inner 为 778×446，
  scale/zoom 均为 1。证实 native surface 包含滚动条，不能与 client 尺寸
  直接相等比较；原 Browser.close/exit 0 和进程归零完整。生产正在改为首帧
  完整 surface 与私有 client 双重核对；这次诊断不构成人工输入验收。
- 验收器点击目标改为原矩形与完整视口交集的中心，保留全部坐标证据，未
  改页面或额外滚动。UI 旧 Begin 错误/输入超时结束后继租约的问题已修复，
  UI 37 项通过；几何修正后的完整扩展 1,959 项通过，Go 全包/vet 通过。
- `managed-human-tQeuXy` 实际 exit 1：长页 Begin 和人工首帧已成功，原
  move/down 两项取得精确回执，up 得到通用未确认错误。没有 POST；不能
  从该错误推出原 native up 是否发送，也不能把清理时的释放当作原 up 成功。
  原报告 SHA-256：`d79b00159c5e69141dec46a7873867e04191e574e7ee62b9d0864db1137bad9e`。
  新增精确白名单 `reasonCode` 和失败后的只读页面尺寸记录，以便区分后续
  失败；不把新增诊断反推为历史证据。真实完整人工流程和共享 viewer 回归
  仍待完成，人工接管继续排除在已发布包之外。
- 独立无表单诊断 `human-pointer-diagnostic-U0ZXS7` 实际 exit 0：原 viewer
  move/down/up 三个精确回执、原输入框聚焦、End 和正常停止通过；client
  743×369、完整 surface 758×369 保持不变。各输入阶段之间额外读取了原
  layout metrics 和 DOM，可能改变时序；不能代替原业务失败的修复证明。
- `managed-human-IDDtlj` 实际 exit 1：仍在原 move/down 后的 up 失败，
  未取得 reasonCode、无 POST。失败后记录显示 client 高度 369→354、
  scrollWidth 743→829，业务元素矩形不变；事件日志文字造成横向溢出是
  推断，未采集原日志元素的独立尺寸。fixture 仅为日志增加换行，不改变
  业务布局或放宽生产几何校验。原报告 SHA-256：
  `7b264b59ad9b2b9486c10625d4038fd604684c4901fdf978a9825963c0ef3fe4`。
- 换行后的 `managed-human-JYEQfy` 实际 exit 1：23 项人工输入有精确回执，
  原草稿追加 ASCII/Unicode、Shift down/text/up 顺序和一次可信确认点击
  通过。随后真实 viewer wheel 未产生出站请求；UI 仍 active、pending 0、
  sequence/acknowledged 23，原页尺寸不变、scrollY 0、无 POST。没有完成
  held-input 断线、恢复、唯一业务提交及计划中的 UI Stop。最终 Browser.close
  和 browser/native exit 0、Job 归零成立，但 supervisor exit 1 报告 viewer
  rendering cleanup 未确认，不能声称全层正常清理。原报告 SHA-256：
  `7b004282bcdc780e4a6186129d9405544475da582504029ead65c42c2ac2a664`。
  正在核查 viewer 真实 wheel 命中和独立清理边界；旧失败不被后续诊断覆盖。
- 独立无业务 `viewer-wheel-diagnostic-9Qk3Sm` 采集与清理实际 exit 0。两个
  新 profile、相同静态图像和坐标，各执行一次真实 click/wheel；A 为默认
  CDP context 后设置 DOM 1280×1000，实际窗口仍 780×580，wheel 命中
  DIV 而非图像，查看页滚动 115；B 显式创建 1280×1000 context，实际
  窗口也为该尺寸，wheel 命中图像并被其处理器取消，查看页未滚动。双方
  原 Browser.close/exit 0 与身份退出成立，无扩展、host、表单或 POST。
  runner 因此使用显式 viewer context，并逐页核对实际窗口；生产滚轮逻辑
  未改。该诊断不替代完整接管验收，结果 SHA-256：
  `177af01f46af7001eaa7a4a231309893eaa7f4cbd94ffd47844ab68754467c6e`。
- 清理链另查到确定错误：bridge 已等待真实 revoke，却把先前 active human
  快照作为 disconnect 回执返回；Go 缓存该原回执后，HTTP 按当前租约拒绝
  清理确认。现在从实际清理后的资源重建回执，未知释放仍拒绝；新增跨层
  回归正在核对，尚不能把修复视为原真实失败已通过。
- 修复后原完整 `managed-human-6U55vc` 六步实际 exit 0：30 项精确人工
  回执包含 pointer 10、key 5、text 13、wheel 2。原页面保留 Agent 草稿，
  可信 Shift/A/keyup、Unicode、双向 600 滚轮与一次确认点击通过。按住
  Shift 和左键时关闭原 WS，原文档实际收到释放；新连接确认确切 lease
  cleanup 后显式 Resume、新 turn，旧人工及原任务 authority 拒绝，同一
  Document 唯一提交 299 B POST。四个查看页的实际窗口均为 1280×1000。
  最后 UI Stop、browser/native/supervisor/viewer exit 0、Job 归零、原身份
  退出、注册及 endpoint 清理通过，未强制终止，cleanup 为空。结果 SHA-256：
  `6454f2397a11e4f332dbaaa4a2775573a4fbe9a151d8a8a56264d49725a2a749`。
- 同冻结运行时的普通 `managed-viewer-q5L0so` 四步实际 exit 0，12 原生帧、
  AI 光标及蓝框、唯一提交、暂停/显式新轮次继续/停止和清理通过。结果
  SHA-256：`b22dac7bce5f818b896f9e8fada0c484feb515601f585aef893cd831c67350cf`。
  根代理目视检查了人工接管、最终提交以及普通 viewer 的原截图。
- 最终扩展 1,966 项、UI 37 项、runner/fixture 10 项、Go 全包/vet 通过。
  真实 bridge 输出生成的独立 Go 清理测试覆盖当前租约正例及五类旧/未知
  回执反例。首次 UI 检查 36/37 的旧 golden 差异保留；重新生成实际 bridge
  输出后通过，没有修改生产 UI。当前发布包保持 2547e6e；真实 IME、SSO/MFA、
  跨导航接管、原生弹窗、缩放/触摸、普通公司 Edge 和独立 OS 前台证据仍未验。
- 两项停止后独审均实际 exit 0。`6U55vc` 原始源码、30 输入回执、同文档
  释放/恢复、299 B POST/231 B 响应、35 PNG 完整解码、29 个去重原进程
  身份及清理证据一致，审计 SHA-256：
  `541b11728fed90e35271afc54e05382059f0902f1404b01a3d49b8c8d374b7bf`。
  `q5L0so` 核对唯一 190 B POST、七个 UI 控制回执、19 PNG 完整解码与
  26 个去重原进程身份，审计 SHA-256：
  `11f08984f80ab903c71369a6c84ad07edb8aa1ab03021e6d0285267d50c74ac6`。
  当前资源不存在是补证，不替代原生退出与释放回执；审计项不计作新增业务。

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
- [x] Windows 固定 Chromium 的同文档基本人工接管：原草稿、typed 输入、
  断线 held-input 释放、确切 cleanup 后显式继续与新轮次接回。
- [ ] 正式用户会话的 finalizeTabs、可见交付页保留与其后续人工接续。
- [ ] 浏览器发现/兼容与完整异常生命周期验收，其他平台实现。
- [x] 限定用户流程：实时画面、可见反馈、可信暂停/恢复/结束、串行登录准备
  及同文档人工接管；任务调用者没有用户控制通道。
- [x] 固定 Windows Chromium 的单租约根重定向、子 frame 导航与 SPA 连续
  接管，原输入回执、当前标题/地址和唯一提交；尚未重新打包。
- [ ] 真实登录/输入法/更广跨站接管和用户体验验收，普通公司 Edge 安装。
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
