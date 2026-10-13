# 技术债追踪

这里记录那些暂时不阻塞当前任务、但已经值得留档的技术债。

| 日期 | 区域 | 债务描述 | 为什么会存在 | 计划中的后续动作 |
| --- | --- | --- | --- | --- |
| 2026-10-11 | Opera / Vivaldi background actions | 实际 native launcher 与 profile 发现可用，但 Opera newTab 报组不存在；Vivaldi fill 返回成功却无输入事件且提交为空，另一次 goto 超时。 | 品牌 UI、原生 tab group 和输入 widget 路由尚未完成兼容诊断，不能用 Chromium 内核相同推断后台操作一致。 | 对实际原生命令与生命周期做有界诊断，区分创建/分组/attach/navigation 和输入焦点；不激活任务页、不静默重试副作用，也不放宽可信输入或焦点断言。见 [品牌验收](../references/chromium-browser-installation.md)。 |
| 2026-10-11 | Page export native cleanup | 外部 debugger detach 后无法对旧 attachment 的 PDF stream 证明关闭；记录保持 cleanup-failed，重新 attach 不会修复旧句柄。MHTML 原生生成整体字符串。 | 不可把断开连接/worker 重启冒充实际 IO.close；Chrome snapshot 无分块输出接口。 | 明确浏览器销毁后资源释放的可验证保证与恢复流程；继续区分返回字节上限和原生内存上限，详见 [page exports](../references/page-exports.md)。 |
| 2026-10-11 | Restricted website mode | 核心文档动作与 popup 设置已真实验收；任意 CDP、网络诊断、剪贴板、文件传输和独立 cursor 入口仍禁用。策略保存失败后 UI 保持 Unavailable，当前没有专用 repair 流程。 | 页面与网络数据来源不是同一权限边界；未知持久写不能假装已回滚。 | 对各数据入口单独设计和验收来源约束；增加可信 UI 的明确重读/修复流程，保留 paused 与 revision 防重放。完整重启与更多平台仍待验收。 |
| 2026-10-11 | Native messaging / data export | host→extension 已按真实 1 MiB 上限协商分片，Edge 原生大请求及旧扩展拒绝后保连接已验；统一 SDK→host 传输前 deadline、整个 host 的内存总额和流式导出仍未覆盖。 | 已实现预算从 host 完整收帧开始；128 MiB 额度仅覆盖重写后排队/发送的大请求，不含入流和 JSON 暂存。 | 扩展统一提交预算和流式字节协议，继续保留真实 native 验收；不能将分片请求上限等同进程内存上限。参见 [native transport](../references/native-message-transport.md)。 |
| 2026-10-11 | File chooser CLI/MCP | backend 与三种 SDK 支持空列表清空，便捷 CLI/MCP 参数仍要求至少一个文件。 | 入口校验未随 backend 清空能力更新。 | 明确清空语法，允许 MCP 显式空列表，并通过实际 input.files 验证；不能以取消原生选择代替清空。 |

SDK connection identity 已按[完成计划](completed/2026-10-12-sdk-connection-identity.md)修复并通过原生IPC与真实浏览器验收；更广平台和恢复顺序仍按总能力矩阵保留。

Invalid keyboard chord 已通过[完整预校验与原附件清理](../references/keyboard-chords.md)
修复；完整`BGZwxy`130/130及九键盘场验收通过。合法press保留上游持键释放
语义，部分执行失败会释放原附件输入，不承诺恢复未知旧状态。
