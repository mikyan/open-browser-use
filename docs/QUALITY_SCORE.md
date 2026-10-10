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
| 产品面 | B | 公开动作、三个 SDK 与 CLI/MCP、后台光标/截图、跨 frame 上传及全局暂停已有真实验收；PDF/MHTML 五入口与前片 53 项完整浏览器通过。剪贴板固定 Headless 8 项通过；图片下载五入口及 ref/生命周期/导航专项 Headless 9/9，同版本 headed 8/9，媒体八项通过但原有 raw-navigation 失败。最近完整 headed 29/53，首帧定向 0/3仍保留。 | 优先解决后台首帧停滞；继续补 Page GUID 路径/取消、headed OS 剪贴板、其他媒体类型、平台及完整任务比较；原生 popup 初始激活仍有缺口。 |
| 架构文档 | B | 本地 IPC、动作协议、有界递归观察与 capture refs、持久 control 生命周期、全局暂停和文件来源边界已有独立 reference。 | 继续记录完整进程重启及更多受限入口的设计/证据。 |
| 插件 UI | B | MV3 popup、content cursor 和打包校验具备；真实暂停/失败界面与三种网站策略已截图检查，草稿和冲突不被轮询覆盖。 | 更广平台浏览器验证及网站规则可用性持续补齐。 |
| 测试 | B | 完整本地 `scripts/ci.sh` 通过，包含跨语言真实 host 通信、663 项扩展/脚本、JS 93、Python 63、Go 全包及其余 workspace 检查。两种浏览器模式各十七份 PNG、请求记录、原生清理及冻结哈希独立核验。Headed 专项 8/9 和前序失败均保留，不计为全套通过。 | 解决并复验 headed 首帧停滞；继续完整 browser/host 重启、更多 OS/浏览器、同组 Codex 对比。 |
| 可观测性 | B | 公开 diagnostics 有界记录真实 console/error/network 摘要、cursor 和丢弃信息；独立 network wait 有 ready 确认、原始 deadline 和控制归属，不依赖历史轮询。 | 补可脱敏 debug trace 与更多真实站点场景。 |
| 安全 | C | 本地 IPC、control epoch、暂停和通知已有回归；新增 popup 独占的 origin 规则、完整 frame 检查与受限模式禁未经验证入口。session ID 不作认证，策略不是网络防火墙。 | 受限模式更广 CDP/数据操作、peer 授权及安装审计；未知持久写和完整浏览器重启仍有明确限制。 |

最新验收脚手架修正增加 15 项 Node-only 回归，全部通过。固定 Headless
内存环境的四个定向场景通过，包括同一个常驻 observer 下三次真实 worker
重启；有界面三个关键场景继续失败，未冒充全套通过。旧脚本跨 worker
拼接 focus 日志可能漏记或重复，已改为单一观察页、精确事件归因和最终
快照校验；旧数组不能独自作为连续无前台事件的证明。生产插件没有因此
修改，完整 headed/跨平台验证仍待解决首帧问题后进行。

图片下载最终 `run-FDmPto` 固定 Headless 9/9、`run-XLWzut` headed 8/9；
八项媒体均通过，原有 raw-navigation 超时不因此修复。来源只支持精确
`<img>` 的 HTTP(S) currentSrc，
其他媒体类型与资源字节导出仍见 [能力矩阵](product-specs/browser-use-parity.md)。
