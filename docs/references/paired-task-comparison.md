# P15：两轮完整任务对照

本轮只比较冻结的六类任务，共 24 次原始尝试。生产扩展、正式 JS SDK 和
native host 与 `e83c6d8` 预览版相同；`a4a66e5` 只增加比较用测试设施。
24 项全部结算，停止后原始账本与工具回执已完成独审。

OBU 12 项：1 blocked-environment、1 failed、10 success；Codex 12 项：1 blocked-environment、9 success、2 unsupported。

这是一组有限任务的结果，整体能力对齐仍未完成。


## 24 次首次结果

| 序号 / Attempt ID | 任务 / 方 | 最终状态 | 业务 wall 秒 | 正式 API 次数 | 清理 ms | 业务与页终态 |
|---|---|---|---:|---:|---:|---|
| 01 / `p15-r1-f-obu` | F / obu | blocked-environment | — | 0 | — | 未访问任务；跨代理终端 handle 不可用 |
| 02 / `p15-r1-f-codex` | F / codex | blocked-environment | — | 0 | — | 未访问任务；原 solver 换 turn 后 IAB 不可用 |
| 03 / `p15-r1-r-obu` | R / obu | failed | 293.807 | 72 | 60550 | 报告正确；原 finalize 失败，迟到恢复关闭了报告 |
| 04 / `p15-r1-r-codex` | R / codex | success | 147.453 | 67 | 138 | 唯一报告；保留交付页并关闭资料页 |
| 05 / `p15-r1-u-obu` | U / obu | success | 78.729 | 12 | 25 | 三文件唯一上传；同输入清空 |
| 06 / `p15-r1-u-codex` | U / codex | unsupported | 115.278 | 17 | 45 | 隐藏输入不可点击；原 CDP 明确拒绝直接设文件 |
| 07 / `p15-r1-d1-obu` | D1 / obu | success | 62.448 | 10 | 28 | 一次原 POST 下载；实际文件匹配 |
| 08 / `p15-r1-d1-codex` | D1 / codex | success | 44.495 | 9 | 39 | 一次原 POST 下载；实际文件匹配 |
| 09 / `p15-r1-d2-obu` | D2 / obu | success | 63.053 | 10 | 32 | 一次原 Blob 下载；立即 revoke 后文件匹配 |
| 10 / `p15-r1-d2-codex` | D2 / codex | success | 37.010 | 9 | 44 | 一次原 Blob 下载；立即 revoke 后文件匹配 |
| 11 / `p15-r1-x-obu` | X / obu | success | 49.900 | 9 | 38 | 主页面与跨源框架原 console/error/network |
| 12 / `p15-r1-x-codex` | X / codex | success | 126.899 | 24 | 45 | 主页面与跨源框架；保留原不支持调用及合法替代 |
| 13 / `p15-r2-x-codex` | X / codex | success | 63.324 | 20 | 45 | 新页面与跨源框架原诊断 |
| 14 / `p15-r2-x-obu` | X / obu | success | 44.631 | 9 | 35 | 新页面与跨源框架原诊断 |
| 15 / `p15-r2-d2-codex` | D2 / codex | success | 34.075 | 9 | 37 | 新 Blob 案例的原文件匹配 |
| 16 / `p15-r2-d2-obu` | D2 / obu | success | 62.793 | 10 | 36 | 新 Blob 案例的原文件匹配 |
| 17 / `p15-r2-d1-codex` | D1 / codex | success | 32.225 | 9 | 45 | 新 POST 案例的原文件匹配 |
| 18 / `p15-r2-d1-obu` | D1 / obu | success | 58.879 | 10 | 33 | 新 POST 案例的原文件匹配 |
| 19 / `p15-r2-u-codex` | U / codex | unsupported | 32.219 | 9 | 20 | 隐藏 chooser 失败；未上传，未到清空阶段 |
| 20 / `p15-r2-u-obu` | U / obu | success | 55.141 | 11 | 22 | 新案例三文件唯一上传；同输入清空 |
| 21 / `p15-r2-r-codex` | R / codex | success | 75.313 | 65 | 176 | 新材料唯一报告；保留两份交付报告 |
| 22 / `p15-r2-r-obu` | R / obu | success | 340.707 | 61 | 102 | 新材料唯一报告；保留交付页至统一清场 |
| 23 / `p15-r2-f-codex` | F / codex | success | 101.296 | 32 | 96 | 两次框架保存、唯一提交与公开证据 |
| 24 / `p15-r2-f-obu` | F / obu | success | 89.593 | 29 | 37 | 两次框架保存、唯一提交与公开证据 |

业务 wall 以原回执提取，清理另列；第 03 行清理是首次失败到迟到恢复 ACK，
并未满足保留报告与 60 秒预算。第 01/02 行没有开始业务，破折号不是零耗时。
API 次数含各自正式 begin/业务/清理调用，不等于外层模型工具调用数，
不能据此直接比较效率。完整起止、错误、替代、文件与原件 SHA 见
[脱敏结果索引](paired-task-comparison-results.json)。

## 读数边界

- OBU 使用正式 JS SDK、实际 Go host、隔离 Chromium 156 与测试 Native
  Port 适配层；下载使用已准备的原生 Browser 连接。Codex 使用当前 IAB 的
  正式 CUA 接口。它们不是同一浏览器安装条件。
- 两个 solver 独立开始，不能读取 fixture 答案或彼此的业务结果。第二轮可
  保留本方接口使用经验；研究材料更新。两轮研究同题事实经过独立核验。
- 两方继承同一父会话的模型设置；工具未暴露准确模型 ID 与思考档位，按
  unknown 保留，不能用任务 wall 反推模型思考耗时。
- OBU 的通用 JSON 桥接增加工具往返。正式 API 操作数、外层模型工具调用数
  和传输 RPC 数是不同指标；没有原始数据的字段记 unknown。
- 业务 wall 包括模型思考、往返及合法替代；从首次任务 URL 调用起，到最后
  非清理证据回执为止。清理另列。没有平台思考耗时，不能作减法推算。
- 原浏览器事件观测与 OS 前台不同。零浏览器 focus 事件不证明系统前台从未
  变化；本轮没有独立 OS 前台观测，也不代表普通安装 Edge 已验收。
- 只有两轮，不作速度持平、统计显著性、跨平台或完整 Codex 能力对齐结论。

## 原始失败与接口限制

1. 第一轮两方表单各占用一次 `blocked-environment`：OBU 的父/子代理终端
   session handle 不互通；Codex 的原 solver 结束 turn 后 IAB 不再可用。
   两次均未访问任务 URL，没有换 key 补跑成成功。
2. 第一轮 OBU 研究正确保存报告，但测试桥把数字 tab ID 数组传给需要对象的
   `finalizeTabs`，原调用失败。恢复发生在 60 秒清理预算之后，且关闭了要求
   保留的报告。因此整项保持 `failed`，不能只按报告内容记成功。桥修正仅供
   之后的预定尝试，生产代码未变。
3. Codex 隐藏上传场景的精确点击返回 `no_visible_match`，file chooser 等待
   超时。第一轮正式 raw CDP 明确拒绝 `DOM.setFileInputFiles`，要求使用
   chooser。第二轮沿用本方这个接口经验，不伪称重新获得了拒绝回执。这是
   本题隐藏输入的限制，不能推广为 Codex 的全部上传能力不支持。
4. Codex 首轮诊断的 `Target.setAutoAttach` 原拒绝保留。其后使用正式事件
   API 返回的已有 child session 采集；历史 attach 查询的截断与实际触发
   窗口分开记录。页面文字或服务端日志不能补成诊断 API 没有返回的能力。
5. 四个 X 案例每个来源都有 5 次服务端 HTTP 接收：data 两次、redirect
   一次、fail 两次。两次 data 包含直接成功与重定向后的成功；第二次 fail
   也完整保留。正式诊断每来源是一组成功、重定向、失败逻辑请求，原按钮
   各点击一次，没有额外 API 触发证据。底层自动重试只属于可能解释，原因
   未独立证明。第一次最终审计错误假设 fail 只接收一次，失败报告保留，
   后续修正计数没有修改业务、回放动作或删去重复接收。
6. 原收据中部分填值、选项和清空产生的 input/change 为 `trusted:false`，
   原样保留。End、点击与框架操作分别按其原事件核验，不把全部输入事件
   统称为可信用户输入。

## 后续优先级

普通安装 Edge 的人工授权验收仍待用户方便时完成；这不由隔离测试代替。
后续优先处理真实完整任务缺口，不能通过增加相似布局排列扩大通过数。

## 证据保留

冻结 manifest、逐条公开 API 原回执、下载原文件、服务端原始请求、截图、
清理及独审报告保留在本地证据目录；仓库仅发布脱敏摘要和相对证据索引及
SHA，不提交用户绝对路径、凭据或整份原始日志。索引本身不是重新执行证明。

最终独审报告为 `independent-audit/final-v1/final-v2.json`，SHA-256
`1d9e39fc2a791749f70d079a9b932e81b124a3c16fed1889982a66f0845b09d9`。
575 项原件核验通过，表示所有结果已核实，包含预期保留的失败与限制，并非
575 个业务任务成功。八份工具实际交付的原下载共 1,250 bytes，分别匹配本次
原响应；每份字节数、SHA 和正式路径的原件引用均在索引中。

最终核验覆盖 519 个跟踪源文件、65 个生产扩展成员、67 个测试暂存成员与
26 个 SDK 文件；生产内容及 host 与发布版一致。OBU 浏览器被动观测持续
2,758,640 ms、focus 事件为 0；这仅是该隔离浏览器的观测范围，OS 前台仍
未独立测量。Codex 以正式 tabs 库存证明清场，不具备同等连续焦点观测。

## 清场与交付

OBU 测试浏览器、Go host 和外层终端均正常退出；七个测试服务各有原进程
close 回执且退出码为 0，控制终端也实际退出 0。Codex 统一清场只关闭本轮
保留的两份报告，最后测试浏览器库存为空。最终独审核对生产源与冻结构建。

本轮只新增验收设施和结果文档，没有改动生产扩展、SDK 或 host；不重打内容
相同的包。已发布的 [Windows 预览版 e83c6d8](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261016-e83c6d8)
继续作为当前下载版本。普通 Edge 授权验收、独立 OS 前台观测及更广能力与
性能比较仍未完成。

脱敏结果索引 SHA-256：`07bfc2649fa592a0247d406a35b5d25370149a9681d244d227dc1c4cc84081d4`。
冻结协议、manifest 与中途环境/桥接修正均保留原件；旧失败没有被后续结果覆盖。
