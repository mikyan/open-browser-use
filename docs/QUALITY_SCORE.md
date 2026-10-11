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
| 产品面 | B | 公开动作、三个 SDK 与 CLI/MCP、后台光标/截图、跨 frame 上传及全局暂停已有真实验收。最终受控 Chromium headed `run-XnREpF` 70/70，新增有限音视频/data/Blob/Canvas 下载与读取取消，并修复稳定系统钟下历史 diagnostics 混入新任务。独立重启专项 `browser-restart-ShnPfH` 4/4 仍为此前专项证据。最后 CI 807 项与媒体/诊断/制品 hash 审计通过；原配置首帧失败仍保留。 | 继续 content-return、Page GUID 路径/取消、headed OS 剪贴板、更多重启/reload/launcher 恢复、其他浏览器平台与同组 Codex 完整任务比较；原生 popup 初始激活仍有缺口。 |
| 架构文档 | B | 本地 IPC、动作协议、有界递归观察与 capture refs、持久 control 生命周期、全局暂停和文件来源边界已有独立 reference；新增标签撤权、host 断线恢复门禁、session incarnation 与 startup witness 恢复，以及真实目标销毁的清理边界。 | 继续记录不同恢复顺序和原生 launcher 恢复及更多受限入口的设计/证据。 |
| 插件 UI | B | MV3 popup、content cursor 和打包校验具备；真实暂停/失败界面与三种网站策略已截图检查，草稿和冲突不被轮询覆盖。 | 更广平台浏览器验证及网站规则可用性持续补齐。 |
| 测试 | B | 最终完整 `scripts/ci.sh` 通过：扩展 703、脚本 52、浏览器脚手架 52（共 807），JS 93、Python 63、Go 全包及其余检查。最终 headed `run-XnREpF` 70/70、独立实际媒体与原生诊断事件审计通过；前一轮 `run-WMOIim` 69/70 的 diagnostics 失败保留。源码/ZIP 一致且无测试钩子。先前独立重启 4/4 不冒充本轮新增媒体跨重启验收。 | 继续更多恢复顺序、原生 launcher、其他 OS/浏览器、实验配置兼容性和同组 Codex 比较。 |
| 可观测性 | B | 公开 diagnostics 有界记录真实 console/error/network；新 CRPage 在原生回调创建 handles 前过滤旧时间戳的 console/exception/Log，覆盖 root/OOPIF/worker，原 raw CDP 通知保留。真实重连/转交重放和新消息均已验收；时间边界依赖稳定系统钟。独立 network wait 有 ready 确认与原 deadline。 | 补系统时钟跳变后的隔离、可脱敏 debug trace 与更广真实站点场景。 |
| 安全 | C | 本地 IPC、control epoch、暂停和通知已有回归；popup 独占的 origin 规则、完整 frame 检查与受限模式禁未经验证入口。普通标签移出任务范围及 host 断线同步阻断旧操作，清理后只接受显式新控制范围，不重放请求。持久数字 ID 绑定 session incarnation，原生 Input 发送前记录风险并在持久化等待后再次检查 deadline/epoch/站点/释放状态。未知输入保持阻断；session ID 不作认证，策略不是网络防火墙。 | 受限模式更广 CDP/数据操作、peer 授权及安装审计；未知持久写、更多进程重启恢复及 extension reload/update 顺序仍需专项验收；数字 ID 碰撞已有确定性回归。 |

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

历史 HTTP-image-only 图片下载 `run-FDmPto` 固定 Headless 9/9、`run-XLWzut` headed 8/9；
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
该阶段 host 进程退出是真实的，native Port 使用明确声明的测试桥接；
当时尚未验收完整浏览器重启。其后的独立重启证据如下，原生注册 launcher
恢复和长期压力仍未验收。


本轮 browser lifetime 初版生产实现曾通过 **745** 项完整 CI，并通过主 headed
`run-fLR1kz` **63/63**；独立源码/制品 hash 与连续焦点账本核验通过。六条
激活只来自五个辅助窗口与一个普通测试窗口的首标签，四条焦点事件来自
两次明确打开控制面板，原 sentinel 不变。该套件未运行完整浏览器重启。

隔离进程重启专项的过程失败记录：`browser-restart-ucmbPs` **0/4** 在重启后受保护的
恢复偏好消失；`browser-restart-yH1Qzu` **0/4** 在 restored inactive page 尚未加载时
提前调用 scripting 失败。第三轮 `browser-restart-kTnp4S` **1/4** 的未暂停重启通过；暂停场景的
任务页已加载，但交付页持续 lazy/unloaded，严格等待两页 DOM 的 30 秒
期限届满，后二项受前置失败影响。第四轮 `browser-restart-kmDdeo` **2/4**：未暂停和已暂停的真实进程重启
通过，任务页 DOM/no-replay 与 lazy 交付页 metadata 保存均验证；同浏览器
session 状态丢失后显式 claim 的首次 fill 遇遗留 debugger attachment 冲突，
worker-input 场景也未通过；随后分别修复生产 orphan 和 popup 验收时序。
各轮失败保留，不为验收激活或强制重载页面。未知输入不因 session marker
丢失、target/tab 列表缺席或第一次迟到 startup 事件而清空；无旧 witness 的
风险先记录 witness，后续真实 profile startup 才可能清理。用户 Pause 不自动
解除。完整约束见 [browser lifetime](references/browser-lifetime.md)。整体目标
保持 active，不提 PR、不推送。


第四轮暴露的遗留 native attachment 现已最小修复：仅显式 claim 且没有当前
受控 attachment/Page 时，用只读原生命令证明连接属于本扩展，再按 opaque
原 target ID detach；不触碰其他 debugger，不绕过未知 input 风险。每次
claim 的原 deadline 也约束迟到探测，已提交的 auxiliary 归属不会因重复
claim 超时被移除。新增后 focused **119/119**；最后生产改动完整 CI **760**
项已通过（669 扩展、43 脚本、48 浏览器脚手架），JS **93**、Python **63**
和 Go 全包通过；最终主 `run-hlPRVD` **63/63**、新制品 hash 复核通过。重启专项
`browser-restart-ShnPfH` **4/4** 已通过，覆盖未暂停/已暂停实际进程重启、
同浏览器 session 状态丢失后的显式 claim，以及 worker 丢失 held input 后
保持 Failed，原 tab 真实关闭后 Retry pause/Resume/显式新 turn 恢复。
没有将状态清空冒充 extension reload；跨进程 observer 分段，重启空档
明确保留。三段 activation 都为空，0/2/6 条 focus 仅归因测试主动打开
popup。startup witness 的未知输入跨进程清理、真实 extension reload/update
和原生 launcher 恢复仍需独立验收。

最终重启四场景与 ZIP 审计确认源码一致；ZIP **1,237,392 bytes**、**44 files /
49 entries**，SHA-256 `01f6e2cafdf4efa032fea6b8222a2883adfdcb3e89b647cd9150715bb32718a1`。主套件连续
observer 再次为六条唯一窗口首 tab 激活、四条明确控制面板 focus，无额外
前台事件。本片完成，完整 P13 和 P01–P15 仍有上述缺口，目标 active。

最终有限媒体制品已独立核验：ZIP **1,245,340 bytes**、**45 files / 50 entries**，
SHA-256 `f4d720f839a0198ae3c5ccfd97c70930368af0e78eb0d9a8b400f7e3fb634e66`。
每个成员与最终 unpacked 及 `run-XnREpF` 验收静态产物一致，原生 Port
adapter 改写的 background/manifest 单独按生产 hash 核对；没有测试钩子或
私有路径。Host 沿用已验证二进制，hash 与实际运行一致，不宣称重新构建。

本片有限媒体的新验收扩展了上述仅 HTTP 图片的能力范围，未改写旧运行：
`run-L7XsRk` 16/16、随后 `run-WMOIim` 69/70 暴露 diagnostics 竞态；修复后
最终 `run-XnREpF` 70/70，全仓 807 项通过。独立核对 36 文件、四种 pending
read 取消、真实旧 console 重放与当前新日志/错误；六条创建激活、四条明确
popup focus 均归因且 sentinel 不变。嵌入媒体 8 MiB、Canvas 像素/活跃容量
有界，系统时钟跳变的诊断隔离、content-return 等完整矩阵仍未完成。
