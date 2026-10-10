# 质量评分

用这份文档按产品区域和架构层次记录当前质量水位，方便持续知道最薄弱的地方在哪。

## 建议的评分标准

- `A`：覆盖完整、行为稳定、文档清楚、运行风险低。
- `B`：整体可接受，但还有明确短板。
- `C`：能用，但需要针对性补强。
- `D`：脆弱、缺少规范，或很多行为尚未定义。

## 当前评分

| 区域 | 评分 | 原因 | 下一步 |
| --- | --- | --- | --- |
| 产品面 | B | 公开动作、三个 SDK 与 CLI/MCP、后台光标/截图、跨 frame 上传及全局暂停已有真实验收；网络/导航等待支持 ready/trigger/collect。新增主动 HTTP(S) 下载、精确 ID 路径和取消，五入口校验实际文件字节；Page GUID 路径和原生 popup 初始激活仍有缺口。 | 按 browser-use-parity 矩阵补页面下载、平台、数据导出、网站策略及完整任务比较。 |
| 架构文档 | B | 本地 IPC、动作协议、有界递归观察与 capture refs、持久 control 生命周期、全局暂停和文件来源边界已有独立 reference。 | 继续记录完整进程重启及网站策略的设计/证据。 |
| 插件 UI | B | MV3 popup、content cursor 和打包校验具备；真实 Running/Paused/Failed 及重试成功界面已截图检查。 | 网站权限状态与操作入口仍待实现。 |
| 测试 | B | `make ci` 包含跨语言真实 host 通信；独立 headed Chromium 套件覆盖五个公开入口，native Edge 另验安装、暂停、故障重试和迟到输入。 | 完整 browser/host 重启、更多 OS/浏览器、同组 Codex 对比。 |
| 可观测性 | B | 公开 diagnostics 有界记录真实 console/error/network 摘要、cursor 和丢弃信息；独立 network wait 有 ready 确认、原始 deadline 和控制归属，不依赖历史轮询。 | 补可脱敏 debug trace 与更多真实站点场景。 |
| 安全 | C | 本地 pipe ACL/Unix 权限、task/tab/target/epoch 归属、全局暂停与通知路由已有回归；session ID 不作认证，未实现网站策略。 | 站点限制模式及其 CDP 边界、peer 授权与安装审计；未知持久写和完整浏览器重启仍有明确限制。 |
