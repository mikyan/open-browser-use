# 正式 managed 浏览器中的独立 Agent 研究任务

## 目标和当前证据

完整 Browser Use 对齐目标继续 active。上一轮完成恢复后人工/Agent 接续的真实
六阶段验收，提交 `7043c58` 已推送用户 fork，属于 progress。用户随后要求再打新包，
已交付 preview-20261023-7043c58，记录提交 `5868c51` 已推送。现继续研究验收；
研究设施现已完成下述有限验收，不随安装包交付，不提 PR。用户在验收结束后再次
要求新包，根代理将从本次提交重新构建；交付记录另记，不扩大研究验收结论。

旧 P15 两轮完整比较中，首次研究失败来自测试桥把数字数组传给 finalizeTabs，
随后还关闭了应交付的报告；原失败不改写。第二轮研究已成功，但使用测试 Native Port。
当前 managed 五入口流程为固定 driver，没有独立 Agent 根据新资料解题的同链路证据。
本轮用当前正式 managed 原生主机、公开 JS SDK 与独立 solver 验证该缺口；不预设产品故障。

## 固定任务和隔离

- 两份独立随机材料，均为 research fixture 的动态跨源 variant 3；各自 900 秒业务
  预算，另有 60 秒清理观察。保留所有首次调用、错误和合法替代，不换题洗掉失败。
- solver 不继承准备/评分上下文，只获得公开任务 URL、SDK/Skill 文档、连接参数及
  输出目录。只从页面公开内容取事实，通过公开 SDK 读写；禁止 fixture 源码、私有
  ledger/oracle、直接 HTTP 业务请求、宿主 CDP、隐藏闭包或预写解题 driver。
- solver 在自己的持久 Node 会话中直接导入正式 SDK。通用被动记录器保留原调用和
  真实 this/参数/错误，不翻译任务、不注入选择器、不重试或替代业务动作。
- 每轮只保存一次报告，读取报告和原回执后 finalize 为 deliverable，关闭自己的资料
  页。第二轮使用新 session/turn，保留第一份报告及原既有页，最终恰好两份报告。
- 根代理独占启动隔离 headless 任务浏览器和查看器；不接触个人 profile、系统输入或
  剪贴板。公司 Edge 授权仍按用户要求延期，不在本轮反复询问。

## 共享运行协议

runner 写 `solver/launch-card.json`，只含公开 URL、正式 SDK 路径、原 named pipe、
预算、记录器入口和输出路径。每轮有独立 180 秒启动观察期，供读取文档、连接和创建
记录器；solver 在首次访问任务 URL 前原子写 `start-N.json`（`attempt/taskId/startedAt`），
之后再计该轮最多 900+60 秒的外层等待。marker 是自报起点，真实 900 秒业务和 60 秒
清理仍须用公开调用原日志独立分段核验；不能仅以 marker 或合计 960 秒宣称符合预算。
solver 完成一轮后写原 `attempt-N.json`，包含
`attempt/taskId/success/reportTabId/summary/startedAt/completedAt`；失败同样终结该轮。
runner 在实际核验、原结果查看及 deselect 后写 `ack-N.json`，只含 `attempt/continue`，
不反馈答案。第二轮只在第一轮原回执与 ACK 完成后开始。首次业务从公开 API 访问任务
URL 起计，清理单列；没有可信时间字段时记未知，不从总 wall 倒推模型思考时间。

## 验收

1. 冻结生产、EXE、扩展、SDK、浏览器及脚手架；明确复用构建与新执行证据的边界。
2. 真实 `managed run/status`、原 Browser/Native 身份、独立 solver 的正式 SDK 操作。
3. 公开调用回执含三家当前报价/条款与六条原 URL/修订；独立重算全部事实、总价、
   不合规理由、推荐和报告文字；每轮唯一原 POST、原回执及报告页面读取。
4. 被动 tab 原事件/前后完整库存核对资料页关闭、报告保留和既有页 URL/window/group/
   pinned 不变。研究路径不预设固定五页；来源 GET 数量按原记录保留，不冒称严格一次。
5. 每轮以及两轮结束后实际 viewer 选择原报告，核 readonly lease/stream/seq 和实际解码
   PNG；目视原报告。图像不是业务原字节或 native 生命周期的替代。
6. 只读 OS 观察启动早于 Browser，停止晚于两浏览器实际退出；保留 foreground hook
   与鼠标位置采样及其间隙。用户鼠标移动不直接归因于产品，采样不证明连续静止。
7. 正式 Stop 等待原 Browser/Native/Job、注册表两视图、pipe、endpoint 和查看器清理。
   任何失败保留原终态和 finally 记录，不通过重开 URL 或重新提交来修复已执行业务。
8. 停止后独审原记录，完成相关文档、history、提交并推送用户 fork。

## 未完成范围

这两份任务不替代 P15 的全部动态表单/研究/多页/frame/上传下载/诊断重复比较，
不构成速度或跨平台持平结论。普通公司 Edge、系统 IME/焦点、真实账号，以及 managed
Browser 进程退出后的接续仍独立开放。后者是实际未实现能力，应在此完整任务基线后推进。

## 进度

- 当前生产未改；已完成两份只读缺口核查，确认选择该完整使用链路。
- managed runner 和通用 SDK 被动记录器已实现；64 项定向检查通过，但不代表实际研究通过。
- 首次正式运行 `mra-LmbD4b` 在 solver 准备阶段失败，原 runner exit 1；结果 SHA256
  `32803aa1faed65652f87d65c04b3838861dd5d69fe6bd83da6abe34dc1e92106`。
  recorder 使用实际 Agent Node 环境没有的全局 `process`，在创建记录器时失败；
  没有 start marker、SDK 连接、研究 GET/POST 或结果帧。失败终态另把文件创建时间的
  小数毫秒用于 startedAt，触发整数校验；两类错误分别保留，不能改写为业务失败或成功。
- 原 Browser/Native/supervisor/viewer 均正常退出，Job 和24个原进程、注册表两视图、
  pipe、endpoint 清理完成；源文件冻结未变。独立审阅确认该范围仅为准备失败与清理。
- 记录器改为显式导入 node:perf_hooks 性能时钟、Buffer 与 URL；保持整数纳秒单位的
  字符串格式，文档明确不承诺纳秒精度，不能跨运行时或旧 hrtime 日志比较原点。
  新增缺少四个宿主全局的隔离回归；root 联合65项定向检查通过，原日志 SHA256
  `1d825ea53b9bf9ccf98b0f6104db5980b76a176cce5fc0109aaf1d728d9ee5ba`。
- 实际 Agent Node 环境用正式 SDK 完成记录器创建、零调用关闭，无浏览器连接；
  原 result SHA256 `edeb1bd939483d01ae61779b90fa94dac781cd109bfcd3c256a8ab29d01853a3`。
  solver 重置旧模块缓存，准备时间须原始 Date.now() 安全整数；协议继续拒绝小数。
- ACK 改为服务器准入就绪后才原子发布，避免 solver 看到 ACK 后先收到旧门禁拒绝。
  下一步冻结全部输入，从新场景执行；首次失败证据保留。
- 第二次原运行 `mra-3PcTYH` 两轮各自读取、唯一提交、交付和原结果查看步骤通过，
  但联合重看前的 viewer 集合断言错误地要求只有两个结果，漏掉原 about:blank。
  原 exit 1 / passed false 与 ACK2 continue:false 保留；结果 SHA256
  `587cb8f4c6b685935d2ed44a1b19959b6174789a98614d91cfb95556f945b73d`。
  finally 正常清理原资源。solver 已核对负 ACK，未重连/重提或改写终态。
- 初始/最终原 viewer 响应证明该页一直为 browser 类型，原 pageSelectionId 不变；
  修正为精确两条 result 子集和全部原 browser 条目、交付身份的联合比对，不关闭原页。
  增加该真实回归及丢页/多页/重复/身份替换负例，联合67项检查通过，原日志 SHA256
  `2dfea061b3b21a313b670eea9b6a2296b9efe587c517e67ce204eedfcee86d58`。
  随后用新随机材料执行完整联合重看与正式 Stop；旧两轮不能补记为完整通过。
- 最终 `mra-Ldr4sE` 六阶段全部完成，原 runner 实际退出 0；两份新材料分别读取
  六个来源、唯一 POST、两份报告共同保留并实际查看，原 blank 保留。29 个原进程
  身份退出，Job、注册表两视图、pipe、endpoint 清理完成。原结果 SHA256
  `7ae013bf7efb2acd165f48307b95a9ce182f9f9dd08530a7381a66559e2689e2`。
- 后置独审核实 257 次公开调用及 12 份当前来源，业务 55.998/58.014 秒，清理保守
  上界 114/103 毫秒。7,356 项机械核对中 7,355 原通过，唯一过严空请求断言的
  原失败保留并据原 `GET /favicon.ico`→404 分类，无未解决验收失败。
  独审 SHA256 `c5bc0c39fbc4576fc51670ac58de93cd5c516b7f1aa5292f70c06475e006193d`。
- 已目视 4 张原生 PNG 和 2 张最终查看器截图；顶部摘要可见，完整表格另据 DOM
  和回执核验。OS 观察 173.127 秒、2,765 次位置采样、前台事件 0、最大间隔
  78.719 毫秒，不据此宣称连续无鼠标移动。文档与记录完成后关闭本计划；总目标
  仍 active，浏览器进程重启、普通公司 Edge 与完整 P15 比较继续开放。
