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

### Production integration work

- 生产 backend 与构建接入冷原生路由和独立持久 store。真实 install/update
  事件与两次实际写入才能初始化；未知状态不阻止普通输入。同代次记录只
  授权清理确切私有 target，存储 tabId 不授权根 detach。
- 原输入成功、错误和期限不等待可选读数；全局清理等待实际资源。失败须
  明确恢复，外部根断开后仍保留旧对象屏障和原 opaque target 清理身份。
- 独审复现公共 claim 在旧 allocation 未完成时设置 reset gate，破坏原清理。
  共用 pointer admission 检查修复后，同一回归通过；实际 backend 定向10/10，
  另有只读 Pause/存储拒绝/恢复屏障3/3。浏览器证据另行记录。
- 新 opt-in 三场生命周期 fixture 区分原生 ACK 与受控投递拒绝，最后以真实
  worker 替换观察自动清理；不抹去独立输入风险暂停，不补发旧输入。
- 每个原 attachment 的冷路只保留一个实际读数与一个最新待启动位置；原输入
  不重放、不等待高亮。混合 warm/cold 前序清理完成后会唤醒队列，失败则保留
  原清理屏障并取消尚未开始的候选。原容量和混合队列反例保留，独审106/106。
- 最终冷路 `JVWwm9` 2/2、原 exit0：六PNG/POST、48可信业务事件、13原文档、
  1073原生调用、183对象、56组释放与27私有连接独审通过。六root各attach一次，
  无引擎创建/迁移；8009ms零focus/activation/许可，End568ms后仍隐藏。
- 生命周期 `WbyEaV` 2/2、原exit0：三场126原生调用逐一核验，重启前真实
  risk写ACK先于单次mouse-down；替换worker只清理原私有target，不发Input，
  旧begin/finalize均拒绝。精确测试tab关闭才清同代风险，最终inventory为空。
  焦点事件/新增许可为零，host/runner退出0、精确进程无残留。原runner停止/
  启动与distinct worker/连接是重启证据，没有独立protocol transcript。
- `HruAYH`三布局缺框、`Vaod2E`错误held-input前提及`mjZpUm`storage键序误判
  均保留原失败。后两项仅修fixture，不改生产风险规则。final fixture18/18；
  三组Node3825pass/1既有Windows symlink权限skip，实际exit0且源码/运行时不变。
  Go输入/binary复核后沿用，没有声称本轮重编。

### Final integration verification

- 首完整`6L9esM`179/180、actual exit1保留；MCP的12原正文读取与bytes全通过，
  仅原Page.close后立即tab库存检查失败。Chromium156实际只dispatch beforeunload
  即回Success；原记录没有close ACK/onRemoved时序，不能反推实际移除时刻。
- 仅两份response fixture补原Promise/ACK/onRemoved和有界只读完成观察，保持
  原close各一次、双inventory、错误及超时；不改生产或响应读取期限。58定向
  检查与真实`SN2lmN`7/7通过；15原close三联独审齐全，本轮未重现真实延迟分支。
- 最终`ZXPe7X`180/180、actual exit0，原180名称/顺序保持。18原framePNG/POST
  42559B、65原对象ACK；33场179Input/212native、26原POST180342B；九End、
  11drag guard、五截图drain与七PNG独审通过。574481ms仅原12activation/
  4control-popup许可，逐一核精确对象/区间，未新增例外。
- 原host restart按原测试终止第一代，第二代exit0；连接全部关闭、精确进程
  无残留。最终三组Node3837pass/1既有skip；616源码/18运行时与原快照核对。
  冷路/生命周期后仅两份response fixture变化，生产字节相同；旧失败未覆盖。
- 同步能力边界与计划，提交到既有fork分支，不提PR。预览包未重打；世界/
  context生命周期、事件共存、普通Edge、全屏与完整能力矩阵继续开放。

### Main files

- `scripts/raw-pointer-feedback.mjs`、`scripts/patch-pointer-feedback.mjs`
- `apps/chrome-extension/browser-pointer-feedback.js`
- `apps/chrome-extension/background.js`、`browser-action-engine.js`
- `scripts/browser-integration/frame-target-feedback-fixture.mjs`
- `scripts/browser-integration/cold-raw-feedback-fixture.mjs`
- `apps/chrome-extension/browser-frame-geometry.js`、`browser-native-pointer-feedback.js`
- `apps/chrome-extension/browser-private-targets.js`
- `apps/chrome-extension/browser-native-pointer-route.js`、`browser-private-target-store.js`
- `scripts/browser-integration/cold-private-target-lifecycle-fixture.mjs`
- `scripts/browser-integration/cold-native-route-probe.mjs`
