# Vivaldi 首文档与调试器连接

本记录区分后台页面尚未提交、调试器连接与生产任务失败。它不把调试器
目标的空 URL 当作导航失败，也不把诊断完成当作浏览器兼容验收通过。

## 实际观察

- stable `6TvJ0U` 的任务页创建 ACK 为 `url:""`、`pendingUrl:"about:blank"`、
  `status:"loading"`；约 20 ms 后开始 debugger attachment。连接与
  Target.getTargetInfo 成功，随后九条 renderer 初始化命令没有结算。
  Page.navigate/Input 尚未发送，实际 GET/POST 均为零。
- snapshot `l5U4my` 在安装前的管理页首次求值超时；stable `b9p876` 则在
  安装和真实 native 连接后，独立焦点观察页首次求值超时。两者都没有到达
  生产任务。创建 ACK 到首次 Runtime.evaluate 约 17–19 ms，原 target
  后续显示空 URL/title；这不等于已经证明发生导航取消。
- 上述记录没有 attach 前针对实际 tab ID 的连续原生提交状态。较早
  `V8o50Q` 的 fill ACK 后实际空值仍是另一条未解决证据。

## 上游机制与推断边界

stable 的 Browser.getVersion 返回上游 revision
`9007248033443cbe529d18cf911d6954f5ce4f49`。该 revision 的
[RenderFrameDevToolsAgentHost](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/content/browser/devtools/render_frame_devtools_agent_host.cc)
在初始空文档连接时隐藏尚未提交的可见 URL；未结束的导航也可能触发消息
暂停，直到请求集合清空才恢复。GetURL 读取 WebContents 的可见 URL。
因此，attach 后目标 URL 变空与这一机制相容。

[DevToolsSession](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/content/browser/devtools/devtools_session.cc)
先由 browser dispatcher 处理消息；只有进入 fallthrough、且应在导航期
暂停的非 IO 消息才留在队列。部分 browser 命令成功而 renderer 命令仍
pending，与该机制相容，却不能证明实际进入了这个队列。上游源码不是
专有 Vivaldi 二进制的完整实现，也不是本问题已经确定的根因。

[Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
将 `url` 定义为最后已提交文档，将 `pendingUrl` 用于尚未提交的导航。
新实验据此检查原生 tab 状态，不以 target URL 单字段判断页面已就绪。

## 单变量诊断

显式 `OBU_TEST_VIVALDI_READINESS=1` 仅用于真实 Vivaldi 隔离验收，与
`OBU_TEST_NATIVE_DIAGNOSTICS=1` 互斥；未设置时默认路径保持不变。
诊断只调整管理页和独立焦点观察页第一次连接目标 CDP 的时机：

1. 使用已验证的 vendor UI 创建一个非活动 tab，绑定实际 ACK 的 tab、
   window 和唯一新 target，不替换目标。
2. 在目标首次连接前，经同一 vendor UI 读取 `chrome.tabs.get`。要求
   原 tab/window、非活动、目标 URL 已提交、status complete、无待提交
   导航，并核对同一 target。读取错误立即失败；只允许成功但未就绪的
   只读采样继续。
3. 创建、身份验证、目标关联、采样、连接和首次求值共用入口起算的
   25 秒绝对期限；通过检查后不重置预算。样本有界，保留首末与溢出信息。

About 及生产 SDK 的 newTab/goto 不变。没有 API trace prelude、激活、
reload、重新建页或输入重试。超时不把已经发出的创建当作未发生；保留
未知结果，沿用隔离浏览器、连接和随机 native 注册的清理。
失败后另有最多 2.5 秒的单次只读 tab/target 快照，用于保留原目标状态；它
不延长成功期限，不重新连接或求值，也不覆盖原失败。`discarded`、`frozen`
等原生字段仅作为观察数据，不改变就绪条件。

诊断的 acceptance `passed` 恒为 false。管理页与观察页记录完整、到达
任务且严格清理完成，才可标记 `diagnosticCompleted`；原任务结果单独
保存。即使设置阶段改善，也必须继续区分任务页 commit、group 和 attach
的影响，不能直接据此添加生产等待或宣称后台输入已修复。

## 本次结果

冻结 v16 的真实 stable `native-installation-vivaldi-7y16Q1` 已完成诊断。
管理页三次、观察页两次原生采样都从 loading/空 committed URL 变为
complete/精确已提交 URL；始终是原 tab/window 且非活动、未 frozen 或
discarded。随后各有一次目标连接及一次成功求值，从入口到完成分别
229 ms、155 ms，没有重置 25 秒期限。生产新任务页路径未改。

这轮确实进入任务并完成 goto、fill、click 的 ACK，但 fill 前后实际 value
都为空。fill 后 DOM activeElement 为 `#note`，selectionStart/End 都为零，
input/change 事件数组仍为空。页面的 hasFocus=true 和 visibility=visible
不能证明浏览器的原生输入路由正确。服务端唯一 GET 和唯一 POST 独立
保留；POST/页面收据的 note 为空，trusted click=true，没有输入事件。
因此 task 失败，acceptance 仍为 false；diagnosticCompleted=true/exit0
仅表示此次观察和清理完整。没有用重试或替代输入修正原始提交。

两个连续焦点检查点覆盖任务前至关闭前约 408 ms，零激活、零 focus、
零豁免；不声称设置阶段、长期运行或物理鼠标测量。真实 host/browser
保留句柄均 exit0，随机注册双视图和精确私有进程清理通过。独立审计匹配
371 源文件、214 份旧结果、原 host/SDK 与全部 47 个 ZIP 成员。

关闭所有诊断开关的默认 Brave `native-installation-brave-t8wpE8` 同时
完成标准任务与独立审计，四个连续检查点零前台事件，后台截图和原始收据
一致。新增 15 项及原脚手架测试合计 157/157，文档与仓库卫生检查通过。
本片只改诊断和文档，生产 ZIP 保持原 SHA-256
`6ff5c281ad7769750abc66ffde203995a482cd60c5caf1fdfed3bd4e3a7ed5b3`。

单轮设置成功不是因果或稳定性证明，旧的初始化失败仍保留。下一实验
优先定位已经再次出现的输入无效：核实真正发送的原生命令与输入前后状态，
区分文本提交和键盘事件路径；生产修复必须另有证据，不把 DOM 焦点或
命令 ACK 当作成功填值。

当前 CRX 的 text input fill 先在 utility world 选择并聚焦元素，再经
keyboard.insertText 发送原生 Input.insertText；ACK 后没有 DOM 值读回。
同 revision 的
[InputHandler](https://chromium.googlesource.com/chromium/src/+/9007248033443cbe529d18cf911d6954f5ce4f49/content/browser/devtools/protocol/input_handler.cc)
对 root frame 经 delegate 获取 focused widget，再调用 ImeCommitText；
成功回调没有校验页面值。键盘分发也涉及 focused widget，不能据此盲换
键盘事件作为修复。下一诊断只记录原单次输入的真实 tab/session/参数与
结算，以及被动焦点、选区、beforeinput/input 事件，不先改变复现操作。
