# Vivaldi 文本输入诊断

此前两轮真实任务都有 fill ACK 后提交空值；`7y16Q1` 又确认同一文档中
填值后的 DOM activeElement 是原 `#note`，但 value、选区和 input/change
记录均没有变化。原始证据见[首文档诊断](vivaldi-initial-document.md)。
这些观察不能证明原生文本命令确实发出，也不能确定浏览器最终输入目标。

## 直接证据与候选机制

这些历史运行所用的 CRX 对普通 text input 先选择并聚焦元素，收到 `needsinput` 后走
keyboard.insertText；生产 input adapter 在发送前保存输入风险并重新检查
权限和截止时间，随后调用原 chrome.debugger.sendCommand。调用 ACK 后
没有实际 DOM 值核验。诊断因此必须同时观察原生命令与页面状态。

后续开发分支已加入[fill 投递确认](fill-delivery.md)：普通文本输入同时要求
原编辑宿主可信 input 与原生命令完成，未确认时明确失败。格式化后的最终值
不作为投递判据，不隐式添加 click，也未修复这里记录的 Vivaldi widget 路由。
下列旧运行保留原行为、证据和结论，不作为新实现的品牌验收。

固定上游 revision `9007248033443cbe529d18cf911d6954f5ce4f49` 的
[InputHandler](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/content/browser/devtools/protocol/input_handler.cc)
在 root frame 文本输入时选 focused widget，Focus 后调用 ImeCommitText。
[RenderWidgetHostImpl](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/content/browser/renderer_host/render_widget_host_impl.cc)
的 Focus 又经 delegate 选择获得页面焦点的 widget。renderer 的
[WidgetBase](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/third_party/blink/renderer/platform/widget/widget_base.cc)
可以在不满足 IME 输入条件时直接返回；
[WidgetInputHandlerImpl](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/third_party/blink/renderer/platform/widget/input/widget_input_handler_impl.cc)
仍安排完成回调。因此 ACK 与实际产生输入是两个条件。

这条上游链只是与症状相容的机制。DOM FocusController 模拟焦点不同于
widget 底层焦点位；公开标准 CDP 没有直接返回这两次 delegate 的选择
结果。键盘分发不经过完全相同的 IME 门禁，但有自己的输入和焦点条件，
不能据源码推断键盘替代一定成功，更不能断言实际输入进入了浏览器 UI。

## 隔离采集模式

显式 `OBU_TEST_VIVALDI_INPUT=1` 仅允许真实 Vivaldi，与其他显式 API
诊断、readiness 和 ownership 开关互斥。内部固定复用已有 readiness
设置及 native API observer，保留原始一次 fill、一次 click 和原 POST
schema；默认验收、生产文件、输入风险围栏及焦点规则不变。

原生 wrapper 记录实际 tab/session、参数和 start/settled/error，保持
原 receiver、参数与返回 Promise，不重复调用。关键 Input 参数必须完整，
其他长函数体仍有显式截断。命令参数错误可以是完整采集到的产品故障，
不能把“记录完整”和“命令正确”混成一个判定。

fixture 在自身脚本加载时安装有界被动事件观察，保存原 note 节点身份、
文档 nonce、焦点/选区、beforeinput/input/change/composition 和真实值。
capture 阶段 defaultPrevented 不是最终取消状态；微任务读取时事件尚未
结束则保留未知。容量满后停止新增事件相关的微任务，避免观察队列无界。
原 before/after 读取附带快照；任务动作结束后只再尝试一次最终读取，
失败不重试。实际 HTML 响应保留字节/hash，不额外请求或预填页面。

native wrapper、事件处理和微任务都有调度成本，不能称为零扰动复现。
`passed` 恒为 false；只有原任务步骤到达、readiness/native/DOM/HTTP
采集完整及严格清理通过，才可标记 diagnosticCompleted。实际任务表现
单独保存。诊断不激活标签、不重新输入、不用 DOM 赋值或键盘替代原操作。

## 首轮结果与下一变量

冻结 v17 后的真实 Vivaldi `PI0rSV` 在输入前失败，终端 exit1。
管理页和观察页分别214/164ms通过；任务页创建 ACK 仍为空 URL、pending
about:blank、loading，22ms后唯一一次 attach 成功。九条 renderer 初始化
命令在末次快照仍 pending 约13.15秒，原 goto 在约10秒截止；没有发出
Page.navigate 或 Input，也没有任务 GET、POST、DOM 或 HTML 证据。
因此 diagnosticCompleted 与 acceptance 均为 false，不能称为再次复现
空输入，更不能将其用于判定 IME 机制。

独立审计确认373源码、216历史结果、host/SDK/47文件原ZIP与实际 staging
一致；三个原生快照同一 boot、连续0→45→45记录，无截断。任务区间零
焦点事件、零豁免，native/browser 实际退出及临时注册清理完整。

下一实验只改变原 newTab 与首次 goto 之间的时序：以独立、有界、只读
检查等待同一非活动任务页的 about:blank 首次提交，再调用原 goto。
它不改变新建页的分组步骤，不激活或重新创建页面，也不重发失败命令；
额外诊断阶段不能算作原动作 deadline 的延长。若未 attach 也不提交，
或 ready 后仍卡住，均按实际边界保存，不能据此加入生产等待。

该变量由单独 `OBU_TEST_VIVALDI_TASK_READY=1` 启用，与所有其他显式诊断
和 ownership 开关互斥，内部复用完整输入采集模式。原 tabs-only observer
读取 tabs.get，已有 worker 读取 debugger.getTargets；无需新增权限或连接
任务 renderer。固定 tab/window/非活动状态，以及首次出现后绑定的原 target；
最多5秒、80样本，只重复成功但未就绪的读取。采样、证据保存共用该预算，
任何读取错误、身份改变或超时都停止，不进入 goto。宽高只记录，不作为
额外门槛。模式名为 `vivaldi-task-readiness-diagnostic`，gate与输入采集
都完整且清理通过才可称诊断完成；acceptance 仍恒为 false。

## 任务提交检查后的实测

v18 的 `QAMMuD` 用两次采样观察到同一非活动 task tab 从 pending/loading
变成 about:blank complete；106ms后结束检查，再执行原 goto，68ms内完成。
这支持继续研究初始提交时序，但一轮成功不能证明生产初始化已稳定修复。

原 fill 的 utility 返回 needsinput，随后唯一 Input.insertText 的实际 tabId
和完整文本均正确，1ms后返回 ACK。三份 DOM 快照绑定同一 documentId 和
原 note 节点；fill后只有 focus/selectionchange，最终另有点击带来的
blur/focus，没有 beforeinput/input/change/composition，实际值始终为空。
唯一 GET 的实际 HTML、唯一 POST 原始字节和可信点击对应同一 nonce；
POST 的 note 仍为空。这排除了本轮“输入命令未发出或文本参数错误”的
解释，仍不能直接确定浏览器内部 widget 路由或 IME 返回分支。

独立核375源码、217历史结果与实际staging/host/47文件ZIP一致；原native
trace的创建、attach、导航commit和utility context/objectId链对应同一目标。
大utility参数/返回存在声明过的截断，关键Input参数与ACK未截断；三条
微任务记录仍保留最终取消状态未知，不能把未知解释为未取消。

本轮 diagnosticCompleted=true、终端exit0，但任务与acceptance失败。
两个任务焦点检查点覆盖515ms、零事件/豁免；native/browser实际exit0、
精确私有进程和注册清理完成，外部输入法进程保留。原收据断言失败先于
截图和finalize，所以本轮没有这两项通过证据。关闭所有诊断的默认
Brave `QC0zdV` 任务通过，四检查点零前台事件，原生进程和注册清理及
独立审计通过；1877×1926实际PNG已查看，光标与点击目标可见，长JSON
收据仍有原先的水平溢出。脚手架180/180、独立定向77/77通过。
生产源码、host与47文件v15 ZIP字节未变，尚未加入生产兼容绕行。

## 独立逐键对照

`OBU_TEST_VIVALDI_KEY_INPUT=1` 仅供真实Vivaldi，与其他五个显式诊断开关
互斥。它固定复用首文档检查与原生观察，在全新任务里保留原39字符ASCII
文本、Delivery note定位器和单次提交，只预先选择公开pressSequentially，
不先fill、额外聚焦或按结果回退。原生实包对此文本走39对down/up，非US
布局字符会转回insertText，故这一实验不能证明Unicode输入能力。

仅新模式增加被动keydown/keypress/keyup及1024记录上限；旧INPUT事件集
和256上限不变。共用observer函数新增分支会改变旧诊断HTML源码字节，
不能宣称其与v18逐字相同；默认非诊断HTML内容不变。所有事件仍保存同一
原note节点、文档身份和完整前缀，溢出或丢失仍使采集不完整。

分别报告原生采集是否完整、是否观察到dispatch且无insertText，以及
具体键数、顺序、目标和文本是否正确。真实DOM键事件、可信输入、实际值
与唯一POST决定任务结果，不从命令ACK推断成功。逐键方法本身的聚焦/选区
语义与fill不同，额外观察也有调度成本；即使通过，也不能直接将它用作
通用fill的隐式替代。

v19 的真实 `HrDsGN` 已完成逐键对照：首文档检查2采样/93ms，原goto
63ms，pressSequentially 92ms。独立重算39对down/up，原root tab、key/
code/text逐字符正确，每个ACK先于下一发，完全没有insertText；同文档
原note仍未收到任何keydown/keypress/keyup/beforeinput/input/change。
唯一POST的note为空、点击可信。故逐键没有解决实际后台输入问题，
不能建议将它作为已验证的Vivaldi替代路径。

独立核377源码/219历史、原host/47文件ZIP和实际staging一致；原生快照
连续0→321→325、134calls，末尾无pending。大utility载荷截断被明确
记录，关键按键参数与ACK完整。DOM为0→4→8记录，只有focus、选区和
Submit后的blur/focus，三条最终取消状态仍未知。508ms连续观察零前台
事件/豁免，native/browser实际exit0与精确进程/注册清理通过；receipt
失败发生在截图和finalize之前。诊断完成，任务和验收失败，内部实际
focused widget仍未观察到。

后续生产首连接验证为INPUT诊断开启透明`metadataReads`记录，额外观察
已有路径实际执行的tabs.get和debugger.getTargets。它不主动调用读取、
改变参数或Promise，也不增加任务gate；默认native诊断不包装这两个
API。旧trace继续按旧profile验证，不能从新增字段倒推旧运行的查询。
记录容量和载荷截断限制保持原值，关键就绪字段缺失或截断时须报告
证据不足；增加观察工作可能影响调度，不称为零扰动实验。
生产提交检查使用精确tab/window/group元数据；getTargets仅是已有原生
读取的旁证，不是新生产检查条件。

下一独立对照在全新任务里预先点击原输入框，再执行一次原fill及一次
Submit，并观察可信pointer/mouse是否进入原节点。固定上游的鼠标路径
按坐标命中widget，而键盘/IME依赖focused-widget选择，故这次对照有
判别力；鼠标Focus仍经delegate且有页面点击副作用，不能假定会修复，
也不能悄悄将click加入生产fill。

对应开关为 `OBU_TEST_VIVALDI_POINTER_FOCUS=1`，与旧六种显式模式互斥，
复用TASK_READY+INPUT而不经过KEY_INPUT。只有此模式新增pointerdown/
pointerup/mousedown/mouseup/click被动观察，仍为256记录上限，保存按钮、
坐标、原node与可信标记；其他模式事件集不变。五份快照依次为点击前、
点击后、fill前、fill后、final，维持同文档/节点与完整事件前缀。原生
mouse move/press/release按两个公开点击的时间窗分别列出真实序列和计数，
不从“一次locator.click”假定底层只有一组命令。事件到达、前提值为空、
实际编辑与采集完整性分别报告，未知时间窗或取消状态按未知保留。

## 点击输入框后的实测

v20 的 `ttYgKb` 首文档检查2采样/101ms后，原输入框click实际发送同一
root target的mouseMoved、左键mousePressed与mouseReleased；原note收到
五种可信pointer/mouse/click事件。PointerEvent坐标与原生命令仅有浮点
精度差，MouseEvent按整数返回。点击后及fill前值仍为空，随后唯一原生
Input.insertText写入完整39字符，原节点收到可信beforeinput/input及
提交时change。唯一POST包含正确note和可信输入、点击证据。

五份快照保持同文档、原node和完整事件前缀，最终18事件/36记录，无
丢弃或溢出；18条微任务的最终取消状态仍为未知，不将其写成未取消。
原生254记录/98calls、最终无pending；大utility载荷有声明过的截断，
关键mouse/Input目标、参数和结算完整。独立核379源码/220历史结果、
原host/47文件ZIP与实际staging一致，只有声明过的两项测试插桩差异。

本轮taskPassed=true，原截图、finalize及实际关页均通过；diagnosticCompleted
为true，诊断模式的acceptance仍固定false。2186×1872、57,552字节PNG已
实际查看，AI光标和正确收据可见，长JSON收据仍有原先水平溢出。1068ms
连续焦点账本零事件/豁免，原生host/browser实际exit0及精确进程、注册
清理通过。所有诊断关闭的默认Brave `TKisEN` 标准任务、独立审计和实际
PNG也通过。生产、SDK、host及ZIP未修改。

结果证明本次明确的click→fill→Submit流程有效，不能将效果单独归因于
mousedown，也不证明浏览器内部focused widget的准确机制、跨版本稳定性
或通用fill修复。旧无点击fill和逐键失败保留；下一生产候选需要无隐式
点击副作用、原动作期限和撤权边界的证据，不能在失败后自动重放输入。

## 生产首次连接检查

随后把首文档检查接入真实冷连接，契约见
[动作协议](browser-action-protocol.md)。本次新建页的精确marker在归属
发布前登记，等创建事务最终通过后才允许检查；动作、observer setup及
transfer共用原期限。已连接页不重复等待，raw attach保留原行为。
它不增加输入框点击，也不修改fill或重放失败动作。

v21首次运行 `wv2kHQ` 在扩展加载前的chrome://version身份页首次求值
20,011ms超时，尚未运行生产代码、任务或focus observer。浏览器精确
exit0、私有进程和临时注册清理通过；没有native连接/EOF证据。该次
runner exit1，不能作为生产gate或零焦点的验收结果。

保留失败后，同源码/包的新profile独立运行 `yeWkzC` 仅开启INPUT，未开
TASK_READY、KEY_INPUT或POINTER_FOCUS。创建ACK的URL仍空；原goto内部
的tabs.get先见loading，再读到原tab/window/group、inactive、about:blank
complete且无pending，随后唯一attach、唯一Page.navigate。原goto共82ms，
没有额外诊断task gate。这直接证明本轮生产路径完成初始化，不能扩大
为启动时序问题已全部消失。

原唯一Input.insertText仍只有ACK，原document/node没有beforeinput/input/
change，实际值和唯一POST的note均空。诊断完整但task/acceptance失败，
收据断言先失败，因此无截图或finalize。403ms连续焦点观察零事件/豁免，
native/browser实际exit0和进程、注册清理通过；微任务取消终态仍未知。
独立核379源码/222旧结果、原host与47文件ZIP一致，大utility截断有声明，
关键tab/Input字段完整，旧失败证据未变。

同包默认Brave `i40fyX` 标准任务、实际PNG、独立审计及清理通过，零焦点
事件。主回归 `run-chNw0r` 则为41/104，另最终focus-ledger失败：出现未知
窗口焦点、两次标签切换且终态窗口minimized。原因未定，不放宽验收或
把它标为通过。完整CI为1079项Node、JS115、Python82及Go全包通过；
此轮生产改动仍不能证明总体能力持平。

用户随后确认在 `chNw0r` 对应测试时段操作过浏览器。旧失败记录保留，
不逐条把事件归因给用户，但该轮不能作为没有外部操作的对照。同源码、
同包的 `run-p0iiaM` 原104项全部通过，终端exit0；独立核379源码/226旧
结果与原host、47制品成员通过。焦点账本的六次激活和四focus全部精确
对应原有fixture动作，未增豁免；15研究任务原始请求/提交与关页也通过。

## 原节点 DOM.focus 对照

`OBU_TEST_VIVALDI_DOM_FOCUS=1` 是单独的诊断，不与其他显式native模式
组合。在生产首次连接与原goto后，通过公开SDK/CDP依次getDocument、
querySelector、describeNode、DOM.focus，四命令共用一次5秒预算，随后
原单次fill和Submit。没有TASK_READY测试gate、额外点击/按键或输入重放。
原INPUT fixture和三快照不变，另记一次before-dom-focus观察原节点身份、
空值与尚未focus前提；前提不成立时不先blur制造条件。

此假设来自固定Chromium源码：DOM.focus的focus trigger/type与JS
element.focus不同，focus type会传到浏览器观察者。供应商可区分这两条
路径，但这不证明Vivaldi会据此选择输入widget，也不等于真实用户激活。
参考 [DOM agent](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/third_party/blink/renderer/core/inspector/inspector_dom_agent.cc)、
[Element](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/third_party/blink/renderer/core/dom/element.cc)、
[FocusParams](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/third_party/blink/renderer/core/dom/focus_params.h) 和
[WebContents](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/content/browser/web_contents/web_contents_impl.cc)。

诊断核对原始native命令/响应与目标、原document/node连续性和实际输入
事件/POST。CDP nodeId与页面观察者WeakMap编号不混用；DOM.focus可能
产生正常页面focus/scroll。采集完整、实验前提成立、真实任务成功分别
报告，mode的passed恒false。失败或结果未知就停止，不补操作。

首轮 `YMxiBJ` 原goto82ms，四命令20ms完成，原输入节点从body获焦。
native四DOM命令唯一、目标/参数正确且均ACK；原document/node收到可信
focus/selectionchange。但唯一insertText后仍空值，未出现beforeinput/
input/change；唯一可信POST的note和inputEvents均空。398ms连续焦点检查
零事件/豁免，host/browser精确exit0、私有进程和随机注册清理通过。

该轮terminal exit1、collectionComplete=true而experimentObserved和
diagnosticCompleted=false保留。独立审计发现新比较器错误地依赖对象
字段顺序和跨进程Date.now完成时间（本轮相差1ms）；四命令原生序号及
响应语义实际一致。后续判据改用同worker序号和结构语义，本地总期限
另验，跨进程时间只记录观察，不加时间容差。独立审计v2在冻结381源码/
227历史下通过，首个复现判据错误的审计v1也保留。修比较器不修输入，
更不修改该轮原结果；此DOM.focus候选尚不能进入生产fill实现。

判据修正后独立 `ntZmPW` 原goto73ms、四DOM命令22ms完成；原生112–119
序号链、原目标和节点、参数/响应一致。随后唯一insertText及单Submit
三鼠标命令与原始观察吻合，无额外输入。原节点获焦后仍没有输入事件，
唯一POST为空；433ms连续焦点检查零事件/豁免。此轮diagnosticCompleted
true、terminal exit0表示完整采集，task/acceptance仍false，无截图或finalize。
host/browser精确exit0、私有进程/两视图随机注册清理及固定注册不变通过。

最终默认Brave `KKcjBO` 未启用任何诊断模式，原12步、真实POST、实际PNG
和清理通过；四检查点744ms零激活/零focus/零豁免。独立审计核381源码/
228历史/47制品成员一致，两轮生产、SDK、host与ZIP未改。最终脚手架
217/217，新增18项独立复核通过；旧失败与首次判据错误都保留。本片排除
DOM.focus足以修复此输入的假设，未把额外点击加入生产或宣称通用修复。

## 显式 hover 对照

下一对照仅预选一次公开input.hover，再执行原单次fill与Submit。
Chromium固定源码中非wheel mouseMoved也先按坐标找目标widget，再进入
含Focus的鼠标注入路径；按键/insertText则从已聚焦widget查找。它能检验
“移动路径是否已足够”，不能预定Vivaldi私有delegate的行为或将成功
归因于唯一内部机制。公开API没有按widget ID指定焦点的方法；前台激活
不是本实验。参考 [Input handler](https://raw.githubusercontent.com/chromium/chromium/9007248033443cbe529d18cf911d6954f5ce4f49/content/browser/devtools/protocol/input_handler.cc)。

新独占`OBU_TEST_VIVALDI_HOVER_FOCUS=1`复用原INPUT HTML/10种事件/256
记录上限，无TASK_READY、DOM.focus或输入回放。额外before-hover和原
before-fill记录共享同一被动节点身份链，并只读`:hover`状态与矩形；
不新增hover事件监听。悬停状态、位置和实际输入分别观察，不要求悬停
为true来判采集完整。原生trace单独核1移动ACK→1insertTextACK→Submit
三鼠标及各自ACK，所有实际计数保留；更多命令不是单次移动的成功证据。
本地动作期限、原scope与同worker序号分别核，不比较跨进程时钟。

hover可能引发CSS、网页handler、滚动和引擎actionability处理；一次公共
hover不保证只发一条native命令。即使原任务通过，也仅证明显式工作流
在该配置有效，不能把hover静默加入生产fill或声称没有页面副作用。

### 真实结果与候选边界

冻结v25后，`native-installation-vivaldi-Fm2cYE` 原goto96ms、hover188ms、
fill12ms、Submit83ms。同worker完整链为mouseMoved143→144、唯一
insertText167→168和Submit三命令200–202→203–205；目标与参数正确，
均获ACK。原输入框`:hover`由false变true，坐标在前后未变的矩形内，
但activeElement仍为body。随后原fill产生focus/selectionchange，却无
beforeinput/input/change；原节点值和唯一可信POST的note均空。

该轮terminal exit0、diagnosticCompleted=true，task和acceptance仍false；
未达到截图/finalize。552ms连续焦点观察无激活/focus/豁免，host/browser
精确exit0、私有进程和双视图随机注册清理、固定注册不变均通过。独立
`native-installation-vivaldi-Fm2cYE-hover-focus-audit-v1.json`通过，核对
383源码/230旧结果/47制品成员与原INPUT HTML，旧结果未重写。`:hover`
仅是状态观察；没有额外监听鼠标事件，不能报告未知的hover事件数量。

同一冻结版本默认Brave `native-installation-brave-zwqwku` 原12步、正确
唯一POST、实际PNG1877×1926及清理通过。四检查点697ms零前台事件，
独立默认审计通过，截图已经实际查看。最终脚手架231/231、独立定向
63/63通过；生产、SDK、host及原ZIP未变，没有重新运行或虚报完整CI。

当前证据排除“hover足以修复此输入”，也不能把此前click成功单独归因
于mousedown。另查固定Chromium的[公开输入实现](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/content/browser/devtools/protocol/input_handler.cc#1281)：
InsertText的1289–1294行与ImeSetComposition的1326–1331行均经delegate
选择focused widget，随后调用Focus；它们分别提交文本和设置组合文本，
在当前根页面未提供不同widget路由。因此未新增IME实验，也未改变生产
fill。下一片转P04观察元数据，Vivaldi输入缺口保留等待新的有效假设。
