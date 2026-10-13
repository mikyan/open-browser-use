# Fill 输入投递确认

本切片针对普通 fill 的原生 ACK 假成功，
不修复 Vivaldi 的底层 widget 路由，也不解决原生新页抢焦点。

## 契约

开发分支的正式 `browserAction.fill` 在文本控件和 contenteditable 的
`needsinput` 分支，同时要求一次编辑命令（或一组 Delete 按下/释放）实际完成
及原编辑宿主的可信 `input`。一次多行输入命令可以产生多个 DOM input 事件。
`beforeinput` 仅说明尝试；页面取消该事件时，fill 明确失败。不会隐式点击、
换目标、追加逐键输入或重放已经发出的编辑。

最终值可能被页面格式化，因此成功不以最终值等于请求文本为条件。可信事件
发生后，同文档的处理器移除/替换节点不会撤销已经送达的事实；原生编辑也
可能移除已选中的内部 span，而保留原 editing host。原 context 或
attachment 丢失仍拒绝。业务是否保存成功仍应由实际提交/响应确认。

日期、颜色、范围等 Playwright 原 DOM setter 分支保持原行为，包括 synthetic
input/change；它们不声称发生可信原生输入，也不要求文本输入的独占租约。
对原本已空的文本控件清空，允许经原节点/焦点复核的无操作结果；非空值即使
已相等也不能用相等性代替投递。clear 的 Delete 与 insertText 都携带原 ticket。
已空无操作须没有 beforeinput，或观察到它明确未取消。contenteditable 此项
仅识别 childNodes 为空，不承诺 `<br>` 等视觉空内容的所有浏览器归一化形式。

## 原目标与生命周期

在原 utility world 内准备选择与监听，选择完成后才 arm 回执；准备阶段事件
不能充当 native input 回执。输入前固定 locator 已解析的原节点，不重新定位；
原文档、context、tab、attachment 和 deadline 保持不变。嵌套 contenteditable
的事件目标是原 editing host，事件时 `beforeinput.getTargetRanges()` 还需在
原定位元素内，不要求原子节点在编辑后存活；这不是 CDP 请求认证。

共享 `NativeInputTracker.beginFillAction` 要求输入空闲且结果已确认。预持
modifier/鼠标按钮、未知原生命令或未完成清理不能静默走兼容分支。远端回执
分配前登记 cleanup；实际 Runtime/Input 命令的晚 ACK 仍由原租约持有。
失败触发原 attachment 释放，清理未确认时保持阻断，不能误清理继任附件。

`OBU_FILL_DELIVERY_UNCONFIRMED` 是不可重试的动作失败，明确表示本次送达没有
被确认，而不是证明完全没有发生副作用。直接使用 raw CDP、keyboard.type/
press/insertText 等其他入口没有因此新增相同的 fill 投递保证。

## 验证方法与证据边界

固定 Playwright CRX 0.15.0 的原 `_fill` 方法保留红例：mock 原生命令确认而
没有页面事件时，旧方法返回 `done`。这是精确上游实现的单元证据，不是实机。

真实 fixture 经 public SDK、Go host、正式 backend 和改后的 CRX 执行；
主页面、已有 OOPIF 和动态 OOPIF 分别验证正常输入、同步格式化、取消输入、
受控 ACK/drop。成功必须有原文档、原编辑宿主与事件时目标身份，以及唯一正确
业务 POST；普通文本控件仍保留原节点，nested contenteditable 不要求内部
span 存活，但不允许当前同 ID 节点替身冒充原节点。失败后不得提交，
在原截止时间后继续只读观察，不能把重放隐藏到测试结束之后。

同 worker 的原 RPC 请求/回复、native invoke/ACK 提供顺序证据；跨进程
Date.now 不用作精细因果门禁。受控 drop 不调用实际 Input.insertText，返回
明确标记的 synthetic ACK；其他调用保留原 Promise。这只验证丢投递检测，
不等同于自然 Chromium/Vivaldi 路由故障或真实 Native Messaging 安装验收。

窗口焦点沿用现有原始 ledger，不添加本切片豁免。utility world 可信事件也
不能将同一编辑宿主上的并发用户输入认证为某一 CDP 请求；该归因边界保留。

运行入口：`node scripts/browser-integration/run.mjs`，普通 host/browser
前置条件见[验收说明](../../scripts/browser-integration/README.md)，
专项使用 `OBU_TEST_CASES=^js-fill-delivery$`；强制 raw navigation 对照同时运行。

同一 fixture 另含五个 root 兼容场：textarea、原 nested contenteditable
子范围、Delete 清空、已空清空、date setter。date 要求零原生 Input 与原有
synthetic input/change；不能用这一个 setter 的实机证据扩大到所有类型。
textarea 检查一条完整原生命令与完整有序事件数据，允许 Chromium 的三段
input（首行、换行、末行），不要求一条命令只能产生一个 DOM 事件。

## 验收记录

固定上游旧行为红例确认：只有 ACK、没有 input 仍返回 done；修改后36项
fill 构建补丁测试通过。完整构建240/240、extension1200/1200均 actualexit0。
最终integration Node1360 pass/1既有Windows symlink skip，0fail/cancel，
actualexit0；含28项fixture oracle测试，拒绝缺字段、替身、错误字节及重复提交。

专项 `qyho7y` 2/2（强制 raw-navigation 对照及17内部 fill 场），actualexit0，
运行期间源码/运行时哈希不变。11项成功流程各有一次原 POST，共33416B；
六项失败零 POST，观察至原2000ms期限后250ms，没有后续输入重放。
15条实际原生 Input 命令和三项受控 ACK/drop 的顺序均核实；17个原测试
tab/target 关闭且 probe 移除。焦点账本20157ms零激活/窗口焦点/新增豁免，
原 host EOF exit0。嵌套 CE 原内部 span 被原生编辑移除，原宿主身份保留。

保留四轮 actualexit1：`6ryKB9` 首次 OOPIF attach URL 为空，补当前 native
target ID/URL 与原 session 的关联；`DU61BT` 明确区分失败后预期 detach，
仍保持原 target/document/session；`BJZrns` 补多行事件分段验证；`ozs5WA`
补原宿主身份与内部 span 移除验证。旧结果没有补字段或改判为通过，生产
实现没有为这些 fixture 假设添加点击、重试或放宽输入要求。

最终完整回归 `c4vgmp` 129/129，actualexit0，旧128项名称/顺序不变，当前
生产与fixture源码/运行时哈希在整场保持不变；含专项后增加的缺失boolean
证据拒绝检查。17内部场再次通过，11原POST/33416B和六失败零提交核实。
328568ms焦点账本仅有既有12项popup激活和4项控制页focus许可，无新增豁免。
全套原host-restart对照按记录终止精确旧host，继任正常EOF exit0；所有
连接关闭，不将故意SIGTERM的旧host误报为正常EOF。单独审计曾把专项的
“全部host EOF0”条件误用于全套，已按原restart记录的PID/endpoint精确
匹配修正；没有重跑浏览器或改写验收结果。文档/卫生/Action固定检查通过。

普通安装、更多品牌和P12原生新页焦点问题仍未解决，完整P01–P15保持开放。
已交付preview三个ZIP哈希不变，本切片没有重新打包发布。
