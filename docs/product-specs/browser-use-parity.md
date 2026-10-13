# Browser Use capability parity

## Objective and completion rule

持续开发，直到本项目的 Browser Use 实际能力与 Codex Browser Use 不相上下。
该目标覆盖可调用性、页面操作能力、后台体验、稳定性和完整任务表现。
命令名称、示例代码、私有参考实现或只经过 mock 的测试不能证明能力已经可用。
每一项必须从正式交付入口在真实浏览器完成验收，尚未验证的项保持未完成。

用户约束：沿用本项目及现有 skill，不增加 Pi 专属适配；不创建或重开 PR；
不占用系统鼠标，不切走用户正在使用的标签页。已有光标、点击与目标反馈需保留。

## Baseline sources

P12 的同文档根重建反馈恢复已取得真实红绿证据：旧源 `bxYaz2` 两个根重建
场失去全部cursor/outline像素，body-only对照正常，三原提交保持。修复
`RttFgP` 2/2 actual exit 0，三原POST/13,147B、原图层/文档身份和像素通过，
结束567ms不复活；4574ms零focus/activation。相关 `ppBrxc` 11/11通过，
Node3270 pass/1既有skip。完整 `uLJcAS` 157/157 actual exit 0，旧156名称/顺序
保持；三原POST/13,039B与574ms结束清理通过，460,718ms仅原12 activation/
4 control-focus许可，源码/运行时/构建及清理独立核验。不据此关闭普通安装或P12，
见[重建反馈](../references/dom-rebuild-feedback.md)。

P06/P13/P14 的受限网站弹窗决策已通过专项 `cin0qm` 10/10 actual exit 0：
五入口×三布局保留 105 原 POST/26,592B 和 120 原生响应，原 URL/frame、
策略及 cleanup 经过独立核验；37,425ms 零 activation，仅原两次 popup focus。
允许 frame 提交时的权限竞态由有界只读重检修复，实际输入不重放。Node
3251 pass/1 既有 skip。完整 `BNmZJb` 156/156 actual exit 0，旧150名称/顺序
保持；466,299ms仅原12 activation/4 control-focus许可，源码/运行时无漂移。
普通 Edge、beforeunload 后台限制
及整体能力矩阵继续开放，见[原生弹窗](../references/native-dialogs.md)。

P14 损坏网站权限现有独立的显式替换流程：权限不预选，真实保存后仍暂停，
旧请求与文档证明按运行时代号和 revision 撤权；持久 v1 保持兼容。专项
`cnAeAG` 4/4 actual exit 0，原生读取/唯一写入、原页面 1047B trusted POST
及旧任务拒绝均核验，13,298ms 仅既有两次 popup focus 许可。Node 3187 pass/
1 既有 skip。完整 `k3A9Lo` 150/150 actual exit 0，旧149顺序和原12 activation/
4 control-focus许可保持，444495ms无源码/运行时漂移；不关闭 P14 全部验收或普通安装。

P12 根 CSS zoom 反馈错位已有真实红绿证据：旧源 `Ku2blX` 保留四原 POST，
三根缩放场错位而正文对照正确；修复 `pm3Zkp` 2/2 actual exit 0，四原 PNG/
提交及点击圈原几何通过，3382ms 零 activation/focus/许可。下一实际反馈
重采样缩放，不宣称静止页面持续刷新。完整 `AMMJED` 149/149 actual exit 0，
旧 148 名称顺序保持、428874ms 仅原 12 activation/4 control-focus 许可、
源码/运行时无漂移；Node 3151 pass/1 既有 skip。完整 P12 仍开放，见
[缩放反馈](../references/zoom-feedback.md)。

P14 的网站权限读取恢复已接入可信 popup：实际 Pause/drain 后重读，保留原
设置与 revision、不写策略、成功仍暂停。未知、损坏和确认缺失分开显示，
旧任务及旧回复保持失效；启动等待自环、丢失恢复回复和同版本内容冲突均有
原反例。专项 `yU2VGw` 2/2、相关 `GT3npA` 8/8 actual exit 0；相关验收复用
原 popup，不增加焦点例外。受控派生读取故障不等于自然原生存储故障；
首轮完整 `8Fe9ev` 146/148 的两个 fixture 失败保留。最终 `O0mB6k` 148/148、
actual exit 0，旧 147 名称顺序保持，430,422ms 仅原 12 activation/4
control-focus 许可，源码/运行时无漂移；Node 最终 3137 pass/1 既有 skip。
普通安装与整个 P14 仍未完成；后续损坏记录替换进展见上及[网站权限](../references/site-access-policy.md)。

P12 的 HTML 顶层遮挡已保留原截图/提交红例并修复：`FYfrul` 三次原表单
提交成功但光标/边框像素皆为零；Shadow DOM 内手动 popover 后，专项
`kVaOVU` 2/2、相关 `gTjanh` 9/9 均 actual exit 0。焦点、选区和业务弹窗
账本保持，结束后自有层关闭，普通/CSP PDF 仍无污染。相关回归 14,003ms
零前台事件/许可；Node CI 3092 pass/1 既有 Windows symlink skip。
完整 `7uoTMN` 147/147 actual exit 0，保留旧 144 名称顺序，424,958ms
只有原 12 activation/4 control-focus 许可；无新增许可或源码/运行时漂移。
该片不证明全屏、原生 UI 或普通安装，见[弹窗反馈](../references/top-layer-feedback.md)。

P10/P12 的 PDF 反馈污染已保留原实机红例并修复：普通/严格 CSP 页专项
`4A9CWZ` 3/3、相关回归 `h0x9xz` 8/8 均 actual exit 0，原报告八页核验
无光标图像或彩色反馈，后续悬停仍可见，10,369ms 零前台事件/许可。
本片仅打印样式，不替代完整矩阵或普通安装，见[页面导出](../references/page-exports.md#fidelity-and-limits)。

原地交付的真实native中断矩阵已补齐两个after-ACK边界：四场各三布局，
全部actualexit0，12原POST/2680B及原期限后的无重放观察；hostloss部分归属
保留与worker重建撤权、marker回滚/非授权保留分别验收。Node1129/1129，
120清理通过，六旧host EOF0；每场仅三原sole-popup activation、零focus。
这是P02/P13相关的条件场景证据，未解决P12的normal源或其他应用前台，
完整P01–P15仍未完成。详见[原生中断结果](../references/created-page-waits.md#native-interruption-results)。

截至 2026-10-10，已核对官方文档：

- [Browser extension](https://learn.chatgpt.com/docs/chrome-extension)：真实已登录 profile、tab 上下文、Chrome/Edge/Brave/Opera/Vivaldi、网站访问控制。
- [Browser](https://learn.chatgpt.com/docs/browser)：打开页面、点击、输入、检查渲染状态、截图与结果验证；独立浏览器 profile。
- [Developer settings](https://learn.chatgpt.com/docs/developer-settings)：可启用完整 CDP 做深入调试。
- [What's new](https://learn.chatgpt.com/docs/whats-new)：后台多 tab 工作而不接管用户的浏览器。

公开文档不构成精确 API 或性能规范。以下是由这些能力、当前工具表面及用户目标
导出的工程验收矩阵；需要用同组任务补充实测对比，不能宣称已获得未公开内部实现。
仓库 `docs/wiki/browser-client/` 仅作为历史参考，不把旧命令表等同当前完整产品。

2026-10-11 又用当前 Codex IAB 对隔离合成页面做了只读观察：
`playwright.domSnapshot()` 同时展开同源和跨源 iframe，未输出 AI ref token；
CUA accessibility 入口另有数字索引。它不构成 Codex extension 或完整任务
对比，详细范围见 [observation baseline](../references/codex-observation-baseline.md)。

随后使用当前 Codex Edge 扩展完成相同共享表单的三个布局变体，最终任务
3/3；部分 select/OOPIF 操作需替代调用，额外严格 frame 指针一致性 0/3。
本项目最终 `run-6SwxDM` 77/77，七项完整表单覆盖五入口。该同组任务证据
扩大了 P05/P06/P15 覆盖，不代表整体、跨平台或性能已相当；完整记录仍在
上述 observation baseline。

同日又完成[共享研究任务](../references/shared-research-workflow.md)：本项目
五入口×三布局15项全部通过，专项16/16、全套104/104；当前Codex Edge三
布局最终报告3/3，无浏览器方法失败或替代。任务比较当前资料、计算全部
约束、保存准确来源并保留报告/关闭研究页，属于有限合成任务；不是开放
网页研究或全面对齐证明。该端证据导出与服务退出限制另行保留。

## Acceptance matrix

P01/P11 新增[原响应正文](../references/original-response-bodies.md)：正式五入口
在 root/OOPIF/dynamic-OOPIF 读取原 POST 的二进制、UTF-8、空正文与 503。
专项 `dx9EXR` 7/7、actual exit 0；60 次读取对应 60 个原 POST，另验响应 gate、
同 URL 身份、redirect/failure、限额、过期与 Pause。只读接口不重取 URL，实际
在途原生命令继续参与清理。五入口变化仅在 body reader，触发/清理由 JS 执行；
不是完整跨入口并发工作流、流式响应或整体持平证明。随后完整 `tRDnRM`
144/144、actual exit 0，旧 138 名称顺序保留，未新增焦点许可。旧 preview 不变。

P06/P13 新增原生弹窗明确决策：普通 alert/confirm/prompt 已通过五入口×
root/OOPIF/dynamic-OOPIF 的真实结果与原生 ACK 验证。完整默认套件138/138、
加强清理证据后的专项7/7均 actual exit 0，未增加焦点许可。`beforeunload`
虽成功拒绝离页，但浏览器原生 UI 激活任务标签，仍为 P12 未解决项；显式
诊断保留严格失败门禁，不能算入后台通过。见[原生弹窗](../references/native-dialogs.md)。

P10文件选择器便捷入口现支持CLI/计划`--clear`及MCP必填空数组，原chooser
一次提交/归属/期限不变，MCP路径不再经过CLI选项重解释。Go803 test/subtest
pass/27既有Windows skip，integration Node1383 pass/1既有skip，actualexit0。
专项`IlKHn0`5/5和完整`7LDGsE`132/132通过，旧130名称顺序保留；六真实
便捷流程12POST/4954B、194文件字节及原FileList0/清理均核验。专项零focus，
完整362296ms仅原12activation/4controlfocus许可。默认套件显式恢复移到实际
共享导航前，原lazy epoch和64会话空闲回收导致的两轮fixture失败仍保留。
程序化clear事件不称可信输入；普通安装与完整P01–P15仍开放，见
[文件入口验收](../references/file-transfers.md#verification-and-remaining-scope)。

P06/P13组合键新增完整预校验和原action/attachment/deadline输入门禁。
INVALID/未开始REJECTED保留已有输入；开始后UNCONFIRMED清理原附件，
不重放且不释放继任。Node2874 pass/1既有Windows skip；专项`l3BraN`
9/9和完整`BGZwxy`130/130 actualexit0，旧129名称/顺序保持。九键盘场
覆盖root/OOPIF两入口、加号、独立raw持键及两受控partial，9POST/36074B
和32原生命令独立核验。专项74999ms零focus；完整350576ms仅原12activation/
4controlfocus许可。原生ACK不等同所有键盘DOM投递，受控失败不等于自然
故障或普通安装验收；P12和完整矩阵仍开放，见[组合键](../references/keyboard-chords.md)。

P06/P13普通fill现同时要求原生命令完成和原编辑宿主可信input；取消或受控
丢失投递不可重试，页面格式化及原生编辑移除内部span保留事件时语义。
原空值Delete与setter分别验收，独占输入与原attachment清理不释放继任。
Node2800 pass/1既有Windows skip，专项`qyho7y`2/2含17内部场、11原POST/
33416B及六失败零提交、20157ms零focus；最终完整`c4vgmp`129/129 actualexit0，
保留旧128名称顺序，328568ms仅原12activation/4controlfocus许可。该证据
使用隔离loopback Native Port adapter，不能代替普通安装或Vivaldi原生路由
修复；完整矩阵仍开放，见[fill投递](../references/fill-delivery.md)。

P10/P13/P15新增原文件准备确认：`requirePath`要求原Native Port/Browser
generation和root target在准备完成时仍有效，全部child Page.enable结算后
复核；断线及重绑不复活旧waiter。专项`99xibC`3/3通过，四页零业务触发、
原始RPC与旧NetLog门禁/清理均验证；五入口`2WEsDf`2/2、六组同步ready、
30原文件/5200B核验。两个专项零activation/focus/新增许可；Node2605/2605。
完整`9YXWxm`128/128 actualexit0，原128名称顺序保持，303905ms仅原
12activation/4controlfocus许可。
受控relay断开和成功ACK延迟发布不等同自然网络故障；普通启动授权/真实
安装仍未补齐，完整矩阵继续开放。见[原文件下载](../references/original-page-download-delivery.md#readiness-verification)。

P06/P13新增普通idle locator hover投递确认：原生ACK与原节点事件回执同时
成立才成功，菜单覆盖/移动/移除不重放，兼容mousemove保留页面初始化。
确认持输入与未决原生意图分开，实际输入失败须显式释放。Node2552/2552，
最终`TTV0uq`8/8 actualexit0，七投递场景加独立Pause；六原POST/6704B，
八tab/target清理、10015ms清理超时后显式恢复与旧权限拒绝通过；43538ms
零activation/focus/许可。同进程relay避免跨进程毫秒时钟误判，保留两轮
fixture失败。最终完整`Ghqqmo`128/128 actualexit0，原126名称顺序保留，
302099ms沿用原12activation/4controlfocus许可，没有新增hover豁免。
受控丢弃/ACK交付及staged Backend不等同自然事件故障或原生
安装，force/trial/已确认持输入沿用旧语义。完整矩阵仍开放，见
[悬停投递](../references/hover-delivery.md)。

P09/P13截图完成屏障已补：raw root及正式engine发送登记实际capture，原期限
结束不丢失底层完成；Pause保持阻断直到真实结算，原attachment与继任隔离。
Node2467/2467；专项`kSmNJ7`3/3、五场原七PNG已核验，完整`kuWd2o`126/126
actualexit0保留旧125顺序及原12activation/4controlfocus。测试仅持有已生成
PNG的ACK交付，使用loopback adapter与Backend Pause；不扩大为高层external、
真实安装或自然raster故障验收。完整矩阵与旧preview状态不变，见
[截图完成](../references/screenshot-completion.md)。

辅助页现支持`auxiliaryDeliveryVersion=1`原地交付：已有finalizeTabs keep语义
保留原popup/created-page、真实清理后撤权，并在最终写入/验证/回滚时阻断新
scope。`iUAIHY`2/2 actualexit0，三布局3原POST/589B、6原页面及持久marker、
3显式工作页关闭、21清理与旧/新/foreign拒绝通过；3829ms仅3既有sole-popup
activation、零windowfocus。全部Node2339通过，普通`ZUgidL`125/125名单顺序
不变，244371ms仅原12activation/4controlpopup focus，无新增豁免。该片不改变
normal源抢焦点事实；新交付的原生恢复、其他应用前台及完整P01–P15仍开放，
公司preview不替换。见[原页交付](../references/created-page-waits.md#original-page-delivery-evidence)。

Popup源的条件路由专项`wLjyi9`2/2、actualexit0：JS三布局首次接纳原生未owned
child，三唯一POST/589B，正常finalize保留原user页面而撤权；20清理项通过。
只有3次既有sole-popup创建activation许可，零windowfocus；Node260/260。
前提是唯一normal窗口已经focused；生产`backgroundWindow:true`仍为normal，
原失败未修复，其他应用前台及真实native注册仍未完成；当时的辅助页deliverable
缺口由上方后续片补齐。
未改生产或旧preview，详见[条件路由证据](../references/created-page-waits.md#popup-source-routing-feasibility)。

显式恢复已补齐导航/关页后失败清理：closing会话bootstrap只重试自身，
Retry Pause在全局阻断后重试，自动故障暂停保持不重试；并发pending共享，
失败保持隔离且不重放输入/adoption。最终12后端例旧源2通过/10失败，修复后
相关137/137、全部Node2238/2238通过。后续四场真实native专项用精确参数注入
触发Chrome quota拒绝，4/4恢复成立，每场3拒绝/1成功删除；同host/worker、
原期限与旧权限拒绝保持，定向Node146/146。四场仍actualexit1，原生开页与
清理focus/activation没有豁免；自然故障与完整后台体验未完成。见
[原生恢复](../references/created-page-waits.md#native-quota-failure-recovery)。
此前完整普通`B5TASC`125/125、actualexit0，保持原125名称顺序与
已有12activation/4controlfocus许可，不替代故障专项；旧preview不变。
见[恢复边界](../references/created-page-waits.md#explicit-recovery-after-navigation-or-child-closure)。

Native host显式恢复现在可重试已结算的失败新页清理；同7后端例旧3通过/4失败，
修复后7通过，全部Node2226/2226。真实launcher`9QWc6h`验证同worker、不同
host/pipe，matched未交付child原期限内撤权，原网页/窗口位置保留，旧权限
拒绝和fresh来源可用。正常清理成功不等于实机失败retry已验；已交付child
的host-loss成员保留契约也不同于worker替换。整体actualexit1，原生开页与
清理的focus/activation失败不豁免；旧preview未更新，完整后台体验继续开放。
另外完整普通`h6a5W4`125/125 actualexit0，保留原case名称顺序及已有
12activation/4controlfocus允许事件，不替代上述失败专项。
见[host断线证据](../references/created-page-waits.md#created-page-native-host-loss)。

Created-page idle/orphan重启恢复缺口已修；旧源同11例4通过/7失败，新源11通过。
真实worker专项`MIrY1h`验证matched/collected/ended-idle三root child旧权限
撤销、原文档保留及fresh来源可用，持续storage可见原claim隔离→删除；
并非host重启。专项仍actualexit1，原生开页5次focus和失败清理事件无新豁免。
Node2206/2206，15项清理通过；完整普通`EIJz4r`125/125 actualexit0，
242172ms仅原12activation/4controlfocus允许事件，原125名称顺序保持。
这不替代失败专项；OOPIF、host丢失及全面后台体验继续开放，
旧preview未更新，见[恢复范围](../references/created-page-waits.md#created-page-worker-recovery)。

未owned新页`n7WyEq` **1/2、actual exit1**：root两个原生child首次接管、
matched取消与失败清理后的持久撤权成立，但原Control-click仍激活背景源
窗口。诊断把focus定位在原mouseReleased请求之后、adoption之前，ACK先后不固定，
并无捕获到的显式激活命令；同版本Chromium源码支持原生导航路径的解释。
80请求/回复、21项清理及Node111/111保留；OOPIF、正常finalize/full matrix
仍未过，不放宽focus豁免、不更新旧preview。见[新页失败边界](../references/created-page-waits.md#unowned-adoption-and-background-window-focus-failure)。

新页五入口专项`AGsTeb` **2/2、actual exit0**：JS/Python/Go/CLI/MCP各自覆盖
root/既有OOPIF/未来OOPIF，15原生同URL child与15唯一POST/2933B正确。
独立wire记录429原请求及429唯一ACK，15arm/collect/cancel与两道全组门禁
均按实际消息顺序核验。7888ms零activation/focus/豁免，sentinel选择不变，
高度1222→1165；30页、两observer与外部进程清理完成，Browser.close原ACK
及浏览器/host实际exit0保留。Node106/106、typed IPC九方法/32场景通过；
生产/SDK与旧preview未改，普通125基线未重跑。全部child继承原group，
未owned首次接纳、完整生命周期及P01–P15仍开放，见[新页等待](../references/created-page-waits.md)。

最新共享Pause权限修复后，完整隔离Chromium `eRYJ16` **125/125、actual exit0**；
243654ms仅既有12activation/4controlfocus允许事件，无新豁免。扩展/build/
fixture **1123/1123**；七条未绑定来源的后端反例14/14修复通过，原失败保留。
正式新页三SDK/CLI/MCP接口已实现，JS专项`BQyEWc`2/2返回六原生子页并提交
六POST/1160B，3561ms零focus。完整普通回归不代替新页五入口、未owned首次
接纳或完整生命周期；旧preview未更新。见[新页等待](../references/created-page-waits.md)
和[Pause权限](../references/control-lifecycle.md)。

此前完整`I0B25O` **122/122、actual exit0**，Node **1788/1788**、零skip/cancel。
旧121名称/顺序保持。普通dragTo增加原source/target绑定、可信准备move、
down后不重放及drop时本地CSS平面门禁。十场原生110记录调用/唯一ACK、
11guard清理、12原文档/HTML、5正确POST/28633B及五拒绝零业务提交均独立
核实；两代真实误投反例和中间协议/旧断言失败保留。237777ms只有既有
12activation/4controlfocus，无新豁免，sentinel仍选中。专项`rxSklf`2/2，
4328ms零focus；显式root热点逐轴误差≤.025CSS不扩写为OOPIF精度承诺。
正常500ms清理预算与输入deadline区分，实际late ACK及异常对象整链回归
保证期限后不发下一命令、已确认cancel/release不重发。51生产/53stage来源
及正常ZIP已核，最终包仅一处MODIFICATIONS范围说明较实跑更新、其余50
成员一致；旧preview未变。Go/SDK未重跑，49源/八bin沿用manifest复核。
这是P06/P13能力推进，worker丢失guard恢复和完整P01–P15仍开放，见
[拖放提交](../references/drag-delivery.md)。

此前完整`iRrKtt` **121/121、actual exit0**，Node **1723/1723**、零skip/cancel。
原120项名称/顺序保留。正式locator boundingBox与元素截图投影原生border
四角后求root AABB，修复变换OOPIF的边界/裁切；边界查询保留负坐标、离屏、
零尺寸及known no-layout语义，截图仍拒绝无布局/零尺寸；沿用原action期限。
七场八图、15原document/HTML、
223条原生调用各有唯一ACK、零Input及118442B PNG/CRC/十像素见证独立
通过。237085ms只有原12activation/4controlfocus，新增零豁免；sentinel
身份/选择保持，高1222→1190。旧生产五次误裁切及首候选fixture身份错误
均保留；跨renderer退化、一般perspective/DPR及顺序读取边界仍开放，见
[变换元素边界](../references/transformed-element-bounds.md)。51生产/53暂存
成员和普通ZIP一致，旧preview未替换；Go/SDK未重跑，49构建源及八个bin
复核已有manifest。此分片不代表完整P01–P15已完成。

此前完整`DF0lUQ` **120/120、actual exit0**，Node **1699/1699**、零skip/cancel。
原119项名称和顺序保留；单一HTML元素的显式position按padding quad投影，
处理元素自身scale/rotate/zoom/有限perspective，并将叶几何加入click指纹。
新八场25原生Input、8唯一正确POST/83571B、11原文档/HTML及精确回收独立
核实；旧生产八场误位和最初候选两OOPIF亚像素判据失败均保留。
227112ms连续focus只有原12activation/4control-popup focus，无新增豁免；
sentinel身份/选择保持，高1222→1187。正式root投影精度与原生OOPIF事件
量化分别核验，逐轴最大实际root残差0.256823物理像素，不能宣称任意变换下
子页面亚像素坐标相同。SVG/非替换inline/fragment旧约定、hover/drag后置门禁等
仍开放，见[元素position几何](../references/element-position-geometry.md)。
51生产/53暂存成员及扩展ZIP逐字节核验；旧preview未替换。本轮没有重跑
Go/SDK套件，49个Go构建源和八个复用bin与已有manifest一致。

此前完整`tQEVZJ` **118/118、exit0**，Node1642/1642。正式locator上传在
五入口×三布局隐藏input及JS root目录中完成16次原node上传/清空；16唯一
文件POST/17909B、50文件实例/563B、40外部进程actualclose与精确target
清理独立核实，零Input/chooser。目录额外两metadata witness证明API返回前
已完成。原112名称/顺序保留；223212ms账本为原11激活/4控制popup focus
加一项精确自有目录窗口首tab激活；sentinel身份/选择不变，高1222→1165。
SDK JS134/Python99、Go全包通过（26项既有平台skip）；51生产成员及当前
Go源树/制品通过独立核验。legacy省略epoch的误拒经四回归修复，旧候选
专项`Plei2M`7/7、完整`DSSqzQ`118/118与准备失败`QL84QJ`6/7均保留。
本片不证明所有目录frame组合、真实profile恢复或当前Codex文件任务持平，
详见[正式locator上传](../references/locator-file-upload.md)。

此前完整`WLM6bV` **112/112、exit0**，最终专项`uLGdWq`3/3，Node1581/1581。
普通多击/双击/显式modifiers已接入原投递门禁，逐对ACK、每attempt恢复
修饰键，首down后不重放；后续down复核原root点祖先命中及原receipt几何。
旧候选三项祖先变动反例确实失败，新确定性回归通过。四真实场景27条
Input、4唯一POST/19723字节；首击导航350ms确认新文档且无第二击。
原111项名称/顺序保留，212803ms完整focus账本仅原11激活/4控制popup
focus，无新增豁免；sentinel身份/选择保持，视口高1222→1202。首次完整
`NNr3Bp`111/112的GET/文档提交观察失败保留；最终只读观察沿用原5秒预算。
变换frame shortcut、非原子输入、自然Viz根因和完整P01–P15仍未解决。

此前按下前投递门禁经修正后完整`FjHwEx` **111/111、exit0**，专项
`Zth7Xv`14/14、Node1544/1544。原节点可信mouse pointermove和两点局部
命中取代错误的±1坐标等价判断；原root路由、祖先检查、期限、按钮不重放
保持。受控丢move、七份表单及完整原111项通过；212,380ms焦点账本没有
新增豁免。初版`hb2m29`100/111与诊断`9FyKTv`2/5的失败证据保留。
该门禁不能认证CDP事件来源或保证之后的路由，不能关闭自然Viz根因和
整体P01–P15验收；旧发布包未变。

统一诊断`OBaCi6`**12/13、exit1**首次记录Python dynamic误投的页面事件：
原click已返回，但当前root ledger的完整move/down/up/click目标为父IFRAME，
child完整空ledger、无click/change或上传。cancel与实际进程close后7ms观察
完整，不证明click时documentId或native请求对应，生产输入仍未修复。
默认受影响13项`XXyxbu`通过；Node1482/1482、独立143/143。原13上下文
中仅7项明确有pointer采集，另6项未覆盖，诊断证据不能缩小整体验收范围。

此前完整 `1OmROv` **110/110、exit0**，普通专项`ulluP9`13/13、exit0。
本片补齐CLI/MCP/Python失败partial及点击ACK阶段，原异常不被cancel/close
覆盖；普通外部调用器只有实际child close与严格原身份校验后才进行既有
失败DOM读取。Node1467/1467、独立定向106/106通过；生产代码未改。
真实成功路径没有触发失败读取，不把诊断补齐或本轮成功当作动态输入修复。
全套名单/顺序与`0prwDM`相同，193,286ms账本仍仅原11激活/4控制popup
focus，身份/选择保持但视口及末次采样有差异；host重启与任务清理通过。

此前完整 `0prwDM` **110/110、exit0**，原109项相对顺序保留并加入双连接
录屏并发验收。新专项`hmPQNY`2/2、旧生产负对照`rjMBXn`1/2，真实顺序与
更新后的PNG像素验证截图cleanup不会误停后来启动的外部流；Node1416/1416。
完整focus沿用原11激活/4控制popup focus允许项，零新增豁免；sentinel保持
选中但视口高度有变化。该修复独立于动态OOPIF输入故障，既有失败不因本次
通过而关闭；完整目标和旧发布包边界不变。

显式后台窗口已进入正式接口：`createTab({backgroundWindow:true})` 与 SDK
`newTab` 创建独立 `normal`、`focused:false` 窗口，不移动既有页；省略/false
保持原行为。三 SDK 与 CLI/MCP 先协商 `backgroundWindowVersion:1`，旧扩展
不能静默忽略选项。新页在自己的窗口中选中，用户原窗口和 tab 保持原样；
这会增加可见窗口，不等于同窗口 inactive 页已支持目录枚举。归属记录与
原 session 分组并存，用户搬移/分组/pin 后持久撤权，明确 reclaim 按用户页
处理；finalize 只关自有 tab，保留窗口中的其他页，详见
[显式后台窗口](../references/background-windows.md)。

此前完整 `XHmJdq` **108/109、exit1**：原105项名称/顺序保留且全过，新增
四项通过三项。正式后台窗口目录用例在 dynamic OOPIF 首轮 collect 超时，
没有进入该轮 setter；目前缺少该文档的点击/原生投递证据，不能确定根因。
root/static 共12轮中8次可信目录选择、一次合成清空、三项拒绝通过，核验
9POST/20文件载荷/272实际字节。11次激活及四次既有控制popup focus均精确
归因，零未知事件；额外页保留与任务清理通过。生产/host/SDK与前轮相同，
普通chooser新失败观察在本轮未触发。Node1369/1369通过，不替代浏览器失败。

补目录观察后的Node1373/1373通过；专项 `JwX2Bc` **10/13、exit1**，四项
新检查通过，JS单次/JS双连接/Go双连接dynamic collect超时。三份自然故障
在6/3/5ms内完成精确当前文档读取，root有可信frameAdd、child未记录click。
这缩小了点击链路调查范围，但不证明点击时身份、完整鼠标序列或最终根因；
Go观察在原子进程取消/关闭后，JS在cancel前，不能混同两种时序。

后续显式JS诊断加入有界pointer/mouse序列，保持默认六种HTML不变；
Node1380/1380通过。`Cq7i08`2/2、exit0未复现，pointer数据只在失败读取，
本轮未读，因而不宣称已核原鼠标序列或修复生产输入。

后续轻量 `pointer-only` 去掉额外原生命令包装/预先握手，失败才按精确
documentId读取，默认HTML与原动作不变。Node1388/1388通过；`S5wSpZ`
2/2、exit0，6POST/97实际文件字节核验、零焦点事件。仍未触发失败读取，
pointer完整性为null，输入稳定性未完成。随后回到此前13项顺序的上下文，
仅给目标JS双连接fixture加被动记录；诊断不能替代普通验收。

该上下文模式Node1391/1391、独立57项通过；冻结源码三轮为 `yLC7OT`
13/13、exit0，`NuEbdZ` 12/13、exit1，`HakXg4` 13/13、exit0。中间轮Go
dynamic首轮collect超时，click已返回但没有chooser/setter；6ms当前文档
观察仍见child无click/change。JS目标三轮未失败，pointer均未读且完整性
为null，全体业务结果明确保留中间轮失败。输入稳定性及完整目标未完成。

随后Go目标的同13项诊断三轮为`N6jxEP`12/13、`a95b4d`13/13、`gx2jRn`
12/13，actual exit1/0/1；MCP/Python超时而Go均成功、pointer仍未读。原始
失败材料只有root/static各2POST、dynamic零POST，缺少完整阶段/点击ACK/
失败DOM，不能据此确定具体序号或投递原因。该片定向及独立60/60通过，
不改变普通验收的失败状态，也不是生产输入修复。

此前正式完整 `zyiYQg` **106/109、exit1**：原105项名称/顺序不变，隔离世界、
inactive 目录拒绝、正式后台窗口目录、混合 finalize 四项新检查全部通过。
目录16轮核13个真实 POST、30份文件载荷共408字节；12次目录选择有可信
input，另一次显式清空仍为合成事件。每次成功都在 setter 返回的第一条
回调读取同步 witness，后续异步文件字节另核；无效路径/文件误用/多目录
三项拒绝，重复消费不能新增成功事件。默认 inactive 页可信 cancel 且零
上传，限制没有隐藏。原 JS 单次提交、JS 双连接及 Go 双连接的动态 OOPIF
首轮 collect 超时，未调用本轮 setter；原生投递证据不足，回归关系未排除。

本轮连续focus账本为四次新窗口创建激活、一次自然继任、原六次fixture
激活及四次控制popup focus，零未知事件；新窗口用例本身零window focus，
sentinel不变。`UPWXAL`首轮4/5的inactive fixture冷scope错误已修且保留。
Node1347、JS129、Python94通过；受影响Go SDK87与CLI109个顶层测试通过，
另有23项既有平台skip，并非全平台无跳过验收。旧发布ZIP不含此功能；P01–P15
完整范围与未解决问题继续保留。

最新目录分片已修正 `setFileChooserFiles` 的完成契约：对真实
`webkitdirectory` 节点，唯一绝对路径须等原生 ACK 与原节点可信 `input`；
原生 cancel、未知完成或超时明确失败，不重放。默认10秒、可选1–120000ms
的 setter deadline 独立于 chooser wait；普通文件与清空也共享原节点占用。
固定 Chromium 156 拒绝隐藏或非本窗口选中页的目录枚举，因此默认后台
inactive 路径仍不能完成目录上传，能力版本不代表该限制已解除。

前一轮默认 `Ob0pFy` **103/107、exit1**，原105项顺序完整，加两项目录检查。
目录首轮可信 cancel；JS、MCP、Go 动态 OOPIF chooser 等待另有三项超时。
JS/Go阶段证明在 collect、尚未进入该轮 setter；MCP缺少局部阶段记录，
由已完成的 root/OOPIF POST 与调用位置推断动态首轮。原生 Input/intercept
命令证据不足，不能据先前低频症状认定同因，也未排除本次变更的回归。
原六次激活/四次focus均属既有豁免。实验 `Nl0c74` 在独立不聚焦 popup 的
选中页完成 root/OOPIF 目录上传，但动态 Add upload frame 动作超时；不
代表正式默认能力。完整约束见[文件传输](../references/file-transfers.md)。

Go chooser调用器补齐失败partial和原阶段，诊断采集明确限于原生trace、
浏览器metadata及focus，不重新取scope/attach或读取任务DOM。脚手架339项
和Go helper包通过；无hook专项`JWc1eT`9/9、完整`npV0kp`105/105，实际
exit0。完整焦点仍只有既有六激活/四focus；旧`X2wiUq`超时没有复现，
根因仍开放。后续仅修报告原结果被注释污染、采集完整性漏守卫及措辞，
最终诊断`PbIrsJ`2/2；诊断`acceptancePassed`始终false，不能代替能力验收。

选择器提交新增单次消费及原控制完成检查，保留change后合法导航。
旧源码新增回归23项失败、修复后通过；最后补稳定消费错误的一项也有
旧失败/新成功对照。当前Node864+59+296通过，专项`frp1Zt`9/9；初版
完整`WUe0YQ`105/105。最终源码`X2wiUq`实际exit1、104/105：Go动态OOPIF
首轮chooser等待超时，root/已有OOPIF均已真实上传及清空，动态页无POST。
原调用器失败时没有阶段文件，不能区分arm/collect或证明click ACK；未
定位根因、不延长等待、不重放。新单次提交case通过不抵消该失败。
最终源码全套焦点校验通过，仍只有原六次fixture激活和四次popup focus，
不是全套零焦点事件。目录枚举完成、系统钟诊断及完整矩阵继续开放。

MCP现固定stdio服务首次选中的实际连接，断线后明确要求重启服务，不会
将旧tab/epoch带到重新发现的实例。Windows真实IPC边界测试及浏览器
专项`run-ykbo3D` 2/2通过；首次匹配歧义、各SDK连接身份后来按[独立契约](../references/sdk-connection-identity.md)修复，跨平台范围仍按原
规则保留，详见[MCP连接生命周期](../references/mcp-connection-lifetime.md)。
同版本默认`k5giEj`实际exit1、103/104，唯一失败是JS动态跨源frame下载
等待超时；原104项、制品及焦点规则独立复核通过，不把专项当作全套成功。
完整P02/P13与下载触发的未定位问题仍需继续。

下载有界诊断`avWmSX`采集完整、两原case通过，旧故障未复现且没有生产
修复。随后默认`Ve7nKv`原104项87通过/17失败另有最终focus失败；用户
确认对应时段手动操作窗口，因此保留外部干扰背景，不作为干净焦点回归。
五入口下载与下载生命周期均通过，但完整目标及低频触发根因仍未完成。

最新检查点：新生产首次连接检查在Vivaldi `yeWkzC` 中，无TASK_READY即
完成原goto（82ms），但输入仍空、任务失败；更早 `wv2kHQ` 在扩展安装前
About求值超时。默认Brave `i40fyX` 通过且零焦点事件。同版本主回归
`run-p0iiaM` **104/104**、终端exit0及独立审计通过，原case集和焦点豁免
未变。旧 `run-chNw0r` 41/104及最终focus-ledger失败保留；用户确认在
对应时段操作过测试浏览器，不能把它当作无外部操作的回归对照。
完整CI1079项Node（827+53+199）、JS115、Python82及Go通过。目标仍未完成。
后续DOM.focus诊断 `ntZmPW` 原goto73ms、四命令22ms且原节点获焦，
但原fill无输入事件/POST空，诊断完整而任务失败；原 `YMxiBJ` 失败保留。
最终脚手架217/217；默认Brave `KKcjBO` 完整任务、零焦点与独立审计通过。
本片生产/SDK/host/ZIP未改变，无额外点击的Vivaldi输入缺口仍开放。
随后显式hover诊断 `Fm2cYE` 确认原输入框进入悬停状态，但原fill仍没有
输入事件、POST为空；552ms零前台事件。默认Brave `zwqwku` 完整任务、
实际PNG、697ms零前台事件及独立审计通过。脚手架231/231，独立定向63/63；
两轮冻结383源码/230旧结果/47制品成员均一致，没有生产改动。已排除
hover足以修复该输入的假设；下一片补P04，仍不宣称整体能力对齐。

P04位置快照已完成三种原生DPR的五入口专项：`oVaN3m`、`wTM1CH`、
`x5s4pZ`各10/10及独立审计通过，45张PNG与frame内坐标匹配，观察期间
零焦点事件。完整CI通过，最终测试脚手架238/238。新主回归`7YcNf9`
原104项99通过/5失败，另有最终focus账本失败：动态OOPIF chooser未见
原生打开事件并超时，后段窗口变为minimized且popup无法打开。原因仍待
定位，不能以专项成功代替全套通过；旧DPR emulation失败也保留。
用户随后表示本轮“可能点了点窗口”，故该轮可能存在外部操作，不能
作为无外部操作的焦点回归对照；更早chooser超时仍单独定位。
随后opt-in诊断`Yh4Yz7`原两项通过、terminal0，独立核对69条命令ACK、
6次chooser/POST及零前台事件。此次未复现，旧失败原因未定；没有生产
修补，诊断acceptance保持false，失败后只读DOM分支尚未实机触发。
关闭探针后的默认完整回归`ZzBRWH`实际terminal0、原104/104及独立审计通过，结果
不含诊断对象或hook，旧失败仍保留。P04专项与本轮全套均完成，但更广
品牌兼容、平台及矩阵其余边界仍开放，整体目标保持active。
该轮194500ms连续账本仅原六次auxiliary创建激活及四次设置popup focus，
无新增后台豁免，初末root均normal/focusedtrue；不声称全套零焦点变化。
详细边界见[生产首次连接检查](../references/vivaldi-input-diagnostic.md#生产首次连接检查)。

| ID | 能力 | 必须验证的行为 | 2026-10-12 当前证据与剩余缺口 |
| --- | --- | --- | --- |
| P01 | 正式入口 | CLI、MCP、公开 SDK 可做完整任务，不依赖 Codex 私有 native pipe 或临时内联脚本 | JS/Python/CLI/MCP 已通过正式 browserAction 链路；Go facade 已接通，完整任务范围继续扩展 |
| P02 | 本地通信与安装 | Windows/macOS/Linux host、CLI、各 SDK 可连接；多 profile 选择明确；掉线可恢复 | Windows named pipe、Linux Unix socket 的真实 host/SDK CI 通过；三SDK现绑定实际连接，断线/close保持终态，明确新client恢复；原生A/B碰撞反例及六场同backend浏览器恢复通过，见[SDK连接身份](../references/sdk-connection-identity.md)。Windows Edge native registration、大消息分片及旧版本拒绝已验。最终 Windows Chrome 原生 launcher `native-lifecycle-dnAdTC` 3/3：真实 host 崩溃恢复、运行/暂停扩展 reload 与 EOF 清理，无 Port adapter。packed 重连 alarm 的 heartbeat 饥饿已修复且有确定性回归；实际 packed 唤醒时序、macOS 通信及其他平台安装待验。Edge 隔离配置的生命周期焦点验收仍失败 |
| P03 | 浏览器兼容 | Chrome、Edge、Brave、Opera、Vivaldi 的安装与发现正确，按品牌确认 profile 布局及独立或共享的 native namespace | Edge Stable 已有 Windows 注册验收，原生生命周期焦点仍失败。Windows Brave/Opera/Vivaldi selector 和默认 profile 发现已验；手动 ZIP 入口已实现，隔离导出/加载/原生启动已验，生产固定名称安装未实测，共享 Google namespace 保留原 origin；复制 UUID 歧义明确拒绝。Opera 无组路径 `7IDBb7` 与 Brave 原分组路径 `vC2mkf` 真实后台多页验收通过，零焦点事件。Vivaldi 旧初始化失败及无点击fill/逐键空值保留；新 `ttYgKb` 在首文档检查及一次明确输入框click后，原fill、提交、截图和关页通过、零前台事件，其后生产首次连接检查在 `yeWkzC` 无TASK_READY完成goto，但输入仍空，见[输入诊断](../references/vivaldi-input-diagnostic.md)。Linux 仅有官方源码确认的 Brave；其他系统和更广生命周期未验，见 [浏览器安装](../references/chromium-browser-installation.md) |
| P04 | 页面观察 | 结构化语义快照含角色、可访问名称、值、状态；页面/文本/DOM/截图信息可验证 | 原生 ARIA 与 scoped 快照已实测；有界 `snapshotAI` 递归 frame 快照和 capture refs 的真实元数据、五种限额、过期与取消通过。新增 opt-in boxes/结构化frame视口数据，明确各frame内CSS坐标；五入口×三布局×三原生DPR共45张PNG独立核验通过，见[坐标契约](../references/snapshot-geometry.md)。跨frame原子性、父变换的全局投影与更广动态观察仍未保证；最近已完成默认全套`WLM6bV`112/112，旧失败保留 |
| P05 | 定位器 | CSS、role/name、text、label、placeholder、testId、链式筛选/nth；多匹配严格报错；动态元素等待 | 既有原生 locator、strictness、遮挡等待与 capture ref 生命周期已验。新增有界 `has/hasNot/visible/and/or`、同 client/tab/frame 边界和递归 selector 守卫；最终 77/77 中三个布局、重复/隐藏卡片、同源/OOPIF 组合通过五入口。正式boundingBox新增变换OOPIF原生border四角投影，七场边界及截图验收通过；负坐标/零尺寸/无布局与剩余期限保留，详见[边界契约](../references/transformed-element-bounds.md)。更多动态网站组合仍待扩展 |
| P06 | 输入与动作 | click/dblclick/hover/fill/type/key/scroll/drag/select/check；等待稳定和遮挡，不误点；原生及受控表单 | 中文、React/contenteditable、可信逐键输入、HTML 拖放与捕获指针拖动已验。 目标投递门禁已扩展到普通多击/双击及显式modifiers；最终专项`uLGdWq`3/3和完整`WLM6bV`112/112核真实root双击、同源三击、OOPIF丢首move后双击与每attempt抬键恢复，首击导航后无第二击。提交后不重放，后继在原root点复核祖先命中及原receipt，检查仍非原子；本片已移除变换frame shortcut，按实际renderer边界投影并比较初始/hover后/后继down几何指纹，七场专项WmZggR通过且零focus事件，完整t0MP0c119/119、Node1673/1673通过，见[变换frame输入](../references/transformed-frame-input.md)。显式position现按单一HTML padding plane及原生quad投影叶transform，并加入click几何指纹；八场专项和完整DF0lUQ120/120、Node1699/1699通过，原生OOPIF量化、非替换inline/SVG旧约定与hover/drag边界见[元素position](../references/element-position-geometry.md)；普通dragTo现输入前绑定原两节点，可信move及几何准备仅在down前可重复；按下后不重放。目标在原生over后复核，原文档drop守卫检查同AABB下的individual transform及border原点。十场专项及完整I0B25O122/122、Node1788/1788通过，5正确POST/5拒绝零业务提交及原生清理独立核验，见[拖放提交](../references/drag-delivery.md)。force/trial及预持Playwright modifier/鼠标按钮保留继承分支；其他账本held/unconfirmed输入由admission拒绝。hover/raw和更广CSS/跨文档drag仍有边界，见[指针投递](../references/pointer-delivery.md)。七个完整表单流程覆盖label、多字段descriptor与混合多选、幂等check/uncheck、真实frame保存及准确提交；select change本身不要求硬件可信。取消释放可能触发click，不能回滚。Vivaldi `QAMMuD` 的insertText及 `HrDsGN` 的78条key均ACK但无输入；`ttYgKb` 明确click后原fill收到可信输入并正确提交。后者仅证明单次显式流程，不是通用fill生产修复；品牌兼容、更多受控表单与Unicode仍待补 |
| P07 | Frames 与 Shadow DOM | 同源/跨源 OOPIF/嵌套 frame/open shadow 内观察、定位和动作；导航后正确重建上下文 | 同源/OOPIF/嵌套/open shadow 已实测；递归 refs 在 iframe 前插、保留文档重排、20 次重复快照和 8 次替换循环后命中正确节点，frame 生命周期使旧 capture 失效；更多复杂组合仍待补 |
| P08 | 导航与页面生命周期 | goto/back/forward/reload、SPA、popup、关闭、wait URL/load；正确监听早到事件 | 原生 URL/load observer 的短注册与动作完成队列分离，冷 wait→click、五入口 ready→trigger→collect、快速/SPA/中间 URL/redirect、独立 DCL/load/networkidle 和当前状态立即完成均已实测。既有 goto/BFCache/刷新及 auxiliary 原窗口接管保留；Opera 新建单页组消失已用明确无组归属修复，并有真实多页导航、handoff/恢复及关闭验收。正式新页ready/collect已接三SDK/CLI/MCP，五入口`AGsTeb`2/2、15同URL子页/15POST/2933B与7888ms零focus通过；429实际请求及唯一ACK核验原scope、一次触发/提交与两道全组门禁。五入口该轮child继承原group；后续JS三布局首次未owned接纳及原地deliverable已实测，交付native中断恢复和完整生命周期仍待验，见[新页来源](../references/created-page-waits.md)。原生 popup 创建仍抢前台，用户自行移窗后的渲染恢复和 Vivaldi 更广启动时序/输入待补 |
| P09 | 截图与后台渲染 | viewport/full-page/element/crop，尺寸格式正确；闲置后台 tab 重复截图与输入稳定 | viewport/crop/full-page 与离屏根/同源/OOPIF/嵌套截图、导航后新内容已有验收；frame-owner 预滚修复 stable 等待。变换OOPIF元素截图已修复，完整iRrKtt121/121中的八张PNG核原生clip、字节/CRC和内部/边框像素；更广透视与退化renderer边界仍有限制，见[元素边界](../references/transformed-element-bounds.md)。启动 trace 将首窗口停滞定位到 root Surface 依赖和 Chromium testing 实验组；受控基线禁用 testing config 后，定向 3/3、完整 headed 61/61。这是测试环境修正，原配置失败保留，不能宣称插件已兼容所有实验设置；普通 tab 移组撤权与显式恢复已验。新增 `run-ttHLU9` 2/2：两页原生命令静默310.088秒，首次恢复截图及后续更新通过，182图逐像素/原生clip核验；document visibility仍visible，不称hidden节流。更长闲置与更广压力待补 |
| P10 | 文件与数据 | 上传/chooser、下载等待/路径、文本及富剪贴板、媒体/页面导出；真实文件字节验证 | 正式locator直接上传五入口×三布局及JS root目录已完成本片验收，最终`tQEVZJ`118/118，原节点写入/清空、文件字节、无Input/chooser及精确回收通过；其他目录frame组合与当前Codex文件任务对照未完成。上传/chooser、主 frame/OOPIF 文件字节与清空已有验收。目录完成契约已实现 ACK 加可信 input；显式 backgroundWindow 正式路径三布局16轮、13POST/408文件字节通过，默认 inactive 页仍原生 cancel。历史完整 `zyiYQg` 106/109、`XHmJdq` 108/109及自然故障`OBaCi6`保留；按下前目标投递门禁修正后，最近完整`WLM6bV`112/112及此前受影响专项`Zth7Xv`14/14通过，不据此宣称自然Viz根因已消除。HTTP(S) 新 GET 下载的五入口、cookie、精确 ID 路径/取消以及 PDF/MHTML 产物已验；剪贴板固定 Headless 8/8。`run-XnREpF` 70/70 包含有限 image/video/audio HTTP(S)、data/同 frame 同 origin Blob、Canvas PNG 的五入口文件下载；36 实际文件、8 MiB 边界、分区隔离/DRM/污染/超限负例与四种真实 pending read 取消独立核验。HTTP 是新 GET，不复现页面原响应；嵌入字节上限 8 MiB。chooser 准备确认 `run-bE4e26` 9/9、完整 `run-3OY97j` 83/83，30 条上传/清空 POST 与另6条生命周期请求已验。最新页面下载准备确认 `run-lMFHcB` 9/9、`run-k3mDiy` 89/89 覆盖五入口两连接、root/既有及新建OOPIF、原生GUID/范围通知与24份原始响应及实际文件；取消观察后原传输仍能完成。显式Browser绑定后JS原Page路径/实际取消最终专项`M8DwSY`2/2通过，18原POST/Blob文件3120B及两种held传输生命周期核验；随后五入口正例`Fb9uuB`2/2验证30原文件/5200B、6组全部ready后触发、14000ms零focus；正式host未绑定完整`U32iKd`125/125通过。隔离JS负例`AtJMQl`3/3验证合成未owned页、HTTP中断、原Browser流切断和显式重绑，完整NetLog确认一次405 GET来自下载恢复，3184ms零focus；范围见[原文件交付](../references/original-page-download-delivery.md)。普通安装授权、各入口完整负例、危险文件及更多平台仍待补。超过嵌入限制的媒体与headed OS剪贴板仍开放；Content-return 的具体语义及当前 Codex 基准尚未确定，已有正文、PDF/MHTML 与剪贴板内容返回不算缺失 |
| P11 | 调试与诊断 | console/errors、network、完整受控 CDP、事件流及必要等待；错误可定位 | diagnostics 主页面/OOPIF、分页/丢弃/截断经 native 验证。新 CRPage 时间戳边界在原 root/OOPIF/worker handlers 创建 handles 前过滤历史 console/exception/Log；raw CDP 通知保留，实际重放、新 console/error 与换 owner 通过最终 70/70。历史 `run-WMOIim` 69/70 失败保留。边界依赖稳定系统钟，系统时钟跳变后的隔离仍待补。request/response ready→trigger→collect 五入口及冷 main/OOPIF、headers-before-body、redirect/503、精确匹配与有界终态已验；五入口原诊断正文读取及三布局/取消/禁止重取已验，见[正文契约](../references/original-response-bodies.md)；更广调试/流读取未完成 |
| P12 | 后台并行与可视反馈 | 多任务 tab 隔离；鼠标不动、前台不变；光标、点击和目标实时可见，结束后无迟回复活 | targetId 归属、光标/蓝框/点击圈及后台操作已实测。此前完整 `run-5TPsWz` 104 项连续 observer 中，六次测试窗口创建各有首 tab 激活；四条 focus 仅来自两次明确控制面板打开，均精确归因，原 sentinel 不变，没有额外前台事件。新增研究专项16/16为零激活/零focus，75创建、60关闭、15个非活动报告保留且既有tabs元数据不变。新增后台专项3独立任务、31轮、172POST、490渲染区间/563跨owner重叠，A闲置310秒、C结束时B原scope继续，8创建/8关闭、零激活/零focus。同文档根重建的自有图层恢复已有原PNG/提交红绿证据，旧动画、隐藏与同ID页面节点有生命周期保护，见[重建反馈](../references/dom-rebuild-feedback.md)。不是全套零事件；原生 popup 创建激活与更长/更广压力仍有缺口 |
| P13 | 取消与恢复 | deadline、取消、旧 turn 失效、detach、worker/host 重启、断线；不得静默重试有副作用操作 | 持久 epoch、结束取消、移组/跨窗口撤权、可信输入释放、网络/导航/下载 handle 失效与 session incarnation 已验。真实 browser restart/reload `browser-restart-w5chI9` 8/8 含未知输入经 startup witness 的保守恢复。最终 Chrome 原生 launcher `native-lifecycle-dnAdTC` 3/3 增加实际 host 退出和两次原生 EOF exit0；挂起请求及时失败，原 deadline+250ms 无迟到动作，暂停经同 popup 显式恢复。主回归 `run-aZyBs1` 77/77。Edge `native-lifecycle-R7MPzo` 清单隔离通过但出现未知窗口 focus，整项失败且 reload 未执行。drag新增原attachment guard资源屏障，实际HTML cancel ACK先于按钮释放；原node/read晚到异常对象保留归属，底层每条native清理核独立释放预算，已确认cancel/release不重发。实际tracker/media/backend链的三种late ACK反例与十场实机通过，但持有guard时worker丢失恢复仍未实机验证；早页面监听器与capture释放不保证零副作用。未决原生调用可能阻止清理，worker 丢失下载 handle 不保证底层传输取消；三SDK新增实际连接固定，EOF/close后旧client/locator/waits不能因同路径或active变化迁移，fresh client显式恢复；Windows原生IPC及三SDK六场浏览器证据通过；Linux真实Unix socket三SDK验证通过，523 Go/142 JS/109 Python pass，平台skip另记。签名更新/禁启、packed alarm、其他 OS 及更多压力顺序待补 |
| P14 | 用户控制与数据边界 | 全局暂停/恢复、网站访问可配置、任务只能操作其拥有的 tab/target、上传下载边界明确；凭据不入日志 | 全局暂停与真实 popup 已验收；七条等待/数据入口的未绑定预约ID不再授予detach权限，实际pending保留，14后端反例与完整`eRYJ16`125/125通过，见[权限边界](../references/control-lifecycle.md)。新增 exact-origin all/allow/block，保存暂停且旧 epoch 失效，整页 frame 验证、导航撤权、受限 raw/data 入口拒绝和 worker 持久化通过。已结算的策略写失败可由真实 popup 明确重试原候选，原生配额拒绝、持久读回及恢复后唯一提交已验，见[网站权限](../references/site-access-policy.md)。启动读取失败可显式只读恢复，实际 Pause 后保留原设置且仍暂停；损坏记录可通过独立审阅显式替换，保持暂停，运行时代号防旧请求/证明复用。受限原生弹窗三接口绑定原策略及 emitter/document 证明，五入口与拒绝边界已验；允许 frame 提交期间仅在原期限内有界重读快照，实际输入不重放。策略是 Agent 文档控制而非网络防火墙；受限模式更多数据能力、peer 认证、未知持久写及更广浏览器/扩展恢复顺序仍待完成 |
| P15 | 完整任务与性能 | 同一组动态表单、研究、多 tab、frame、上传下载、诊断任务重复运行；记录成功率/时延/资源和 Codex 基准 | 此前 Windows Chromium 156 主 headed `run-5TPsWz` 104/104，新增五入口×三布局研究15项：当前资料、跨源/动态frame、准确比较和来源、单次报告、实际75创建/60关闭/15保留。专项16/16与全套均独立核验原始请求/收据，扩展新增无组任务页与失败创建撤权，Opera/Brave 原生多页另行验收通过。该历史分片CI Node1079（827+53+199）、JS115、Python82、Go全包通过，另有opt-in后台长闲置2/2。最近完整回归`yVGT4D`125/125，旧122项顺序保持，新增六SDK断线/close恢复场景；Node1792、JS142、Python110全过，Go519 test/subtest pass另26平台skip，typecheck通过。244620ms无新增focus豁免。此前`I0B25O`122/122，Node1788/1788；旧121名称/顺序保持，新增十场drag含两代真实误投反例、5正确POST/五拒绝及11guard实际ACK清理；237777ms无新增focus豁免。此前`iRrKtt`121/121，Node1723/1723；原120项顺序保留，新增七场元素边界/八图有独立原始native/PNG/像素/focus核验；此前八场显式position坐标/POST证据仍保留；历史`XHmJdq`108/109与`hb2m29`100/111失败保留。此前上传分片SDK检查JS134、Python99通过；Go全包通过并保留26项平台skip，跨平台CLI构建通过；当前bounds及drag分片未重跑这些套件，沿用源/二进制manifest核验。Codex Edge共享研究最终3/3，无浏览器方法失败/替代；无独立OS焦点证据且测试server强制退出，限制另记。此前共享表单3/3、部分方法替代及严格frame指针0/3与87/89窗口失败均保留；不推断速度或完整持平。原生Chrome生命周期3/3不代替Edge失败；开放研究、文件/诊断同组任务及更多重复/平台比较仍待完成 |

## Browser lifetime implementation and acceptance boundary

本轮已实现跨 incarnation 撤销所有 browser-bound 数字 ID，按原窗口只复用
已记录的 deliverable group，不认同名或同 URL 归属。持久 input journal 在
native send 前写入，持久化等待后重新检查原 scope、deadline、站点证明和
释放状态；失败保持阻断。丢失 worker 不会把空 tracker 当作已释放。

首次迟到 `runtime.onStartup` 不能证明旧扩展 incarnation 中的输入已经
销毁：无 witness 的风险先标记，只有后续不同 profile-start witness 才能
清理符合条件的旧风险；同 witness 重放和当前 incarnation 不清理。Pause
保持且恢复不重放。这些路径的确定性测试不能替代实际 browser restart。

初版主套件 `run-fLR1kz` 63/63 与当时完整 CI 已通过。独立重启专项 `browser-restart-ucmbPs`
0/4 和 `browser-restart-yH1Qzu` 0/4 分别受重启后恢复偏好消失、inactive restored
页尚未加载影响。第三轮 `browser-restart-kTnp4S` 1/4，未暂停重启通过；
暂停场景因交付页持续 lazy/unloaded 未通过两页 DOM 等待。第四轮
`browser-restart-kmDdeo` 2/4 已验证未暂停/已暂停进程重启、任务页 DOM
与 lazy 交付页 metadata；同浏览器 session 状态丢失后 claim 的首次 fill
被遗留 debugger attachment 拒绝，worker-input 恢复亦未通过。不激活或
强制重载页面规避失败。最终新源码 `browser-restart-ShnPfH` **4/4** 通过，
但 P13 保持部分完成。详见 [browser lifetime](../references/browser-lifetime.md)。

针对第四轮的遗留 attachment，显式 claim 的 own-session 探测与精确
native target reset 已修复，未知 input gate 保持阻断；重复 claim 超时
不撤既有 auxiliary owner，也不允许迟到 detach。当前 focused 119/119，
重启专项与新源码完整 CI **760** 已通过（669+43+48），JS 93、Python 63
和 Go 全包通过；最终主 `run-hlPRVD` **63/63** 与打包/source hash 复核通过。

四项真实证据分别是未暂停/已暂停的浏览器进程重启、同一浏览器内清空
session storage 后真实 worker 替换，以及 held pointer/Shift 期间的真实
worker 替换。最后一项证明确有 held input 留在原文档，恢复保持 Failed；
原 tab 实际关闭后才 Retry pause、Resume 并显式开始新 turn。状态清空
不是 extension reload，风险恢复不是空 tracker 释放。每个浏览器进程
独立 observer，重启空档不算连续覆盖；三段 activation 为空，focus 0/2/6
条都对应测试明确打开 popup。startup witness 对未知输入的跨进程清理、
真实 extension reload/update 和原生 launcher 恢复仍未由这四项覆盖。

上述 browser lifetime 分片的历史 ZIP 1,237,392 bytes、44 files / 49 entries，SHA-256
`01f6e2cafdf4efa032fea6b8222a2883adfdcb3e89b647cd9150715bb32718a1`，与验收源文件匹配。
本片完成；完整 P13 与矩阵仍保留以上未覆盖项，目标 active，无 PR、无推送。

## Finite-media final artifact

最终有限媒体制品已独立核验：ZIP **1,245,340 bytes**、**45 files / 50 entries**，
SHA-256 `f4d720f839a0198ae3c5ccfd97c70930368af0e78eb0d9a8b400f7e3fb634e66`。
每个成员与最终 unpacked 及 `run-XnREpF` 验收静态产物一致，原生 Port
adapter 改写的 background/manifest 单独按生产 hash 核对；没有测试钩子或
私有路径。Host 沿用已验证二进制，hash 与实际运行一致，不宣称重新构建。

## Evidence rules

- 每次验收记录源码 revision、运行环境、入口、合成 fixture、断言与结果。
- 集成测试必须检查实际页面状态、可信输入事件、产出文件及活动 tab，不能只检查 RPC 成功。
- 在各平台分别验证真实通信。Linux CI 通过不能覆盖 Windows 产品故障。
- 失败需要区分产品缺陷、测试环境限制、未实现和未验证；未验证不算完成。
- 以可重复的本地合成页面为主要回归，必要时用授权的真实网站做补充，不读取无关用户数据。
- 全部矩阵有匹配范围的证据并完成最终复核前，长期目标保持 active。

正式浏览器验收入口和证据范围见
[`scripts/browser-integration/README.md`](../../scripts/browser-integration/README.md)。
当前测试只替换 native messaging 的本地传输适配，用真实 Go host 与生产
extension/engine；它不替代实际安装后的 native messaging 注册验收。
独立 `native-message-checks.mjs` 使用真实 Edge native messaging，覆盖本片
大消息与旧版本拒绝场景；同样不能代替所有平台及完整用户工作流验收。

本轮扩展重载分片通过八项独立生命周期验收及完整77项主回归。用户恢复提示
依据实时持久风险而非旧错误，风险退役后不再要求重启；不会自动Resume。
无witness风险经两次真实profile-start恢复，有witness风险经一次恢复，
均未用空tracker或相同数字tab推断释放。独立companion跨reload连续记录，
六代浏览器间五个空档保留；零tab激活及22条主动popup焦点事件明确区分。
安装前提、五次失败尝试及CDP临时安装边界详见runner README和browser lifetime。
整体P13仍部分完成，原生launcher/EOF、签名更新、更多平台及P01–P15缺口继续。


最新原生 launcher 验收使用实际 Windows connectNative，无 Port adapter，
Chrome `native-lifecycle-dnAdTC` 3/3；Edge `native-lifecycle-R7MPzo` 因未解释
的 focus 保持失败。相同禁同步测试策略、完整管理 API 清单、连续 observer、
两次 EOF 与 deadline 后的原文档/server 证据，以及所有历史失败和清理范围
见 [验收记录](../../scripts/browser-integration/README.md#recorded-acceptance-and-remaining-edge-focus-issue)。
真实 packed 扩展唤醒、签名更新及跨平台能力仍不能由 unpacked 结果推断。


Edge 原生空闲对照 `native-lifecycle-XlNQ9o` 在无 SDK 动作、host 终止或
reload 的 10,002ms 观测中仍出现一次 focus，与开发者模式气泡日志相差1ms；
Chrome `native-lifecycle-K2qRSM` 的10,015ms无事件。两者诊断完整但 passed:false，
不充当生命周期验收。新脚本默认 Chrome 三场景 `native-lifecycle-0B1hfL` 3/3；
Edge 的真实恢复验收仍未通过，气泡因果未直接证实。内容返回的模糊基准项
不会被替换成凭空设计的媒体 API。跨连接 chooser 与页面下载准备握手均已完成本片验收，详见 [文件传输](../references/file-transfers.md)；未做当前 Codex 上传下载对照，完整 P10 继续部分完成。
