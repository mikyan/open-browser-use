# 2026-10-21 | 人工双击与三击

## 用户诉求和范围

持续推进 Browser Use 能力与 Codex 对齐；使用现有 fork/Skill，不增加 Pi
适配、不提 PR。此前请求的新包 `preview-20261021-748af2f` 已发布，本片
继续修复人工输入缺失的原生多击，尚未加入发布资产。

## 改动和原因

原查看器只转发 pointer down/up，原控制器固定点击计数为一，丢失按词选择
与网页 dblclick。新增固定租约能力 `pointerClickCountVersion: 1`，从可信
mousedown 的原计数发送逐次输入；旧扩展仍保留原单击路径。完整本地序列
才能延续次数；up 匹配原已 ACK down，未知输入不重试，导航/End 清新输入
权限，通用 tracker 的清理仍保留零点击计数。

新鼠标路径在窗口接收真实 move/up，持键越界、失焦和取消结束接管。审查
补齐原能力在晚 Begin/状态中的固定检查，以及弹窗和文件卡片禁用画面所致
的 mouseleave 与真实几何越界的区分；没有借新计数放宽原租约权限。

主要文件为 `internal/managedviewer/ui/viewer.js`、`internal/managedprotocol/`、
`internal/managedviewer/human.go`、`internal/managedbrowser/managed_user.go`、
`apps/chrome-extension/managed-human-control.js` 及相邻回归。
集成脚本复用原人工接管流程，仅增加多击 fixture/workflow，不复制生命周期。

## 验证及原始失败

UI 八项旧实现失败、能力两项旧门禁失败，扩展与 Go 的原失败均保留。
最终 UI 193 项、相关扩展 311 项、Go 三包 test/vet 通过；独立 UI 六项
检查及原生合同审查通过。全新 `mso-build-ebanssld` 绑定 463 份源码输入、
79 份扩展，完整 Go test/vet、3,102 项 Node 检查通过。
构建报告 SHA256：
`1fff111e87139320fe2b6008ccf90a292d40e8f12447051532b63457643d1bcd`。

原 `mmc-RFHcjV` 实际退出 1：原双击事件与四次输入 ACK 正确，但 Windows
原生选区 `[6,12]` 含词尾空格，测试误期望 `[6,11]`。三击和业务提交未执行；
正式 Stop、浏览器/Native 退出、Job 归零及查看器退出正常，无强制终止。
原结果 SHA256：
`1393c1ebde10abea64368afb41d64480706438d6e7aa3e19a04fecb602cd5bc6`。

独立 `native-reference-qtvms6` 在同 Chromium、同合成页面、无插件条件下，
直接原生鼠标确认双击 `[6,12]`、三击 `[0,20]`，实际退出 0。该参考不算
产品验收。诊断脚本首次仅因依赖解析退出 1，未启动浏览器；修正依赖入口后
运行。参考报告 SHA256：
`141210a9130aa87bb967b06ad6b4479d6a62ef567f5fff24e0b5dae11ad997d4`。

只修正固定 Windows 测试期望，并增加跨场景完整事件总账与反例；40 项
脚手架检查通过。产品及已构建 EXE 不变，新的 `mmc-VzihL3` 七步实际
退出 0，原十次 down/up、两次 dblclick、选区、End/Resume、唯一原表单
POST 和 Stop 全部通过。根 agent 查看实际三击截图，首行选区与查看器
状态正确；没有操作系统鼠标或个人浏览器。
原结果 SHA256：
`d148ebcb79454c8997d9a7b84c8ccdd212aff63d9dfc13b940f85cf60100b7c7`。

独立原事件 668 项、来源/生命周期 174 项均实际退出 0。原 463 份构建
输入、969 份验收快照、79 份扩展与 26 份 SDK 字节一致；29 个原 PID
及创建时间身份均已退出，Job 归零、双注册、原管道和 endpoint 清理完成，
无强制终止。46 张 PNG 完整解码。事件审计 SHA256：
`fb7e488c5754bcedca892c15f61826efcbc713b37e6ecd8a6ad1eeba8cd3e907`；
生命周期审计 SHA256：
`e11467cd8e94a2c50bd5de5873ad5c4a926a59b962b90ef22089243592619fd2`。

实体鼠标、系统多击设置、普通公司 Edge、复杂编辑器及完整能力对齐仍未
据此验收。下一产品缺口是人工新窗口接续，需独立实现与验收。
