# 技术债追踪

这里记录那些暂时不阻塞当前任务、但已经值得留档的技术债。

| 日期 | 区域 | 债务描述 | 为什么会存在 | 计划中的后续动作 |
| --- | --- | --- | --- | --- |
| 2026-10-11 | Native messaging / data export | 当前 wire 上限双向均为 64 MiB，Chrome 的 host→extension 接收上限为 1 MiB；富剪贴板与大数据请求未有统一分块契约。 | SDK 与本地 IPC 的容量不能代表 Chrome native messaging 的方向性限制。 | 在出口提前限制 host→extension 帧并回传有界错误；导出采用有界字节块，真实验证超限后连接仍可使用。参见 [Chrome 协议](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-protocol)。 |
| 2026-10-11 | File chooser CLI/MCP | backend 与三种 SDK 支持空列表清空，便捷 CLI/MCP 参数仍要求至少一个文件。 | 入口校验未随 backend 清空能力更新。 | 明确清空语法，允许 MCP 显式空列表，并通过实际 input.files 验证；不能以取消原生选择代替清空。 |
