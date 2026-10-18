# 技术债追踪

这里记录那些暂时不阻塞当前任务、但已经值得留档的技术债。

| 日期 | 区域 | 债务描述 | 为什么会存在 | 计划中的后续动作 |
| --- | --- | --- | --- | --- |
| 2026-10-18 | Managed human dialogs | active 主页面及稳定同源/嵌套子页prompt已有真实有限验收；继承源/动态iframe、跨域、接管前/首帧/导航及beforeunload仍开放，view无响应能力。 | 原attachment持有default-context真实源与原loader证明；root原生树不含OOPIF，旧SDK子session已经detach，不能迁移为human权限。准备时context变化仅拒绝子页证明。 | 获取当前原远程文档和context证明并处理root路由事件；实测blank/srcdoc及动态子页，再推进初始/导航弹窗。连续弹窗累计上限已有反例，尚无多分钟真实链式场景。见[子页计划](active/2026-10-18-human-frame-dialogs.md)。 |
| 2026-10-18 | Managed viewer cleanup message | 实际humanCleanup和viewerCleanupComplete已确认后，页面仍显示“正在释放人工控制”的旧提示。 | 原结束过程中收到画面撤销事件，会在既有结束动作期间覆盖提示；原业务和清理回执均已完成。 | 用原lease和明确清理回执结束该提示，保留真实错误；先补“正常End→画面撤销→成功回执”反例，不修改原验收结果或输入流程。 |
| 2026-10-15 | Visual feedback / P07/P12/P13 | 同 worker 的原消息清理、精确 receiver 退役及最终 hide 已实现并有受控交付红绿证据；worker 替换期间任意在途传输、旧版 receiver 升级及恢复登记前的移除顺序仍未证明。BFCache 已修本地子 frame，上层原生 tree 不足以证明 OOPIF 缓存恢复。raw 跨域叶目标、全屏和普通安装仍待验。 | 250ms 仅结束显示等待；旧 worker 的实际 Promise 无法由新 worker 直接继承。精确退役可证明纯隐藏义务，却不等于传输结算；原生本地 frame tree 也不包含完整跨进程树。 | 保留原 Promise 容量和显式失败，继续收集跨 worker/OOPIF 原生命周期证据，不用超时、重注入或输入重放替代清理证明。见[可视消息清理](../references/visual-delivery-cleanup.md)。 |
| 2026-10-14 | Original response body / P11 | 已有有界原正文读取；没有流式/SSE、拦截/改写或 Chrome 原生内存上限保证。 | getResponseBody 原子返回完整解码结果，捕获元数据和实际 native buffer 的寿命不同；同步入口不能靠引擎队列外等待获得客户端并行能力。 | 保留明确失败与禁止重取，按实际任务需求再设计流式协议或同 scope 多连接流程；普通安装另验，见[原响应正文](../references/original-response-bodies.md)。 |
| 2026-10-14 | First keyboard press / P05 | 完整 `bDKdec` 首场 `locator.press("End")` 只有可信 keyup，最终 POST 仍缺 keydown；137/138、actual exit 1。新增诊断专项 `UplYfR` 2/2、截图前置 `5eI49Q` 5/5 均 actual exit 0，未复现。 | 旧准备动作在 native probe 安装前，不能确认 down 的发送/ACK/路由。新两轮完整 End 与原生 trace 均无抑制记录，但被动记录也会影响时序，不能据此判定旧问题已修。 | 导航前 setup probe、head/bottom 原顺序及有界原生 input trace 已落地，64/64 定向测试通过。正文功能所需完整 `tRDnRM` 144/144 已启用 trace；九 End 与50原生键命令完整、无抑制，仍未复现。以后复现时按原命令和文档关联，才决定渲染/焦点修复。不重放、不隐式点击、不放宽断言；见[当前诊断计划](active/2026-10-13-initial-keyboard-delivery.md)。 |
| 2026-10-13 | Native beforeunload / P12 | 离页确认的明确拒绝及原生 ACK 成功，但 Chromium 在创建原生界面时激活任务标签；严格后台验收失败。 | 浏览器的 app-modal 创建路径调用 ActivateContents；扩展收到事件后处理不能可靠地抢先阻止该原生选择。 | 保留真实失败和显式诊断，不恢复焦点或增加许可。寻找原生拦截能力前，不能宣称 beforeunload 无打断；普通 alert/confirm/prompt 分别验收。见[原生弹窗后台限制](../references/native-dialogs.md#known-background-gap)。 |
| 2026-10-11 | Opera / Vivaldi background actions | 实际 native launcher 与 profile 发现可用，但 Opera newTab 报组不存在；Vivaldi fill 返回成功却无输入事件且提交为空，另一次 goto 超时。 | 品牌 UI、原生 tab group 和输入 widget 路由尚未完成兼容诊断，不能用 Chromium 内核相同推断后台操作一致。 | 对实际原生命令与生命周期做有界诊断，区分创建/分组/attach/navigation 和输入焦点；不激活任务页、不静默重试副作用，也不放宽可信输入或焦点断言。见 [品牌验收](../references/chromium-browser-installation.md)。 |
| 2026-10-11 | Page export native cleanup | 外部 debugger detach 后无法对旧 attachment 的 PDF stream 证明关闭；记录保持 cleanup-failed，重新 attach 不会修复旧句柄。MHTML 原生生成整体字符串。 | 不可把断开连接/worker 重启冒充实际 IO.close；Chrome snapshot 无分块输出接口。 | 明确浏览器销毁后资源释放的可验证保证与恢复流程；继续区分返回字节上限和原生内存上限，详见 [page exports](../references/page-exports.md)。 |
| 2026-10-14 | Restricted website mode | 网络等待、诊断/原正文、原生弹窗、locator 上传和 chooser 已验；同源非opaque Blob原页面下载已通过五入口专项。HTTP/POST下载、任意 CDP、剪贴板、WebMCP、媒体/MHTML 和独立 cursor 等未证明的数据入口继续禁用。未结算持久写仍不能重试或假称回滚。 | Page/Browser下载事件没有原Network requestId或redirect链；URL/时间/文件名不能补造关联。页面URL origin也不能替代原default Runtime context的实际来源。原在途操作须等实际回执。 | 继续研究HTTP下载原请求关联及当前Codex文件任务对照，保留原文档、策略和Native Port归属。普通安装、完整重启与更多平台仍待验收。见[受限下载](../references/restricted-page-downloads.md)和[网站权限](../references/site-access-policy.md)。 |
| 2026-10-11 | Native messaging / data export | host→extension 已按真实 1 MiB 上限协商分片，Edge 原生大请求及旧扩展拒绝后保连接已验；统一 SDK→host 传输前 deadline、整个 host 的内存总额和流式导出仍未覆盖。 | 已实现预算从 host 完整收帧开始；128 MiB 额度仅覆盖重写后排队/发送的大请求，不含入流和 JSON 暂存。 | 扩展统一提交预算和流式字节协议，继续保留真实 native 验收；不能将分片请求上限等同进程内存上限。参见 [native transport](../references/native-message-transport.md)。 |

SDK connection identity 已按[完成计划](completed/2026-10-12-sdk-connection-identity.md)修复并通过原生IPC与真实浏览器验收；更广平台和恢复顺序仍按总能力矩阵保留。

Invalid keyboard chord 已通过[完整预校验与原附件清理](../references/keyboard-chords.md)
修复；完整`BGZwxy`130/130及九键盘场验收通过。合法press保留上游持键释放
语义，部分执行失败会释放原附件输入，不承诺恢复未知旧状态。

File chooser CLI/MCP 已补CLI/计划显式`--clear`和MCP显式空数组；保留原路径
及参数遗漏错误。真实原页面FileList和POST验收见[文件传输](../references/file-transfers.md#verification-and-remaining-scope)。
