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
| 产品面 | B | 公开动作、三个 SDK 与 CLI/MCP、后台光标/截图、跨 frame 上传及全局暂停已有真实验收；网络/导航等待支持 ready/trigger/collect。新增主动 HTTP(S) 下载、精确 ID 路径和取消，五入口校验实际文件字节；Page GUID 路径和原生 popup 初始激活仍有缺口。 | 按 browser-use-parity 矩阵补页面下载、平台、数据导出、受限模式数据入口及完整任务比较。 |
| 架构文档 | B | 本地 IPC、动作协议、有界递归观察与 capture refs、持久 control 生命周期、全局暂停和文件来源边界已有独立 reference。 | 继续记录完整进程重启及更多受限入口的设计/证据。 |
| 插件 UI | B | MV3 popup、content cursor 和打包校验具备；真实暂停/失败界面与三种网站策略已截图检查，草稿和冲突不被轮询覆盖。 | 更广平台浏览器验证及网站规则可用性持续补齐。 |
| 测试 | B | `make ci` 包含跨语言真实 host 通信；独立 headed Chromium 套件覆盖五个公开入口，适配器严格执行 1 MiB 原生出口上限。独立 native Edge 验证超过 2 MiB 的双客户端请求与 legacy 拒绝后保连接；另验安装、暂停、故障重试和迟到输入。 | 完整 browser/host 重启、更多 OS/浏览器、同组 Codex 对比。 |
| 可观测性 | B | 公开 diagnostics 有界记录真实 console/error/network 摘要、cursor 和丢弃信息；独立 network wait 有 ready 确认、原始 deadline 和控制归属，不依赖历史轮询。 | 补可脱敏 debug trace 与更多真实站点场景。 |
| 安全 | C | 本地 IPC、control epoch、暂停和通知已有回归；新增 popup 独占的 origin 规则、完整 frame 检查与受限模式禁未经验证入口。session ID 不作认证，策略不是网络防火墙。 | 受限模式更广 CDP/数据操作、peer 授权及安装审计；未知持久写和完整浏览器重启仍有明确限制。 |
