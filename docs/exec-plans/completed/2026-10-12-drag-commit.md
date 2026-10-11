# Drag delivery and commit checks

## Goal and current evidence

推进正式 dragTo 在动态页面上的可靠性，保持原 Browser Use 全面能力对齐目标。
上一轮完成变换元素边界/截图、121项完整验收和64a45eb提交推送，属于实际
进展。本片从该干净提交开始，旧51生产文件已冻结。最终完整回归已取得
原process exit0并独立核验；本片完成，整体对齐目标仍active，没有活跃浏览器测试。

源码审计发现 click/dblclick 的按下前 receipt 和提交后不重放未覆盖 drag。
固定 CRX dragAndDrop 分别执行 move-and-down、move-and-up；注入脚本对
drag 的命中 interceptor 直接返回 done。目标移动前的检查不能证明
dragenter/dragover 改位或遮挡后的最后 drop。该初始机制假设现已由下面的
冻结旧版与候选原始记录区分验证，未发生的测试前提不计为真实反例。

## Required behavior

- 仅通过正式公开 dragTo 路径输入；不移动系统鼠标、不选中用户标签页，
  保留光标/点击/元素反馈。root独占所有浏览器进程。
- 原 source 在首次 down 前收到准备 move，仍满足原node、context、frame、
  祖先命中和几何；hover后的变化仅在down之前允许重新准备。
- down开始提交后，错误不得重放source或整个拖动；目标不能在等待中
  悄悄替换成另一节点或文档，再把旧手势提交给新目标。
- HTML dragEnter/dragOver结束之后，在drop提交前核原destination及root点
  的命中/几何。pointer capture合法把move投递给source，不要求destination
  获得click式move receipt。
- 同一deadline、控制权和attachment ticket贯穿mouse与DragManager原生
  Input；setInterceptDrags与dispatchDragEvent也归属同票，避免自我打断。
- 已发出的native请求不冒充物理取消；输入错误由现有tracker做有界清理，
  不在finally调用会意外drop的普通mouse.up。保留未知ACK和清理失败。
- force/trial/预持输入的边界要明确，不能以新保护覆盖普通流程为由宣称
  整体所有输入持平。检查仍非原子，不预言后续布局或原生命令路由。

## Implementation and verification

- [x] 复核仓库/当前正式代码，冻结64a45eb旧生产51文件。
- [x] 旧版真实反例：源hover变化、目标dragover遮挡/替换与原native/DOM/POST。
- [x] 新私有drag事务、原期限/节点/ticket和提交门禁；确定性bundle测试。
- [x] root正常HTML、变换OOPIF、动态负例及pointer capture控制组专项。
- [x] 完整回归保持原121名称/相对顺序，原focus规则不变；原始证据独立审计。
- [x] 当前源码/制品身份、Node与复用Go构建输入核验；同步文档/history。
- [x] 仓库docs、hygiene、Action固定SHA与diff检查通过。

源码分工：生产patch与单测、fixture与单测、独立边界审查并行；root负责
runner/build/浏览器/文档/提交。旧preview ZIP不变、不创建PR。不因观察
超时重启已确认活着的进程；运行日志和冻结制品write-once。

## Remaining parity work

本片只是P06/P13的实际能力推进；Codex当前同组文件/诊断任务、Edge
生命周期焦点、Vivaldi输入、更广几何/平台和P01–P15仍按原矩阵开放。

## Design findings retained during implementation

- Native drop内部还会派发dragover后才drop。提交前的远程检查无法插入该
  命令内部；目标及祖先原文档的本地捕获守卫用于阻断已观察到的错误业务
  drop。先注册的window监听器可能已经看到事件，不能称完全原子或回滚。
- 旧DragManager目标首次move只产生dragEnter；显式增加dragOver后，内部
  drop才成为第二次dragOver。测试的第二次覆盖场景在旧版若未触发变更，
  只能记作测试前提未发生，不能误称已证明旧版误投。
- 现tracker的cancelDragging不等于取消CRX截获的HTML drag。应对已记录的
  HTML drag发送dragCancel并确认，再做原native/capture清理和raw mouseup。
  Capture owner可能在释放时执行业务，失败不保证没有副作用或业务回滚。
- 本地事件guard不能在RPC超时finally提前拆除；延迟native命令可能仍执行。
  原attachment登记清理资源，实际native输入结算及取消后才通过已绑定
  context的固定cancel/release lease清理，未知完成保留资源和重试屏障。
  普通Runtime通道在Pause后会拒绝，不能靠它假称guard已经删除。
- 冻结51生产成员已独立核同iRrKtt和64a45eb源码；4个静态JS的Git LF与
  checkout CRLF差异仍明确记录。49个Go构建源及8复用bin匹配原manifest，
  本片未新增Go编译或单测声明。

## Frozen production baseline

`WUVqsn`实际exit1，两个aggregate中control通过、drag失败；七场为三通过、
四失败。root正常HTML、变换OOPIF正常HTML和pointer-capture正控均通过。
source-hover-shift原生mousePressed两次，第一次错误位置产生wrong-source-down
原始POST3710B，公开动作却成功；replace-after-down在replacement节点收到
可信drop并提交错误POST6405B，公开动作也成功。这两项为实际错误副作用证据。

enter-cover仍发native drop并返回成功，但原DOM没有drop/业务POST；仅证明
未拒绝已变化的目标，不能扩写为错误业务drop。late-dragover-cover旧版只有
一次dragover，第二次变更没有发生；正确POST4767B保留，此失败只代表新测试
前提在旧版不成立，不计为旧误投反例。专项2179ms；整轮零activation/focus
及零豁免。原native Input逐条唯一ACK与原POST字节已单独核验，fixture冻结
SHA4491f661…，运行前后保持相同。

## Candidate failures retained

首候选`ecV9Op`实际exit1：七场三负例通过，四正例均因正式dispatcher收到
字符串`done`而非原void返回报错。原始业务记录证明这四场均只向原source
按下一次并完成正确提交；这不能抵销公开API失败。候选已阻止源hover变化
后的旧点按下、replacement drop及两类覆盖的业务提交。内部第二次dragover
产生的drop被早先被动window监听器记录，后装utility守卫阻止业务handler；
原事件不删除。零activation/focus/豁免，全部原任务页/targets清理完成。

确定性审查另发现cleanup callback的总timeout不能约束迟到ACK后的后续
native调用。现固定每次release预算及ended latch，并在每个cancel/dispose
前后检查；显式retry不借原动作过期ticket重新获得输入权。正常已确认drop/up
后的资源释放预算为独立500ms，不宣称属于原action deadline。production
已确认cancel的去重与迟到guard read的资源归属当时仍在补充验证，首候选未验收。

第二候选`Uo9fdU`专项2/2、七场通过，Node1779/1779零skip/cancel。独立审计
核77次native调用各唯一成功ACK（53Input及8guard各三段生命周期）、四正确
原node POST共21482B、三拒绝场零业务提交、九原document/HTML、精确回收与
3033ms零focus/豁免。底层lease的optional checkpoint现贯穿每条原生释放，
真实tracker+bridge+backend链另核晚true ACK、晚异常句柄及exception释放ACK
迟到三反例：期限后不发送下一命令，已确认cancel/release不重发。

这仍不是片段终验：独立审查发现drop本地guard的rect/transform指纹未覆盖
individual rotate及边框原点变化。固定border-box在180度旋转后AABB相同，
非中心显式targetPosition却对应另一局部热点；已有七场默认中心不足以
验证该契约。当时Node反例已证明guard误接受，尚未取得真实browser错误POST。
新增显式position正例、native内部第二dragover的旋转及边框变化反例后，
先在冻结第二候选生产上实测，再修guard并重新完整回归。此前运行保留。

七场版本完整`ls3hTL`原process实际exit1，121/122：旧extended-input场在
source down事件隐藏原destination，仍只接受timeout；新契约立即返回明确
delivery失败，旧断言因此失败。现保留missing-target超时规则，仅将按下后
失效断言改为准确terminal错误，并新增唯一可信source down和零drop检查，
继续要求后继原生move按钮为零、turn-end释放。这是明确的提交后契约变化，
不是将原失败计为通过。旧121名称/相对顺序保持，235531ms仅原12activation
及4controlfocus，未增加豁免；该版本及其失败/来源报告独立保留。

## Final verification and outcome

新增三场保留原七场及九份HTML逐字节不变，使用非中心显式position、独立
12×12业务热点及浏览器零尺寸marker。冻结中间生产`7ZpaaO`实际exit1、
8/10：individual rotate180和border左/上4→24保持原node/document及AABB，
却在内部第二dragover后将drop交给错误局部位置，分别提交10242B/10238B
错误POST且公开成功。旋转后的正确root点(556,286)、border变化后的点
(494,264)均区别于原native(474,244)。这两项真实反例补足默认中心测试。

最终guard指纹涵盖individual transforms、transform origin/box、border/
padding、box尺寸、perspective/motion-path、祖先与viewport滚动，保留纯
color/shadow变化。源码还修复公开void返回、已确认cancel去重、late read
及异常remote对象的归属；原attachment固定清理lease逐条native核预算，
迟到ACK不允许启动下一命令，显式retry不重复已确认cancel/release。

最终专项`rxSklf`实际exit0、2/2 aggregate、十场全通过；完整`I0B25O`原
process实际exit0、122/122。原121名称/相对顺序保持。两轮均独立核110条
记录调用与唯一成功ACK（77 Input、11原guard各3条生命周期）、12原文档/
HTML、5正确业务POST及5拒绝零业务提交；POST总字节专项28630、完整28633。
10任务tab和12 fixture URL精确回收。显式root position逐轴误差≤.025CSS，
不扩写为OOPIF亚像素保证。早页面监听器看见但被guard截住的drop记录保留。

专项4328ms零activation/focus/豁免；完整237777ms仅既有12activation及
4control-popup focus，无新增豁免。sentinel身份/选择保持，高1222→1165；
旧host按测试SIGTERM，新host exit0。Node1788/1788、零skip/cancel。
51生产/53stage由当前源码独立重建核验；之后只收紧MODIFICATIONS一句
预持输入说明，最终普通ZIP其余50成员与两轮实跑逐字节相同。包SHA256为
`e23512290eaabe80b5d102d77632e6db893535e53790a5b6f350c4e17b4a7ea9`。
旧preview三ZIP仍匹配原checksum。Go/SDK未重跑，49构建源/8复用bin匹配
原build manifest；不把复用制品核验算作新编译或跨平台验收。

force/trial及预持Playwright modifier/鼠标按钮仍沿继承分支，其他账本
held/unconfirmed输入由admission拒绝。正常500ms资源释放预算与原输入
deadline分开。检查非原子，capture释放可能触发业务；持有guard时worker
丢失后的实际恢复尚未验证，保留guard可能暂时阻挡人工drop，不能按超时
自动拆除来冒充原生取消。更广CSS、跨文档drag及完整P01–P15继续开放。
详见[拖放边界](../../references/drag-delivery.md)与
[总计划](../active/2026-10-10-browser-use-parity.md)。
