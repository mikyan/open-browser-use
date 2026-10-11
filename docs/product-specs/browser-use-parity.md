# Browser Use capability parity

## Objective and completion rule

持续开发，直到本项目的 Browser Use 实际能力与 Codex Browser Use 不相上下。
该目标覆盖可调用性、页面操作能力、后台体验、稳定性和完整任务表现。
命令名称、示例代码、私有参考实现或只经过 mock 的测试不能证明能力已经可用。
每一项必须从正式交付入口在真实浏览器完成验收，尚未验证的项保持未完成。

用户约束：沿用本项目及现有 skill，不增加 Pi 专属适配；不创建或重开 PR；
不占用系统鼠标，不切走用户正在使用的标签页。已有光标、点击与目标反馈需保留。

## Baseline sources

截至 2026-10-10，已核对官方文档：

- [Browser extension](https://learn.chatgpt.com/docs/chrome-extension)：真实已登录 profile、tab 上下文、Chrome/Edge/Brave/Opera/Vivaldi、网站访问控制。
- [Browser](https://learn.chatgpt.com/docs/browser)：打开页面、点击、输入、检查渲染状态、截图与结果验证；独立浏览器 profile。
- [Developer settings](https://learn.chatgpt.com/docs/developer-settings)：可启用完整 CDP 做深入调试。
- [What's new](https://learn.chatgpt.com/docs/whats-new)：后台多 tab 工作而不接管用户的浏览器。

公开文档不构成精确 API 或性能规范。以下是由这些能力、当前工具表面及用户目标
导出的工程验收矩阵；需要用同组任务补充实测对比，不能宣称已获得未公开内部实现。
仓库 `docs/wiki/browser-client/` 仅作为历史参考，不把旧命令表等同当前完整产品。

2026-10-11 又用当前 Codex IAB 对隔离合成页面做了只读观察：
`playwright.domSnapshot()` 同时展开同源和跨源 iframe，未输出 AI ref token；
CUA accessibility 入口另有数字索引。它不构成 Codex extension 或完整任务
对比，详细范围见 [observation baseline](../references/codex-observation-baseline.md)。

随后使用当前 Codex Edge 扩展完成相同共享表单的三个布局变体，最终任务
3/3；部分 select/OOPIF 操作需替代调用，额外严格 frame 指针一致性 0/3。
本项目最终 `run-6SwxDM` 77/77，七项完整表单覆盖五入口。该同组任务证据
扩大了 P05/P06/P15 覆盖，不代表整体、跨平台或性能已相当；完整记录仍在
上述 observation baseline。

## Acceptance matrix

| ID | 能力 | 必须验证的行为 | 2026-10-11 当前证据与剩余缺口 |
| --- | --- | --- | --- |
| P01 | 正式入口 | CLI、MCP、公开 SDK 可做完整任务，不依赖 Codex 私有 native pipe 或临时内联脚本 | JS/Python/CLI/MCP 已通过正式 browserAction 链路；Go facade 已接通，完整任务范围继续扩展 |
| P02 | 本地通信与安装 | Windows/macOS/Linux host、CLI、各 SDK 可连接；多 profile 选择明确；掉线可恢复 | Windows named pipe、Linux Unix socket 的真实 host/SDK CI 通过；Windows Edge 实际 native registration 已验。新分片在真实 Edge 上通过双客户端超 2 MiB 内容/哈希/一次执行及旧扩展未协商时 host 拒绝后连接仍活；单帧限制 1 MiB。同一 headed 浏览器内真实终止/重建 host、旧 epoch 拒绝和显式恢复已通过声明的 Port adapter 验收。macOS 通信、原生 launcher 崩溃恢复及其他平台浏览器安装仍待验收 |
| P03 | 浏览器兼容 | Chrome、Edge、Brave、Opera、Vivaldi 的安装与发现正确，不把其他 browser selector 默默注册到 Chrome | Edge Stable 目录/selector/独立 native registration 已实现并真实 Windows 验证；Brave/Opera/Vivaldi 及其他系统实测待补 |
| P04 | 页面观察 | 结构化语义快照含角色、可访问名称、值、状态；页面/文本/DOM/截图信息可验证 | 原生 ARIA 与 scoped 快照已实测；新增有界 `snapshotAI` 递归 frame 快照和 capture refs，真实元数据、五种限额、过期与取消通过。iframe 备用文本保持合法 YAML；已有 locator boundingBox，快照内 boxes 等更广观察仍待补 |
| P05 | 定位器 | CSS、role/name、text、label、placeholder、testId、链式筛选/nth；多匹配严格报错；动态元素等待 | 既有原生 locator、strictness、遮挡等待与 capture ref 生命周期已验。新增有界 `has/hasNot/visible/and/or`、同 client/tab/frame 边界和递归 selector 守卫；最终 77/77 中三个布局、重复/隐藏卡片、同源/OOPIF 组合通过五入口。更多动态网站组合仍待扩展 |
| P06 | 输入与动作 | click/dblclick/hover/fill/type/key/scroll/drag/select/check；等待稳定和遮挡，不误点；原生及受控表单 | 中文、React/contenteditable、可信逐键输入、HTML 拖放与捕获指针拖动已验。新增七个完整表单流程验证字符串 label、多字段 descriptor 与混合多选、幂等 check/uncheck、真实 frame 保存及准确最终提交；select change 本身不要求硬件可信。取消释放可能触发 click，不能回滚；更广受控表单仍待补 |
| P07 | Frames 与 Shadow DOM | 同源/跨源 OOPIF/嵌套 frame/open shadow 内观察、定位和动作；导航后正确重建上下文 | 同源/OOPIF/嵌套/open shadow 已实测；递归 refs 在 iframe 前插、保留文档重排、20 次重复快照和 8 次替换循环后命中正确节点，frame 生命周期使旧 capture 失效；更多复杂组合仍待补 |
| P08 | 导航与页面生命周期 | goto/back/forward/reload、SPA、popup、关闭、wait URL/load；正确监听早到事件 | 原生 URL/load observer 的短注册与动作完成队列分离，冷 wait→click、五入口 ready→trigger→collect、快速/SPA/中间 URL/redirect、独立 DCL/load/networkidle 和当前状态立即完成均已实测。既有 goto/BFCache/刷新及 auxiliary 原窗口接管保留；原生 popup 创建仍抢前台，用户自行移窗后的渲染恢复待补 |
| P09 | 截图与后台渲染 | viewport/full-page/element/crop，尺寸格式正确；闲置后台 tab 重复截图与输入稳定 | viewport/crop/full-page 与离屏根/同源/OOPIF/嵌套截图、导航后新内容已有验收；frame-owner 预滚修复 stable 等待。启动 trace 将首窗口停滞定位到 root Surface 依赖和 Chromium testing 实验组；受控基线禁用 testing config 后，定向 3/3、完整 headed 61/61。这是测试环境修正，原配置失败保留，不能宣称插件已兼容所有实验设置；普通 tab 移组撤权与显式恢复已验，长期闲置与压力范围仍待补 |
| P10 | 文件与数据 | 上传/chooser、下载等待/路径、文本及富剪贴板、媒体/页面导出；真实文件字节验证 | 上传/chooser、主 frame/OOPIF 文件字节与清空已有验收。HTTP(S) 新 GET 下载的五入口、cookie、精确 ID 路径/取消以及 PDF/MHTML 产物已验；剪贴板固定 Headless 8/8。最新 `run-XnREpF` 70/70 包含有限 image/video/audio HTTP(S)、data/同 frame 同 origin Blob、Canvas PNG 的五入口文件下载；36 实际文件、8 MiB 边界、分区隔离/DRM/污染/超限负例与四种真实 pending read 取消独立核验。HTTP 是新 GET，不复现页面原响应；嵌入字节上限 8 MiB。Content-return、任意大小媒体、headed OS 剪贴板、Page GUID→路径/取消及更多平台仍待补 |
| P11 | 调试与诊断 | console/errors、network、完整受控 CDP、事件流及必要等待；错误可定位 | diagnostics 主页面/OOPIF、分页/丢弃/截断经 native 验证。新 CRPage 时间戳边界在原 root/OOPIF/worker handlers 创建 handles 前过滤历史 console/exception/Log；raw CDP 通知保留，实际重放、新 console/error 与换 owner 通过最终 70/70。历史 `run-WMOIim` 69/70 失败保留。边界依赖稳定系统钟，系统时钟跳变后的隔离仍待补。request/response ready→trigger→collect 五入口及冷 main/OOPIF、headers-before-body、redirect/503、精确匹配与有界终态已验；更广调试/流读取未完成 |
| P12 | 后台并行与可视反馈 | 多任务 tab 隔离；鼠标不动、前台不变；光标、点击和目标实时可见，结束后无迟回复活 | targetId 归属、光标/蓝框/点击圈及后台操作已实测。最新完整 `run-6SwxDM` 77 项连续 observer 中，五次 auxiliary 与一次 normal 测试窗口创建各有首 tab 激活；四条 focus 仅来自两次明确控制面板打开，均精确归因，原 sentinel 不变，没有额外前台事件。不是全程零事件；原生 popup 创建激活与多任务压力仍有缺口 |
| P13 | 取消与恢复 | deadline、取消、旧 turn 失效、detach、worker/host 重启、断线；不得静默重试有副作用操作 | 持久 epoch、结束取消、显式 beginTurn、worker stop/start 和原生暂停已验；网络/导航 handle 在 end/Pause/detach/关闭/转交/worker 重启后失效，恢复不重放。主动下载的 end/epoch/detach/转交/Pause 及迟到 ID 取消经真实 HTTP 断流验证。新增普通 tab 移出/转组/跨窗口的同步撤权、可信输入释放及显式重新领取；真实 host 进程终止/重建经声明的 Port adapter 验证旧 epoch 拒绝、无重放和显式恢复。排队截图、迟到 attach/释放及关闭 tab 销亡证据有确定性回归。新增 session incarnation 绑定 task/active/origin/deliverable/auxiliary 归属，换代失效 active 与 idle epoch；原生 Input 持久风险和保守 startup witness 已实现并通过生产类回归。最终新源码主 headed `run-hlPRVD` 63/63；独立重启 `browser-restart-ShnPfH` 4/4：未暂停/已暂停整进程重启、同浏览器 session 丢失后显式 claim、worker 丢失 held input 后阻断并在原 tab 实际关闭后恢复。先前 0/4、0/4、1/4、2/4 失败保留；最后 orphan 修复后完整 CI 760 项、主 63 项及源码/制品 hash 审计通过。未决原生调用可能阻止清理完成；worker 重启会丢失下载 handle，不能保证底层传输已取消。本轮 `browser-restart-w5chI9` 8/8 已增加运行/暂停真实reload、未知输入跨一或两次真实profile-start恢复，六代进程/连续独立observer与明确重启空档已审；主回归 `run-FPduQP` 77/77。原生 launcher/EOF、签名更新/禁启顺序和更多压力场景仍待补 |
| P14 | 用户控制与数据边界 | 全局暂停/恢复、网站访问可配置、任务只能操作其拥有的 tab/target、上传下载边界明确；凭据不入日志 | 全局暂停与真实 popup 已验收；新增 exact-origin all/allow/block，保存暂停且旧 epoch 失效，整页 frame 验证、导航撤权、受限 raw/data 入口拒绝和 worker 持久化通过。策略是 Agent 文档控制而非网络防火墙；受限模式更多数据能力、peer 认证、未知持久写及更广浏览器/扩展恢复顺序仍待完成 |
| P15 | 完整任务与性能 | 同一组动态表单、研究、多 tab、frame、上传下载、诊断任务重复运行；记录成功率/时延/资源和 Codex 基准 | Windows Chromium 156 受控 testing-config 最终 `run-6SwxDM` headed 77/77，保留旧70并新增五入口七项完整表单；专项8/8，CI824（710+53+61）、JS98、Python67、Go全包通过。当前Codex Edge三布局最终收据3/3但部分方法需替代，严格frame指针一致性0/3；不同版本/profile不作速度结论。历史失败、媒体与重启证据保留。研究、多tab、文件/诊断同组任务及更广重复/平台比较仍未完成 |

## Browser lifetime implementation and acceptance boundary

本轮已实现跨 incarnation 撤销所有 browser-bound 数字 ID，按原窗口只复用
已记录的 deliverable group，不认同名或同 URL 归属。持久 input journal 在
native send 前写入，持久化等待后重新检查原 scope、deadline、站点证明和
释放状态；失败保持阻断。丢失 worker 不会把空 tracker 当作已释放。

首次迟到 `runtime.onStartup` 不能证明旧扩展 incarnation 中的输入已经
销毁：无 witness 的风险先标记，只有后续不同 profile-start witness 才能
清理符合条件的旧风险；同 witness 重放和当前 incarnation 不清理。Pause
保持且恢复不重放。这些路径的确定性测试不能替代实际 browser restart。

初版主套件 `run-fLR1kz` 63/63 与当时完整 CI 已通过。独立重启专项 `browser-restart-ucmbPs`
0/4 和 `browser-restart-yH1Qzu` 0/4 分别受重启后恢复偏好消失、inactive restored
页尚未加载影响。第三轮 `browser-restart-kTnp4S` 1/4，未暂停重启通过；
暂停场景因交付页持续 lazy/unloaded 未通过两页 DOM 等待。第四轮
`browser-restart-kmDdeo` 2/4 已验证未暂停/已暂停进程重启、任务页 DOM
与 lazy 交付页 metadata；同浏览器 session 状态丢失后 claim 的首次 fill
被遗留 debugger attachment 拒绝，worker-input 恢复亦未通过。不激活或
强制重载页面规避失败。最终新源码 `browser-restart-ShnPfH` **4/4** 通过，
但 P13 保持部分完成。详见 [browser lifetime](../references/browser-lifetime.md)。

针对第四轮的遗留 attachment，显式 claim 的 own-session 探测与精确
native target reset 已修复，未知 input gate 保持阻断；重复 claim 超时
不撤既有 auxiliary owner，也不允许迟到 detach。当前 focused 119/119，
重启专项与新源码完整 CI **760** 已通过（669+43+48），JS 93、Python 63
和 Go 全包通过；最终主 `run-hlPRVD` **63/63** 与打包/source hash 复核通过。

四项真实证据分别是未暂停/已暂停的浏览器进程重启、同一浏览器内清空
session storage 后真实 worker 替换，以及 held pointer/Shift 期间的真实
worker 替换。最后一项证明确有 held input 留在原文档，恢复保持 Failed；
原 tab 实际关闭后才 Retry pause、Resume 并显式开始新 turn。状态清空
不是 extension reload，风险恢复不是空 tracker 释放。每个浏览器进程
独立 observer，重启空档不算连续覆盖；三段 activation 为空，focus 0/2/6
条都对应测试明确打开 popup。startup witness 对未知输入的跨进程清理、
真实 extension reload/update 和原生 launcher 恢复仍未由这四项覆盖。

上述 browser lifetime 分片的历史 ZIP 1,237,392 bytes、44 files / 49 entries，SHA-256
`01f6e2cafdf4efa032fea6b8222a2883adfdcb3e89b647cd9150715bb32718a1`，与验收源文件匹配。
本片完成；完整 P13 与矩阵仍保留以上未覆盖项，目标 active，无 PR、无推送。

## Finite-media final artifact

最终有限媒体制品已独立核验：ZIP **1,245,340 bytes**、**45 files / 50 entries**，
SHA-256 `f4d720f839a0198ae3c5ccfd97c70930368af0e78eb0d9a8b400f7e3fb634e66`。
每个成员与最终 unpacked 及 `run-XnREpF` 验收静态产物一致，原生 Port
adapter 改写的 background/manifest 单独按生产 hash 核对；没有测试钩子或
私有路径。Host 沿用已验证二进制，hash 与实际运行一致，不宣称重新构建。

## Evidence rules

- 每次验收记录源码 revision、运行环境、入口、合成 fixture、断言与结果。
- 集成测试必须检查实际页面状态、可信输入事件、产出文件及活动 tab，不能只检查 RPC 成功。
- 在各平台分别验证真实通信。Linux CI 通过不能覆盖 Windows 产品故障。
- 失败需要区分产品缺陷、测试环境限制、未实现和未验证；未验证不算完成。
- 以可重复的本地合成页面为主要回归，必要时用授权的真实网站做补充，不读取无关用户数据。
- 全部矩阵有匹配范围的证据并完成最终复核前，长期目标保持 active。

正式浏览器验收入口和证据范围见
[`scripts/browser-integration/README.md`](../../scripts/browser-integration/README.md)。
当前测试只替换 native messaging 的本地传输适配，用真实 Go host 与生产
extension/engine；它不替代实际安装后的 native messaging 注册验收。
独立 `native-message-checks.mjs` 使用真实 Edge native messaging，覆盖本片
大消息与旧版本拒绝场景；同样不能代替所有平台及完整用户工作流验收。

本轮扩展重载分片通过八项独立生命周期验收及完整77项主回归。用户恢复提示
依据实时持久风险而非旧错误，风险退役后不再要求重启；不会自动Resume。
无witness风险经两次真实profile-start恢复，有witness风险经一次恢复，
均未用空tracker或相同数字tab推断释放。独立companion跨reload连续记录，
六代浏览器间五个空档保留；零tab激活及22条主动popup焦点事件明确区分。
安装前提、五次失败尝试及CDP临时安装边界详见runner README和browser lifetime。
整体P13仍部分完成，原生launcher/EOF、签名更新、更多平台及P01–P15缺口继续。
