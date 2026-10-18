# Managed 人工接管的网页弹窗

这是实验功能，已进入 [preview-20261018-95e7b29](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-95e7b29) 安装包；旧 `preview-20261018-853ea92` 不包含。
该包处理已完成接管、首帧已就绪的原主页面触发的 `alert`、`confirm` 和
`prompt`。查看窗口在画面上方显示网页消息、确定/取消按钮和可编辑的输入值。
网页内容使用纯文字显示；回答不会继续 Agent，也不会重放原点击。
当前稳定同源子页面和嵌套页面支持已进入 [preview-20261018-6a3bee5](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-6a3bee5)；旧95e7b29包仅支持上述主页面范围。
新包扩展与已测75文件一致，发布EXE单独重建并完成离线制品核对，未为发布重跑网页业务。

## 使用与限制

- 在原页面完成接管后操作；弹窗出现时暂停接收新的页面输入。已按下按键或
  鼠标按钮的真实释放仍被记录，等待原输入确认和弹窗关闭后按序发送。
- `prompt` 支持空值和 Unicode，输入上限为 8192 UTF-8 字节。取消不发送
  输入文本。网页消息和默认值也有相同字节上限，非法 UTF-16/UTF-8 被拒绝。
- 完成接管、断线或撤权时，取消仍未回答的原弹窗，再等待原输入、渲染和
  attachment 的实际清理。已经发送的回答只等待原回执，不再发送取消替代。
- 声明 `inputBudgetVersion: 1` 的接管保留 30 秒普通输入处理时间，并为
  已发送的原输入提供累计最多 300 秒原生弹窗等待；同一次输入中的多个
  弹窗共用该额度。每个已验证弹窗另有 300 秒上限，即使没有未决输入也
  不会无限等待。界面提示五分钟上限；超时撤权并取消尚未回答的原弹窗。
  旧版未声明能力时仍为服务器 30 秒、查看端 35 秒，不作隐式升级。
- 仅原主 frame 或当前源码已验证的同源子 frame、原文档和 active human generation 可回答。
  子 frame 的每一层祖先必须具有原默认执行上下文和相同的非 opaque HTTP(S) 源。
  接管前已有、首帧准备期、导航期间、跨源 frame 和 `beforeunload` 不在本次支持范围内。
  无法确认的 emitter 不取得回答权限；原 human attachment 可以取消并结束
  接管，但不会默认接受离开页面。只读 view 没有弹窗响应权限。
- 静态 HTTP 同源子页和两层嵌套的 prompt 已真实验收。继承源的 blank/srcdoc、
  动态创建子页、任意深度和子页 alert/confirm 尚未由本轮真实流程覆盖。
  准备窗口内执行上下文发生变化时不授予子页弹窗证明；不会凭 URL 补授权。
- 系统文件选择、认证 UI、真实登录、公司 Edge 及其他浏览器版本未由这轮
  验收覆盖。CDP 原输入没有 documentId 条件参数，仍不构成跨文档原子事务。

## 原对象与回执

`managed-human-dialogs.js` 由唯一的原 managed attachment 持有，每个原生
opening 建立一个独立实例。根 target/source、frameId、URL、epoch/document
必须相符，随后固定 lease/generation/dialogId。弹窗消息不是权限凭据。

持续状态 `pendingDialog` 在原生 `javascriptDialogClosed` 后才清除；认领
回答或收到 `Page.handleJavaScriptDialog` ACK 不伪造 Closed。公开查看协议
只接收 typed `humanDialogRespond`，不暴露原生 target、任意 CDP 或输入序号。
响应走独立有界并发通道，因此不等待触发弹窗的 `humanInput` 先返回。

`managed-human-document-contexts.js` 为原 attachment 记录浏览器原生默认上下文。
监听先于 Page/Runtime enable 的实际 ACK，再在稳定事件窗口绑定原 frame、loader、
context uniqueId 和完整祖先链。固定 Chromium 156 中的 Page.Frame.securityOrigin 来自 URL，不能替代真实
context origin；已销毁、替换或清空的上下文不复活，4096 条身份记录达到上限后
拒绝新增证明。导航及 frameAttached 使旧代失效，回答入口和最终发送前均复核。

Closed 必须属于原 Opening 的 frame；缺失或外来身份不能解除弹窗等待。
未确认原关闭又出现 Opening 时，原生无 frame 参数的回答命令已无法可靠归属，
因此阻止所有尚未发送的回答和取消，保留已发 Promise；后续 Closed 不能消除该歧义。
清理直到原 target 实际销毁才可确认。控制器在焦点模拟清理后及 detach 前后再次
核对弹窗责任；detach ACK 终止旧附件的事件接纳，但不代替已发响应结算。

成功需要独立 `dialogReceipt` 与原 lease/generation/dialogId 完全一致。
输入仍需要自己的 `inputReceipt`。旧弹窗关闭、新弹窗开启可以早于旧 ACK；
每个实例只认领一次，旧回执不能替新弹窗做决定。未知结果撤权清理，已证实
未发送的 stale/invalid 只更新状态，不重放选择、不撤销另一实例的权限。

`managed-human-budget.js` 在原扩展 attachment 内用单调时钟记录工作及
弹窗时间。只有已发出的同 epoch 输入能进入弹窗等待；准备中的输入遇到
弹窗后不会等人工回答完再补发。所有最终发送、原 Closed 和成功 ACK 都
重新结算时间，迟到的定时器回调不能延长预算。调用方超时先撤权，原实际
Promise、持键意图与清理责任仍保留至真实结算。

能力声明固定在原 lease 内，未知版本、只读声明和调用方自选超时都被拒绝。
支持此能力的原输入在 Go/查看端有固定 335/340 秒外层兜底，不依赖可合并的
状态通知计时。回答、End、清理及 Stop 保持原来的独立期限；收到新弹窗或
重复状态都不能重置旧请求。五分钟是有限思考时间，不是不限时保证。

## 验证记录

2026-10-18 子页面续轮 `mfd-sH1gAh` 五步 actual exit 0：主页面、同源子页、
两层嵌套叶页的原 prompt 分别通过查看器回答 Unicode。查看器回答请求记录距
原 Opening 观测约176/154/145 ms；这是跨进程观测时间，并非原生命令发送时间。
原 default contexts 数为1/2/3，原 frame/loader/document 和
祖先真实源保持一致；三份 dialogReceipt、九份对应 inputReceipt 和各自唯一
POST 均确认。跨站 OOPIF 具有不同原进程并实际产生 Opening，因缺当前远程
文档证明被取消，唯一 POST 为 null，pointer-up 明确返回 OPERATION_UNCONFIRMED；
它不是浏览器抑制，也不是回答成功。四份原 humanCleanup 和正常 Stop 已确认。

本轮20份原生帧仅保存12张，另有7张查看器截图；19张保存图片均经独立完整解码。
同源与嵌套的待回答窗口已目视核对，结束后的图片明确显示为保留画面，不能据此
声称连续画面或最终回执像素。结束成功后仍残留“正在释放人工控制”的提示，
属于后续查看器文案状态问题，不代表原清理未完成；原回执独立验证。
事件、上下文和回执独审386项通过；31个原进程身份及私有资源清理独立确认。
被动事件投影没有记录全部导航事件及原始enable命令ACK，不将未记录事件推定为未发生。

最终内部构建405份生产输入、75个扩展文件，2576项Node测试无失败或跳过；
Go源码未变，沿用原全包/vet。独审发现终结阶段遗漏晚到歧义的P1，原控制器
反例先失败，修复后独立两例及289项聚焦检查通过。诊断/验收脚本22项通过。
首轮旧版诊断 `mfd-fkihsa` 因测试误收上一租约的清理回执而失败；修正为等待
当前原租约及完整清理后，旧版 `mfd-w8ou97` 五步诊断完成，明确复现子页取消。
原失败、冻结源码和实际制品均保留。完整源码与验收证据见
[子页面计划](../exec-plans/active/2026-10-18-human-frame-dialogs.md)。

长等待续轮 `mdb-r5BfFQ` 五步 actual exit 0：两个原结果页各只点击一次、
提交一次。第一个 prompt 保持原输入未确认，实际在 opening 后 40775 ms
发送 Unicode 回答；原 Closed、独立 dialogReceipt 和三份 inputReceipt
均验证。第二个未回答 prompt 在被动观测 300004 ms 时自然取消，原页面
返回 null；原 pointer-up 返回 OPERATION_UNCONFIRMED，不冒充成功 ACK。
两原 humanCleanup、暂停状态及正式 Stop 均确认，28 个原进程身份消失，
私有注册、管道和端点清空，无强制终止或清理错误。

原生事件/回执独审 821 项通过，生命周期/来源/图片独审 56 项通过。
保存的全部9帧和5张查看窗口截图均解码并逐张检查；上限结束截图是明确
标注的旧画面，不能证明最终取消回执像素，也不证明连续画面或系统焦点。
Go 全包/vet及2516项扩展/构建/UI测试通过，
403 份构建输入及74个扩展文件绑定到冻结制品。旧版自然30秒失败诊断
`mdb-0gtchS` 单独保留，诊断完成不等于功能通过。原六弹窗快速验收没有
在本轮重跑。真实300秒观察预先允许250ms回调顺序误差，不等于缩短产品
期限；精确单调时钟边界、连续弹窗累计上限及迟回调由定向反例检查。
验收后仅补强采样完整读取区间，23项定向测试通过，真实关闭时限未放宽。
338个旧样本没有读取结束时间，不补造数据，也不声称新版采样断言已经
在该次真实运行中执行；原报告、冻结源码和生产制品全部保留。
最终复核又发现连续弹窗累计额度在定时器延迟时可能晚于回答发送才结算，
已在回答入口及最终原生发送检查补齐同原输入的预算核算。三个反例先失败
后通过，相关114项测试通过。该修复仅改控制模块和其测试，没有重跑浏览器，
上面的真实验收仍归属于修复前冻结候选，不能作为这条新边界的实测证明。
最终内部制品重新构建，2519项Node测试全通过且无跳过；Go源码未变，沿用
原全包测试/vet记录。403构建输入仅上述两文件有变化，该开发轮次未重新发布安装包。
随后按用户要求从 `95e7b29` 单独重建并发布上述预览包；本次发布未重跑网页业务。
本轮证据、后续采样改进与限制见
[等待预算计划](../exec-plans/completed/2026-10-18-human-dialog-wait-budget.md)。

旧内部候选 `5d42f7a` 的 `md-Yruwtj` 已真实复现缺少 pending 状态和弹窗 UI。
该次诊断点击 Refresh，造成旧输入框失焦并发送 humanEnd；它早于触发输入的
错误响应，不能把错误归因为 Chrome 原生拒绝或自然超时。其正式 Stop 和
supervisor exit 1，原 Browser/Native exit 0、Job empty、资源清空；失败保留，
不能将进程终止证明写成完整接管清理成功。

实现的共享协议、控制器、并发查看通道和 UI 有定向反例测试。内部构建
`md-build-1xttk03a` 的 Go 全包/vet、扩展/构建/UI 共 2495 项测试通过；随后
只修 UI 捕获阶段的 held-key release，`md-build-0l684nsq` 绑定仅两文件变化、
重跑 64 项 UI 测试并重新嵌入构建。两个原构建和检查记录均保留。
固定 Windows CfT 156.0.8078.12 的正式 `mhd-ozO6fy` 六步 actual exit 0：
两个原页面先由公有 `finalizeTabs` 交付，再在查看窗口接管。五次正常回答
具有 15 份原输入回执及各自独立 dialogReceipt；第六个未回答 prompt 由
完成接管取消，原 Closed 为 false、原文档返回 null。两个原文档各一次 POST，
没有重新打开 URL、重认领页面或重放业务。End 场景的原 pointer-up caller
因明确撤权返回 OPERATION_UNCONFIRMED，如实保留；它不是成功 inputReceipt。

该次两份原 humanCleanup、正式 Stop、supervisor、Browser、Native 和 viewer
均完成确认，原进程退出、Job empty、注册及私有管道/端点清空。869 份验收
源码及 73 扩展文件结束时字节不变。截图中的中文输入与决定按钮经人工查看；
结束接管的截图是明确标注的保留画面，最新 receipt 来自原文档和唯一 POST，
不声称冻结图片同步显示最新网页状态。

首次新运行 `mhd-T6Gu7W` 五个正常回答通过，但第二测试页未交付为结果页，
暂停后失去 task 归属，选择失败，整体 actual exit 1；其失败和正常退出记录
保留。后续仅修测试准备为两个正式 deliverable，生产构建没有变化。

独立原生事件与回执审计的 289 项检查通过，另有生命周期、构建来源和图像
审计的 73 项检查通过；21 张保存的 PNG 均可解码并逐张检查。原产品回执
不等于独立的 CDP 命令抓包。24 份原生帧仅保存 13 张，未保存的帧不作
目视验证声明。
验收后另补强 native root/frame、事件配对、实际发送时间和原清理 lease
断言，16 项 fixture/runner 测试通过，并离线核对原始结果；这些新增断言
没有在此前浏览器运行中执行，不改写其冻结脚本或原始证据。完整记录见
[本轮完成计划](../exec-plans/completed/2026-10-18-managed-human-dialogs.md)。
