# Managed worker 替换恢复

这是 Windows 专用会话的实验功能，已包含于
[preview-20261018-853ea92](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-853ea92)。旧 6588984 包不包含本功能。普通安装的浏览器连接与专用
会话不同，本契约不代表普通公司 Edge 已验收。

## 用户行为

扩展后台执行上下文结束后，原浏览器继续保留页面。`managed status` 显示
`degraded`，任务连接不可用。用户明确执行 `managed recover` 后，系统核对
原执行终结、旧 Native 退出和新连接，再尝试清理原查看附件并重新授权原结果。
成功时返回新的查看链接，Agent 仍暂停；旧链接、旧结果选择和旧人工租约失效。
用户可以重新选择结果并接管，继续自动任务则需明确 Resume 和新轮次。

恢复不重新打开 URL，不重新提交表单，也不补发按键或鼠标释放。如果原输入
是否释放不明，恢复会拒绝；用户仍可用 `managed stop` 结束整个原会话。
浏览器本身退出、持久记录缺失、未知附件或无法确认清理时也不建立新权限。
Stop 后保留窗口、浏览器进程重启恢复和真实网站登录恢复不在本片范围内。

## 原结果与原附件

`managed-result-journal.js` 用独立 IndexedDB 保存有界结果 lineage 和只读
view 义务。每次事务核对 run、Browser incarnation、journalId 和 worker epoch，
只在实际 `oncomplete` 后确认提交；请求成功或调用者超时不代表提交完成。
事务内 schema 不符时等待真实 abort 后失败；打开阶段的版本或 Store 集合
异常则关闭连接并拒绝，不修复或重建原数据库。旧 epoch 的迟到写不能覆盖
新 epoch。finalize 在原 ending fence 内等待提交后才发布结果。

新 worker 最初只读取隔离候选，不能自行创建空 journal 绕过恢复。Go 保存初次
可信 open 的 journal 身份，并用新 nonce 校验 replacement 回执。当前精确
tab/target/document、windowId/groupId/pinned 及网站策略再次通过后才签发
新 deliveryId；位置校验不包含 tab index 或完整迁移历史。
已持久撤销的记录不会因移回原位置复活；强制停止前尚未提交的事件历史不保证
保存。恢复不证明 worker 停止间隙没有短暂移位，也不延续旧 delivery 权限。

只读查看先持久记录 attachment intent，实际 attach 完成后再持久确认。替换
worker 只清理该记录指向的原 target，等待真实 `Page.stopScreencast`、在途帧
ACK 和 debugger detach 后才完成恢复。只有 intent、未知结果或失败清理均
阻断准入。新 epoch 已提交但后续清理未知时要求 Stop，不重新初始化掩盖失败。

## 进程、执行与权限

Go 分别记录原执行终结、Native 退出、传输退休和页面资源清理。原
`Runtime.executionContextDestroyed`、`Runtime.executionContextsCleared`
或精确 `Target.targetDestroyed` 可以证明对应执行终结；传输断开或 flat
session detach 不足以证明。新 context uniqueId 和 workerBootId 必须改变，
Chromium 允许复用 worker targetId，因此 targetId 改变不是必要条件。

原只读 controller 的 `worker-execution-ended` 回执仅证明传输退休，明确
`cleanupConfirmed:false`，不能充当原 view 的 stop/detach 回执。旧 HTTP
查看器实际关闭后才发布新查看器；journal、nonce 和私有恢复字段不投影到 UI。

后台可在 StopWorker 后自行启动，不要求人为 Start 才算替换；两条测试路径
均要求原 stopped、新 running 和新的执行身份。原执行和 Native 退出在明确
recover 前必须确认，不假设不同观察器的记录时间早于浏览器自动启动时间。

原 controller 已记录且未确认清理的人工作用风险阻止 bind/open；其他持久
输入风险也会在扩展 prepare/open 时拒绝。浏览器仍可能创建新 Native。Session 的
被动观察器仅在原 Job、确切可执行文件和真实创建时间校验后保留进程句柄，
不授予任务权限。Recover 共用归属登记；Stop 等待观察结束、原 Job 清空及
所有已登记 Native 退出，再清理确切 descriptor。未曾取得句柄的已退出未知
记录不能凭 PID 或路径删除；极短命进程的完整观察覆盖仍有限制。

Stop 前 controller 可报告“等待原 Browser 退出”。只有这个确切临时等待，
且原 Session 与同 controller 的最终清理均成功时，才不再作为 Stop 失败；
其他原错误、超时或未完成清理仍保留。会话终止不能转换成恢复权限。

## 验证入口与边界

- `node --test apps/chrome-extension/managed-result-journal.test.mjs`
  与 `background-worker-recovery.test.mjs` 覆盖事务失败、epoch、持久撤销、
  原 view ACK、held-input 和启动准入；其中浏览器与存储环境为受控替身。
- Go `internal/managedbrowser` 测试核对原执行、新 Native 归属和恢复回执；
  `internal/managedviewer` 的实际 bridge 序列化 fixture 检查公有字段边界。
  fixture 模拟 backend、存储和原生 ACK，不单独证明真实浏览器清理。
- `scripts/browser-integration/managed-worker-recovery-check.mjs` 使用固定
  正式 EXE/扩展与独立专用浏览器；默认模式保留唯一 POST 的原结果及活动
  只读 view，真实停止 worker 后恢复并人工编辑，Resume 次数仍为零。
  `--continuation` 另验人工 End、明确 Resume 和新 Agent 轮次的完整接续。
  `--held-input` 保持独立零业务场景，确认原 Shift/指针按下后拒绝恢复，
  且不补发 release，最后正式 Stop。

### 恢复后完整接续验收

2026-10-23，固定 Windows headless CfT 156.0.8078.12 的 `mwr-c-P5udBb` 六阶段
实际退出 0。沿用与 `preview-20261021-afb415a` 相同生产源的冻结测试构建，
本轮只增加验收脚手架与文档，未修改生产实现或制作新包。流程核对：

1. 原表单只提交一次并交付；活动只读 view 期间真实结束原 worker，确认旧
   Native EOF、新 context uniqueId、workerBootId 及新 Native，保留原 Browser。
2. 明确 recover 清理原 view 并签发新结果权限，仍暂停；旧 delivery 拒绝，
   跨故障保留的旧 SDK 因真实 EOF 报 `OBU_SDK_BROWSER_DISCONNECTED`。
3. 查看器接管原文档，添加人工备注并标记 review；End 等待原清理 ACK 与
   debugger detach，随后实际点击“继续操作”按钮，恰好发出一次 Resume。
4. 新 SDK 明确开始新 turn、claim 原 tab，公开读取人工备注和 review；只点击
   一次后续确认，读取最终回执后 finalize，再验证原结果的实际解码画面。
5. 全程仅原 GET、原业务 POST、关联原回执与人工备注的独立 follow-up POST
   各一次；Stop 核对原 Browser、两代 Native、Job、注册、pipe、endpoint
   及查看器实际退出和清理。

End 后另用新 WebSocket 探测旧 human lease，收到 `HUMAN_STALE` 且原页面
状态/事件不变。这只证明新连接不能复用旧租约；连接的 `humanClaimed` 门禁
即可拒绝该请求，不能据此声称同一 WebSocket 的 End 后迟到输入已验收。
故障发生在只读查看期间，本场景也不证明人工输入在途时能安全恢复。

相关纯测试 48 项通过。首轮 `mwr-c-BreJxA` 因脚本误用 `#resume` 选择器
退出 1，尚未 Resume 或提交 follow-up；改用现有 `#control` 后从新场景验收。
原失败保留，不计为生产修复。证据见
[接续计划](../exec-plans/completed/2026-10-21-worker-recovery-continuation.md)。

本片实际运行、原失败和停止后独审见
[执行计划](../exec-plans/active/2026-10-16-managed-browser-session.md)。
真实 run 核对生产 typed 恢复回执及原 target 的 attached 前后状态，不是独立
逐条 CDP 抓包。Stop 的 session-terminated 证明原 Job 已结束，不是给原文档
补发 keyup/mouseup，也不声称销毁期间仍能观察页面事件。
目录路径影响 Windows Chromium 的 IndexedDB 文件创建；测试使用短目录，
不据此声明所有路径、浏览器版本或平台均已兼容。完整能力对齐仍未完成。
