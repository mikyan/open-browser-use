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

### Cold reader foundation increment

- 抽出原几何 factory，公式与生成 vendor 字节保持；新增独立原生读取候选与
  target 持久归属注册表，尚未接入生产 backend 或现有预览包。
- 读取候选绑定原 frame/loader、文档根与 owner；随机稳定 realm 和不可变 DOM
  方法闭包修复了保留的同世界命中篡改反例。实际对象组释放先于自有连接释放。
- 注册表以原浏览器代次和持久 intent 管理独立 target，失败保持精确归属，
  显式恢复不重放输入；补充对象组先失败无法恢复及迟到 fresh 凭据两个反例。
- 原生权限诊断确认显式 `Target.attachToTarget` 被拒绝，独立 debugger attach
  可用。首读取候选 `6Yz3DZ` 的五条远程路因 target 未物化而失败，原记录保留；
  用原生 getTargets 精确物化后仍要求原 no-client 证明，不降低接纳条件。
- 最终诊断 `5pTnPP` 六种布局矩形通过独审：198原生调用、39对象、12组释放ACK、
  6独立target attach/detach、13原文档不变。1,479ms零焦点事件/许可，runner和
  host原exit0且精确进程无残留；没有独立Chrome退出回执。只有动态Add原点击，
  不以此宣称冷路PNG或POST已通过。完整Node3744pass/1既有Windows skip，
  三组原exit0且源码/运行时无漂移。registry真实生命周期及生产接线继续开放。

### Main files

- `scripts/raw-pointer-feedback.mjs`、`scripts/patch-pointer-feedback.mjs`
- `apps/chrome-extension/browser-pointer-feedback.js`
- `apps/chrome-extension/background.js`、`browser-action-engine.js`
- `scripts/browser-integration/frame-target-feedback-fixture.mjs`
- `scripts/browser-integration/cold-raw-feedback-fixture.mjs`
- `apps/chrome-extension/browser-frame-geometry.js`、`browser-native-pointer-feedback.js`
- `apps/chrome-extension/browser-private-targets.js`
- `scripts/browser-integration/cold-native-route-probe.mjs`
