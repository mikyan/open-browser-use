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

### Compatible worker realm lifetime

- 用户目标保持完整能力对齐；已发布的 `preview-20261015-8f090f2` 不包含本片。
- 旧源 `7OWtNq`、`EuhlIy` 实际 exit1 保留。后者直接命中数量断言：同一原
  文档在两个实际 worker 替换后出现 1/2/3 个 passive world。前者另暴露恢复
  claim 前正常 not-attached 探测误判，修复仅限精确探测，不豁免读取失败。
- 新安装身份由独立 IndexedDB upgrade transaction 原子初始化；后续只读，
  transaction complete 才交付，不修补损坏记录。兼容 ABI 复用 world/kernel，
  不兼容闭包须升级 ABI。后台未就绪/存储失败不延长原输入；撤销只阻止读取与
  发布，原 group/private client 清理仍等待实际回执。构建已包含新模块。
- `e6vgkl` 2/2 actual exit0；原生独审确认同 context name/id/unique，数量1/1/1，
  原 document/default context/frame-loader/HTML root 不变。205 原调用结算，
  11组/33对象释放，13Input、三PNG、原POST2454B与8可信DOM事件一致。
  End559ms隐藏，6689ms焦点零事件/零许可，host退出0、连接/精确进程无残留。
- 真实数据库就绪在每代 fixture 输入前有界观察，三次均首读ready；不是生产
  Input等待或原生IDB事件跟踪。新测试依赖fake-indexeddb固定6.2.5，仅用于开发。
  Node三组3881pass/1既有Windows权限skip；source/runtime/dependency无漂移。
  独立组合检查late private attach/allocation撤权后仍清理，97定向全通过。
- 冷六布局 `4UhUBJ`、私有生命周期 `fCGIFC` 均2/2 actualexit0且独审通过：
  六PNG/六POST17463B、13文档、983调用/45Input、51group/165objects及25私有
  attach/detach对齐；End581ms隐藏。生命周期126调用，原risk ACK先于唯一down，
  替换worker不重放/重接管，只有原tab关闭清风险。7104/3944ms零focus与新豁免，
  host/runner原exit0、精确进程无残留。
- 最终 `SfCCYW`180/180 actualexit0、原180名称/顺序保持。54生产源和三专项
  一致；18framePNG/POST42559B、65对象ACK、33输入场179Input/212native、
  26POST179931B、七截图PNG、60正文/15close-removed均独审通过。540693ms
  仅原12activation/4control-popup许可；host重启第一代按原测试终止，第二代
  exit0，七连接闭合、精确进程无残留。Node另钉package/lock和120个fake-IDB
  文件。Go输入及15旧编译程序核同，本轮不冒称重编；旧预览包保持不变。
  跨导航/根重建/child替换、普通Edge、全屏及完整矩阵
  继续开放，本片不宣称目标完成。

### Same-document root replacement acceptance

- 新增独立冷路根替换验收：单次可信应用点击替换documentElement，新的按钮
  位置与尺寸不同；保留原Document、loader、默认及passive context。独立节点
  观察有明确fixture对象组，原释放回执、两PNG、唯一POST和End共同验证。
- `R58uno`原exit1保留：两PNG/业务独审通过，失败是oracle把原detach成功后
  五次exact-not-attached都判为错误。只分类有原成功detach与End请求/ACK、
  无pending/后继Input或attach且精确库存为空的absence；原ok:false/error不改。
  新增11项fixture检查，旧断言及缺End ACK的红例均保留。
- 共享End helper新增仅供此模式的延迟可见性断言：初始读数或可见性失败仍
  单次发送End，保留首个错误并记录后继End/hide错误；默认流程不变。
  十项长期回归覆盖挂起回执及复合失败，其模拟时间不充当原生时长证据。
- 新`0l1om9`2/2、相关`fi8VZ5`22/22均actualexit0且source/runtime无漂移；
  Node三组3902pass/1既有Windows symlink权限skip，实际退出回执完整。
  本轮仅改验收代码，生产沿用`SfCCYW`180/180基线，未重复宣称完整跑数。
- 根替换独审核175原调用（170成功ACK/5原absence）、12组33对象原释放、
  12Input、两PNG、4520B原POST与11可信事件；End556ms隐藏，4453ms焦点
  零事件/许可。原host实际exit0、两连接关闭、精确本轮进程无残留；当时仍
  运行的相关套件被明确排除，不将其同binary进程误报为本轮泄漏或全局清零。
- 相关22名称/顺序与原180过滤结果相同；原6frame PNG/POST14185B、13文档
  End及所选输入/视觉流程独审通过。94055ms仅原两popup activation/两Pause
  focus许可，精确归属保持；两代host原终止/exit0，四连接关闭、精确进程无残留。
- 仅证明同文档根替换之后的下一次冷读取；导航、读中替换、BFCache、child
  替换及整体目标继续开放。下片先验同标签同源完整导航，不预设生产缺陷。
  同步文档并推现有fork分支，不提PR，已发布预览包保持不变。

### 同标签同源完整导航与新预览请求

- 用户询问是否结束并要求再打新包；说明完整能力对齐仍在进行，本轮先收尾
  当前导航验收，再从干净提交制作新的Windows预览，不提PR、不覆盖旧发布。
- 新独立cold-navigation模式保留原raw-navigation前置例，单attachment下A读取
  完整释放后经原公开CDP接口导航到B。检查新Document/loader/context uniqueId、
  同worldName和单当前私有世界；数字ID不要求变化。B输入前检查旧效果已隐藏。
- 共享测试context reducer修正迟到旧销毁事件与数字ID复用误判；原事件不改，
  缺unique字段才允许数字fallback，畸形unique明确失败。确定性旧实现红例保留，
  未据此宣称生产代码存在缺陷或原生复现该事件顺序。
- `Ri2zjD`、world `6jh6nS`、根替换`BFDPU7`各2/2、actualexit0且无漂移。
  Node3919pass/1既有Windows权限skip。两原PNG18039/17986B、唯一B POST2671B、
  八可信事件和九原Input独审通过；首次B输入前隐藏观察不代表连续导航录屏。
- 原生独审核143call/settlement（138成功ACK/5保留absence）、9组25对象释放，
  A drain后一次B导航及实际clear/commit；End565ms隐藏，3706ms零焦点事件/许可。
  原host实际exit0、两连接关闭，三个专项精确进程库存均空；54生产文件匹配基线。
- 本轮只改验收代码，生产沿用完整`SfCCYW`180/180基线；未重新全跑。
  新包包含此前dc95b36的持久世界复用修复，提供安装/覆盖步骤及构建来源清单。
  普通Edge下载路径人工验收、读中导航、BFCache和完整矩阵继续开放。

### Main files

- `scripts/raw-pointer-feedback.mjs`、`scripts/patch-pointer-feedback.mjs`
- `apps/chrome-extension/browser-pointer-feedback.js`
- `apps/chrome-extension/background.js`、`browser-action-engine.js`
- `scripts/browser-integration/frame-target-feedback-fixture.mjs`
- `scripts/browser-integration/cold-raw-feedback-fixture.mjs`
- `apps/chrome-extension/browser-frame-geometry.js`、`browser-native-pointer-feedback.js`
- `apps/chrome-extension/browser-private-targets.js`
- `apps/chrome-extension/browser-native-pointer-route.js`、`browser-private-target-store.js`
- `apps/chrome-extension/browser-pointer-realm.js`
- `scripts/browser-integration/cold-world-lifetime-fixture.mjs`
- `scripts/browser-integration/cold-private-target-lifecycle-fixture.mjs`
- `scripts/browser-integration/cold-native-route-probe.mjs`
- `scripts/browser-integration/cold-root-rebuild-fixture.mjs`
- `scripts/browser-integration/frame-feedback-end.test.mjs`
- `scripts/browser-integration/cold-navigation-fixture.mjs`
- `scripts/browser-integration/cold-navigation-runner.test.mjs`
