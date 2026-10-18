# Managed 人工接管的网页弹窗

这是源码中的实验功能，尚未进入 `preview-20261018-853ea92` 安装包。
它处理已完成接管、首帧已就绪的原主页面触发的 `alert`、`confirm` 和
`prompt`。查看窗口在画面上方显示网页消息、确定/取消按钮和可编辑的输入值。
网页内容使用纯文字显示；回答不会继续 Agent，也不会重放原点击。

## 使用与限制

- 在原页面完成接管后操作；弹窗出现时暂停接收新的页面输入。已按下按键或
  鼠标按钮的真实释放仍被记录，等待原输入确认和弹窗关闭后按序发送。
- `prompt` 支持空值和 Unicode，输入上限为 8192 UTF-8 字节。取消不发送
  输入文本。网页消息和默认值也有相同字节上限，非法 UTF-16/UTF-8 被拒绝。
- 完成接管、断线或撤权时，取消仍未回答的原弹窗，再等待原输入、渲染和
  attachment 的实际清理。已经发送的回答只等待原回执，不再发送取消替代。
- 仍保留原输入 30 秒、查看端确认 35 秒的期限；界面提示及时处理。
  长时间人工思考的独立有界等待预算尚未实现，不能据此宣称不限时回答。
- 仅原主 frame、已验证文档和 active human generation 可回答。接管前已有、
  首帧准备期、导航期间、子 frame 和 `beforeunload` 不在本次支持范围内。
  无法确认的 emitter 不取得回答权限；原 human attachment 可以取消并结束
  接管，但不会默认接受离开页面。只读 view 没有弹窗响应权限。
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

成功需要独立 `dialogReceipt` 与原 lease/generation/dialogId 完全一致。
输入仍需要自己的 `inputReceipt`。旧弹窗关闭、新弹窗开启可以早于旧 ACK；
每个实例只认领一次，旧回执不能替新弹窗做决定。未知结果撤权清理，已证实
未发送的 stale/invalid 只更新状态，不重放选择、不撤销另一实例的权限。

## 验证记录

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
