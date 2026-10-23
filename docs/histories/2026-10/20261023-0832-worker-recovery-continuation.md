## [2026-10-23 08:32] | Task: 验证后台恢复后的完整任务接续

### Execution Context

- Agent：Codex /root，独立脚手架审查与原证据审计。
- Runtime：Windows、PowerShell、Node、固定专用 Headless Chromium。

### User Query

持续推进 Browser Use 能力对齐；使用用户 fork，不提 PR。用户要求的新包此前已发布，
公司 Edge 的人工安装授权验收继续延期。

### Changes Overview

新增明确的 worker recovery `--continuation` 模式，串联原提交/交付、真实后台替换、
显式恢复、人工补充/End、一次 Resume、新 SDK/新轮次认领原页、独立后续确认及再次
交付。fixture 分别校验两个不同业务 POST 的原始内容，原业务不能重放。
保留旧默认模式与独立 held-input 模式；补充旧 SDK/结果权限和新连接旧人工租约拒绝，
以及新 SDK 在交付前公开读取最终回执。

既有功能分段测试不能代替同一链路的真实证据。本轮未观察到产品故障，未修改生产。
首轮在 End 后因脚手架使用错误按钮选择器失败；保留原失败与 finally Stop 记录，修正
为实际控件后使用全新独立场景验证，未重试原业务。

### Validation

- 48 项定向 Node 检查通过，runner 语法检查通过。
- 最终真实流程六阶段通过，runner 退出 0；唯一原 GET/POST 和独立后续 POST 均成功。
- 原 Browser/文档/页面位置保留，人工备注与回执经公开 SDK 读取；最终 PNG 实际解码，
  查看器截图可见人工备注、review 与后续回执。
- 正式 Stop 核验原 Browser、两代 Native、Job、注册表、pipe、endpoint 和查看器清理。
- 原失败 61 项、最终流程 74 项独立核验通过；前者仍是失败流程，不改写为成功。
- 生产输入与冻结构建逐字节核对；沿用原 Go/EXE 证据，未重建、未重新发布包。

详见[完成计划](../../exec-plans/completed/2026-10-21-worker-recovery-continuation.md)。
旧人工租约通过新连接探测，不代表同连接 End 后迟到输入；真实账号、浏览器进程重启、
普通公司 Edge 和完整能力对齐仍未完成。

### Files Modified

- `scripts/browser-integration/managed-worker-recovery-check.mjs`
- `scripts/browser-integration/managed-native-recovery-fixture.mjs`
- `scripts/browser-integration/managed-worker-continuation-support.mjs`
- `scripts/browser-integration/managed-worker-continuation-fixture.test.mjs`
- `scripts/browser-integration/managed-worker-continuation.test.mjs`
- worker 恢复参考、能力规格、质量记录、总计划及本次完成计划。
