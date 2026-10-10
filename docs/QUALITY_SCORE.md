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
| 产品面 | B | 公开 Playwright 动作与三个 SDK、CLI/MCP、后台光标/截图、跨 frame 上传及 Edge 独立注册已做真实验收；开发版能力矩阵仍有未完成项。 | 按 browser-use-parity 矩阵补平台、数据导出、用户控制及完整任务比较。 |
| 架构文档 | B | 本地 IPC、动作协议、持久 control 生命周期和文件来源边界已有独立 reference。 | 继续记录整合验证与全局暂停、完整进程重启的设计/证据。 |
| 插件 UI | B | MV3 popup、icons、content cursor 和基础打包校验已具备。 | 补 popup 截图 smoke 和权限状态展示验收。 |
| 测试 | B | `make ci` 包含跨语言真实 host 通信；独立 headed Chromium 套件覆盖五个公开入口，native Edge 单独验证实际安装。 | 新动作整合复验、完整 browser/host 重启、更多 OS/浏览器和 popup smoke。 |
| 可观测性 | B | 公开 diagnostics 有界记录真实 console/error/network 摘要、cursor 和丢弃信息；跨层关联日志仍不足。 | 补 network 等待接口及可脱敏 debug trace。 |
| 安全 | C | 本地 pipe ACL/Unix 权限、task/tab/target/epoch 归属与通知路由已有回归；session ID 不作认证，未实现网站策略。 | 全局暂停、站点限制模式及其 CDP 边界、peer 授权与安装审计。 |
