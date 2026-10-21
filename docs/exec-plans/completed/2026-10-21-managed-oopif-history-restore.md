# Managed Agent 的跨进程 iframe 历史恢复

## 目标和本轮起点

推进完整 Browser Use 对齐目标中的 P07/P08/P15：Agent 在原页面的跨站
iframe 编辑草稿，前往其他页面后返回，能够观察并继续操作浏览器恢复的原
文档。不能用重新加载、新建同 URL 页面或重放填写动作冒充原草稿接续。

上一目标轮为 progress：普通字符按键完成并提交 `dee63f7`，用户要求的新包
`preview-20261021-dee63f7` 已发布，制品核验和上传回下载通过；`0af2bc4`
记录交付，工作区干净。本轮继续开发，不再次打包、不创建 PR。

`browser-frame-adapter.js` 的既有 BFCache 修复从原 session 的 native frame
tree 恢复 local child 及仍有效的 execution contexts；原文档明确不证明
OOPIF 恢复。当前没有本场实际失败，必须先验证，不能从这一边界推断产品 bug。
既有五入口子页 snapshot/fill/download 流程已经通过，不重复认作缺失。

## 原始业务与证据

- A 根页和跨站 OOPIF 各持有独立 document token、原草稿和可信输入记录。
  仅正式 SDK 填写；原链接导航 B，再执行原 `goBack`。
- 原 API 成功和错误分别记录；只读诊断不修复 frame/context、不补操作。
  返回后核根页及叶页原 token、frame/loader 与 `pageshow.persisted`，并检查
  原始请求是否重载。没有真实 BFCache 恢复则记覆盖不足，不能计为功能通过。
- 从正式 snapshot/locator 观察原草稿，并完成一次原 iframe 业务 POST。
  原草稿与唯一服务端接收内容交叉验证。本场不检查旧 capture ref 在另一文档
  的拒绝行为；既有测试不能替代该场景，仍保留为范围边界。
- 使用当前冻结构建 `mso-build-kwztmglh`、原正式 managed launcher 和 Native
  Messaging。新 runner/fixture 在启动前冻结，保留源码、二进制和完整结果。
- 正常 End/Stop、原浏览器及 native host 退出、Job、注册、pipe 与 endpoint
  清理独立验证；页面行为失败不吞掉清理错误，采集完整不等于功能成功。

## 约束

只由根代理启动自有隔离 Headless 浏览器。不得操作个人 profile、系统鼠标、
系统键盘或系统剪贴板；普通公司 Edge 的人工授权继续延期。保留首次结果，
不为取得通过而重复相同已提交输入。执行期间冻结生产与本次 runner。

如发现缺陷，必须用原 session、attachment、frame graph、document/context
身份及实际事件顺序解释，再实现有界恢复。不能根据 URL、旧数字 ID、超时
或不存在的上下文伪造就绪；不越过原清理或副作用操作的期限。

## 工作清单

- [x] 当前提交、发布状态与已完成五入口流程核实；上一轮属于有效进展。
- [x] 找到 OOPIF BFCache 的明确未验边界及相关生产恢复路径。
- [x] 新增原始业务 fixture 和正式 managed runner；10 项定向检查通过。
- [x] 执行当前生产首次基线，区分恢复成功、实际功能失败与没有命中缓存。
- [x] 按实际证据实施必要修复及定向测试；没有缺陷时不为制造改动而改生产。
- [x] 对受影响入口、导航/观察/输入与清理执行适当回归，并独立核验。
- [x] 同步专题文档、history 和总计划，整理专项提交到用户 fork。

返回后的 OOPIF 会话及默认上下文从原生事件序列核对，detach、clear 和
destroy 撤销旧记录。如果没有新的叶 frame 事件，则返回后的 native loader/
parent 字段记为未观察；不能用旧值假装新的回执。两页原 documentId/token、
可信 persisted 生命周期与实际草稿另行核对。

完成本专项不能证明所有 iframe、跨平台、系统焦点或整个 P01–P15 已对齐。

## 首次真实基线

`mof-xqPW7X` 使用冻结构建 `mso-build-kwztmglh`，实际退出 1。根页和
跨站叶页均恢复原 documentId/token、可信 persisted 生命周期和草稿；
原 `goBack`、`domSnapshot` 成功，下一次 `snapshotAI` 返回
`OBU_SNAPSHOT_INCOMPLETE: iframe disappeared during capture`，未继续提交。
服务端仅三个原 GET、零 POST。原 Turn End、Stop、15 个原进程及私有
注册/pipe/endpoint 清理通过；执行期间源文件未变化。

原事件 49 是同 iframe target 的新 session attach，54 是根原 loader 的
BFCacheRestore，新 child session 未产生 execution context。60 的 detach
发生于 Turn End 清理阶段，不是业务失败原因。CRX 在 frame 不存在时跳过
child FrameSession 初始化；异步 frame tree 准备与根 frame graph 置换存在
丢失路径。原 observer 未记录 Page.getFrameTree 的回执，因此该 read 的
精确先后属于源码解释，不能写成已观察事实。修复需覆盖早到及跨恢复的附件。

原结果 SHA256：`98fd3bf71d74caf44c595e79a3df09dcd9767adbf25aa22ac144a5577a64f7b3`。
独立核验 `managed-oopif-bfcache-independent-t3fxf8_m` 555 项通过，证明
失败证据及清理可信，不代表功能通过；报告 SHA256：
`a69e8f1655bdc9340ff2dba913884a317397702376fe449dd060941dc3f4721a`。

## 首个候选定位记录

已实现原 child CRSession 的一次准入、原 FrameSession 的恢复重绑、晚到初始
tree 的 listener/readiness 分离，以及旧 detach 不删除新会话的保护。
`mob-build-_510h5vu` 的 3380 项 Node 检查通过；Go、嵌入 UI、SDK 与锁文件
逐字节未变，复用原 Go test/vet 和 EXE，未重复声称新执行。

`mof-giZbLm` 实际退出 1：原 `goBack` 约 15 秒超时。根、叶文档和草稿仍
真实恢复；child 有原 loader 的 load 和原 Runtime context，但 root 恢复后
没有观察到 load 重报。只执行三个原 GET、零 POST。End、Stop、16 个原
进程及私有资源清理完成。独审 576 项通过，仅核实失败与来源，不代表验收通过。

原事件不足以区分恢复函数提前返回、抛错或初始化等待。先追加有界的原生
命令发送/结算观测；保留原调用对象及业务顺序，不加额外协议命令、不放宽
验收标准。生产代码先保持冻结，找到可证实的原因再修改。

## 最终结果

诊断场 `mof-TfWLh1` 保留原命令结算和共同顺序，仍实际退出 1；底层真实方法
纯执行复现重复 root attach 断言。修复只对已有 root 提交原导航，实际后代仍
走原 frame tree。测试改用 pinned attach 断言，不再让替身覆盖 Map 掩盖错误。

最终 `mob-build-6u_o0xn0` 的 3388 项 Node 检查通过，未变 Go/嵌入 UI/SDK/
锁文件按字节复用此前 Go 检查和 EXE。正式 `mof-VPH3Kd` 全五步实际退出 0，
16 次公开 SDK 调用完成，原两页草稿保持、三个 GET 与唯一 1142 字节 POST
逐项核对；独审 617 项通过。End、Stop、16 个原进程及私有资源全部清理。
同构建既有八下载场 `managed-download-r63pIp` 实际退出 0，来源与取消/
停止清理另作独立核验。完整 SHA、失败记录及来源边界见
[专题](../../references/managed-oopif-history-restore.md)。

专项开发完成，未重复发布包；更多 frame/BFCache 组合、公司 Edge 和完整
能力对齐留在总计划。本专项归档不表示整体目标完成。
