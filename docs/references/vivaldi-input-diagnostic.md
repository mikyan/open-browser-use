# Vivaldi 文本输入诊断

此前两轮真实任务都有 fill ACK 后提交空值；`7y16Q1` 又确认同一文档中
填值后的 DOM activeElement 是原 `#note`，但 value、选区和 input/change
记录均没有变化。原始证据见[首文档诊断](vivaldi-initial-document.md)。
这些观察不能证明原生文本命令确实发出，也不能确定浏览器最终输入目标。

## 直接证据与候选机制

当前 CRX 对普通 text input 先选择并聚焦元素，收到 `needsinput` 后走
keyboard.insertText；生产 input adapter 在发送前保存输入风险并重新检查
权限和截止时间，随后调用原 chrome.debugger.sendCommand。调用 ACK 后
没有实际 DOM 值核验。诊断因此必须同时观察原生命令与页面状态。

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
