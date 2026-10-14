## [2026-10-15 01:59] | Task: 完善坐标输入的跨 frame 高亮

### Execution Context

- Agent: `/root` 与独立实现、fixture、证据审查子代理。
- Runtime: Codex desktop，Windows；模型具体版本未由本轮运行环境提供。

### User Query

> 普通 Edge 手工验收暂不方便，继续其他开发；持续推进 Browser Use 实际能力。

### Changes

- 已初始化 Page 的坐标 mouse/CDP 共享小数坐标叶节点读取与原生 border 投影；
  复用原 utility context，不为可选高亮创建 Page 或迁移原 attachment。
- 保留真实临时对象与释放回执；动作失败的调用方只等待既有必要清理，完整
  detach 仍保留可选资源屏障。失败清理须明确恢复，旧动作不能 detach 继任。
- 新增两个正式 warm 六布局浏览器用例和独立 opt-in cold 用例；保留原 POST、
  PNG、原生 ACK、文档与焦点观察。没有重放输入、系统鼠标控制或新焦点许可。
- 同步架构、能力边界和 active plan。没有 PR，没有重打已有预览包。

### Evidence and boundaries

旧源十二个坐标高亮错误保留；首 warm 候选十二个原 PNG/POST 独审通过，65 个
原对象具有精确释放 ACK。独立反例发现可选清理会拖延原错误并改成超时，由此
补两阶段清理。最终 `xS4ddv` 180/180 actual exit0、旧178名称/顺序保持；
Node3666pass/1既有Windows skip。18原PNG/POST、65原对象释放与39文档清理
独审通过；533,948ms仅原12activation/4control-focus许可。原输入顺序与错误
来源保留，完整边界记在[坐标反馈](../../references/raw-frame-feedback.md)。

冷 raw CDP 三布局仍错误，8,625B 原提交与原 PNG 已保存；未创建引擎或更换
原 attachment。冷路、普通 Edge、全屏和整个能力矩阵均未声明完成，计划保持 active。

### Main files

- `scripts/raw-pointer-feedback.mjs`、`scripts/patch-pointer-feedback.mjs`
- `apps/chrome-extension/browser-pointer-feedback.js`
- `apps/chrome-extension/background.js`、`browser-action-engine.js`
- `scripts/browser-integration/frame-target-feedback-fixture.mjs`
- `scripts/browser-integration/cold-raw-feedback-fixture.mjs`
