# 技术债追踪

这里记录那些暂时不阻塞当前任务、但已经值得留档的技术债。

| 日期 | 区域 | 债务描述 | 为什么会存在 | 计划中的后续动作 |
| --- | --- | --- | --- | --- |
| 2026-10-14 | Visual feedback / P12 | 既有250ms发送超时不取消原sendMessage；结束turn删除queue但未join实际消息。同文档跨turn旧CURSOR若后交付，当前同turn序号门禁不能拒绝。尚无真实Chrome乱序复现。 | 发布前scope/documentId检查不能撤销已交给Chrome的消息；独立channel不提供这里所需的显式跨turn取消契约。 | 先保留独立协议反例，再验证实际消息结算屏障与最终hide顺序，明确未结算cleanup失败；不影响原输入期限或新增epoch状态机。raw跨域叶目标和全屏也分别待验，见[iframe反馈边界](../references/frame-target-feedback.md#remaining-scope)。 |
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
