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
| 产品面 | B | 公开动作、三个 SDK 与 CLI/MCP、后台光标/截图、跨 frame 上传及全局暂停已有真实验收；最新受控 Chromium testing-config 基线完整 headed 63/63，包含媒体五入口、普通标签撤权和真实 host 进程退出后的显式恢复。剪贴板固定 Headless 8 项通过。原配置 headed 29/53、首帧 0/3 和媒体专项 8/9 失败仍保留；实验组下的首帧兼容性未由插件修复。 | 继续补完整浏览器重启、原生 launcher 恢复、Page GUID 路径/取消、headed OS 剪贴板、其他媒体类型、实验配置和更多平台完整任务比较；原生 popup 初始激活仍有缺口。 |
| 架构文档 | B | 本地 IPC、动作协议、有界递归观察与 capture refs、持久 control 生命周期、全局暂停和文件来源边界已有独立 reference；新增标签撤权、host 断线恢复门禁及真实目标销毁的清理边界。 | 继续记录完整浏览器重启和原生 launcher 恢复及更多受限入口的设计/证据。 |
| 插件 UI | B | MV3 popup、content cursor 和打包校验具备；真实暂停/失败界面与三种网站策略已截图检查，草稿和冲突不被轮询覆盖。 | 更广平台浏览器验证及网站规则可用性持续补齐。 |
| 测试 | B | 最近完整 `scripts/ci.sh` 通过，含扩展 627、脚本 43、浏览器脚手架 36（共 706）、JS 93、Python 63、Go 全包及其余检查；真实受控基线 headed 63/63。启动前原始 trace、实际启动参数和二进制 hash 可核验；单 feature override 会跳过整个 Chromium testing study 的混杂已记录，失败历史不改绿。 | 继续完整浏览器重启、原生 launcher 恢复、更多 OS/浏览器、实验配置兼容性和同组 Codex 比较。 |
| 可观测性 | B | 公开 diagnostics 有界记录真实 console/error/network 摘要、cursor 和丢弃信息；独立 network wait 有 ready 确认、原始 deadline 和控制归属，不依赖历史轮询。 | 补可脱敏 debug trace 与更多真实站点场景。 |
| 安全 | C | 本地 IPC、control epoch、暂停和通知已有回归；popup 独占的 origin 规则、完整 frame 检查与受限模式禁未经验证入口。普通标签移出任务范围及 host 断线同步阻断旧操作，清理后只接受显式新控制范围，不重放请求。session ID 不作认证，策略不是网络防火墙。 | 受限模式更广 CDP/数据操作、peer 授权及安装审计；未知持久写和完整浏览器重启后的数字 ID 复用仍有明确限制。 |

最新验收脚手架修正增加 15 项 Node-only 回归，全部通过。固定 Headless
内存环境的四个定向场景通过，包括同一个常驻 observer 下三次真实 worker
重启；有界面三个关键场景继续失败，未冒充全套通过。旧脚本跨 worker
拼接 focus 日志可能漏记或重复，已改为单一观察页、精确事件归因和最终
快照校验；旧数组不能独自作为连续无前台事件的证明。生产插件没有因此
修改。随后启动 trace 定位到 Chromium testing config 的 toolbar 实验组，
其实际参数包括 100 秒 renderer commit delay。验收脚本现仅补上 Playwright
标准的 `--disable-field-trial-config`，保留 `browser-default` 复现入口；
该受控基线的 `run-NJ72u2` 完整 headed 61/61。生产代码未改，五次辅助窗口
初始激活和两次测试主动打开控制面板的四条焦点事件均精确归因，不宣称
零事件或覆盖全部用户浏览器配置。详见 [启动诊断](references/headed-browser-startup.md)。

图片下载最终 `run-FDmPto` 固定 Headless 9/9、`run-XLWzut` headed 8/9；
八项媒体均通过，原有 raw-navigation 超时不因此修复。来源只支持精确
`<img>` 的 HTTP(S) currentSrc，
其他媒体类型与资源字节导出仍见 [能力矩阵](product-specs/browser-use-parity.md)。

P13 最终 `run-PeM3FT` 完整 headed 63/63，撤销分组、移至其他任务组、
移窗及真实 host 进程退出时，预先挂起的动作均被取消，可信 pointerup 与
Shift keyup 各一次，迟到点击为零；显式重新 claim 或 beginTurn 后可恢复。
连续 observer 的六条激活事件全部来自测试创建窗口的唯一标签页，四条
焦点事件全部来自两次测试主动打开 popup，不宣称整个运行零事件。
首轮 `run-ssmjWr` 的 12/63 和定向 `run-4NEQV8` 的 1/2 失败保留：
真实关页后的迟到 detach 误触发全局暂停，现用原 attachment 的实际销毁
证据处理，不能仅凭错误文本吞掉清理失败。最终源码与实测 hash 一致。
host 进程退出是真实的，native Port 使用明确声明的测试桥接；完整浏览器
重启、原生注册 launcher 恢复和长期压力仍未验收。
