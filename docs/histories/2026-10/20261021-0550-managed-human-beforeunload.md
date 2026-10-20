# Managed 人工接管离页确认

## 用户诉求

持续推进 Open Browser Use 与 Codex Browser Use 的能力对齐，保留独立浏览器
和不占用系统鼠标的操作路径。无需 PR；已交付的预览包不因本轮开发自动重打。

## 当前变更

新增普通未保存表单的 beforeunload 诊断，复用原 managed 弹窗 runner 的启动、
SDK 交付、查看器接管、来源绑定及真实退出清理。扩展现有有界原生观察器，
按显式选项记录原弹窗、导航、默认上下文和发送回执；不记录输入文字和弹窗正文。
包装保持原发送参数、receiver 和 Promise，诊断不能作为无插桩功能验收。

保留启动前清单校验失败 `mbu-cDStXd`。旧 runner 补纳入构建已有的根脚本
测试文件后，29 项定向检查及来源完整性核对通过。真实诊断 `mbu-mf7bh1`
确认单次链接点击后的原 beforeunload 被自动取消，查看器未提供选择，人工
接管结束；原文档和草稿仍在。25 个原进程身份退出，原注册和管道等资源清理完成。
第二条跨站 OOPIF `target=_top` 诊断 `mbu-BFMeNn` 确认导航开始先于弹窗，
同样自动取消并结束接管；原根/子文档和草稿保留，28 个原进程退出及资源清理
完成。两条失败证据独审分别 91/99 项通过，不能当作功能通过。

实现修改核心、后台同文档校验、Go 协议与查看器：为旧文档保留独立
离页决策证明，区分 Closed 的实际结果和原生处理 ACK；取消后恢复原事件记录
并建立新的输入 generation，确认后等待真实后继文档。查看器提供“留在页面／
离开页面”。分层检查、完整构建和正式真实浏览器验收均已通过。

首个整体构建 Go test/vet 与 3,242 项 Node 检查通过但未运行浏览器。独立
复核发现迟到原网址提示会误取消合法离页决定；保存纯内存原失败和无提示
对照，修复为使用原 departure ticket 核对 pending 期间的旧文档，保持原
候选验证与回执等待。修复后独立 14 项及相关 555 项定向检查通过；后台和
结果页另 70 项检查覆盖同 URL 替换拒绝及网站权限。正式脚手架修正输入队列
未发完即取证的时序缺口，39 项通过；没有重放原手势或放宽回执检查。

更新整体构建通过 Go test/vet 和 3,256 项 Node 检查。首场正式根路径
`mbu-lcCkr2` 已确认 Stay 后同文档保留并可继续编辑，Leave 原 ACK/Closed
及后继提交也出现；但测试错误地比较扩展 worker 与 Node framesent 通知
时间，因 1 毫秒倒序退出 1。保留原失败与 27 原进程清理结果，不算功能完成；
后续改为按同来源事件序列和确切协议回执核对；40 项脚手架检查通过，原失败
保留。最终根路径 `mbu-ujOpm6`、跨站 OOPIF 导航父页 `mbu-uEnxlF` 均实际
退出 0，完成 Stay 原文档续写、Leave 新文档及原帧、End/Resume、新 SDK
turn/claim、唯一 POST、原响应、再次交付及 Stop。两场事件/业务独审分别
449/505 项通过，来源/生命周期独审分别 91/85 项通过；25/27 个原进程退出，
22/19 张 PNG 完整解码。原结果、构建和审计哈希见离页确认参考。

根代理目视后继原帧和选择卡片，确认正文与按钮可读。两张后继原 PNG 字节
相同；批量工具展示引起的局部绘制误判已经单图重读纠正，不记为产品缺陷。

用户期间要求的新包已从干净 `3e61b68` 单独重建、核验并发布；其功能与
96595fc 相同，不包含本项增量。打包记录单列，本项不自动再次发布。

## 关键文件

- `scripts/browser-integration/managed-human-beforeunload-check.mjs`
- `scripts/browser-integration/managed-human-beforeunload-fixture.mjs`
- `scripts/browser-integration/managed-human-dialog-check.mjs`
- `scripts/browser-integration/managed-human-native-trace.mjs`
- `scripts/browser-integration/managed-beforeunload-observation.mjs`
- `apps/chrome-extension/managed-human-control.js` 与原文档 graph/events
- `apps/chrome-extension/background.js` 的同文档校验
- `internal/managedprotocol/dialog.go` 和 `internal/managedviewer/ui/viewer.js`
- `docs/references/managed-human-beforeunload.md`
- `docs/exec-plans/completed/2026-10-21-managed-human-beforeunload.md`

## 设计约束

beforeunload 属于尚未离开的旧文档。普通页面点击与浏览器发起导航存在不同
原生事件顺序；仅放开弹窗类型不能证明取消后正确恢复原文档或确认后只操作
新文档。取消/确认、End、原在途回执和真正的文档提交需分别验证。
本次真实验收不证明公司 Edge、完整 SSO/MFA、所有浏览器发起导航或系统焦点
隔离；Browser Use 全面能力对齐仍在继续。
