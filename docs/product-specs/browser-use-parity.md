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

## Acceptance matrix

| ID | 能力 | 必须验证的行为 | 2026-10-11 当前证据与剩余缺口 |
| --- | --- | --- | --- |
| P01 | 正式入口 | CLI、MCP、公开 SDK 可做完整任务，不依赖 Codex 私有 native pipe 或临时内联脚本 | JS/Python/CLI/MCP 已通过正式 browserAction 链路；Go facade 已接通，完整任务范围继续扩展 |
| P02 | 本地通信与安装 | Windows/macOS/Linux host、CLI、各 SDK 可连接；多 profile 选择明确；掉线可恢复 | Windows named pipe、Linux Unix socket 的真实 host/SDK CI 通过；Windows Edge 已验实际 native registration，macOS 通信及其他平台浏览器安装仍待验收 |
| P03 | 浏览器兼容 | Chrome、Edge、Brave、Opera、Vivaldi 的安装与发现正确，不把其他 browser selector 默默注册到 Chrome | Edge Stable 目录/selector/独立 native registration 已实现并真实 Windows 验证；Brave/Opera/Vivaldi 及其他系统实测待补 |
| P04 | 页面观察 | 结构化语义快照含角色、可访问名称、值、状态；页面/文本/DOM/截图信息可验证 | 原生 ARIA 与 scoped 快照已实测；新增有界 `snapshotAI` 递归 frame 快照和 capture refs，真实元数据、五种限额、过期与取消通过。iframe 备用文本保持合法 YAML；已有 locator boundingBox，快照内 boxes 等更广观察仍待补 |
| P05 | 定位器 | CSS、role/name、text、label、placeholder、testId、链式筛选/nth；多匹配严格报错；动态元素等待 | 真正 Playwright locator 已接入；role/label/CSS/strictness/遮挡等待实测。capture ref 可信点击、同节点改名、删除/替换、过期及原始 selector 绕过拒绝已实测；更多普通组合继续补验收 |
| P06 | 输入与动作 | click/dblclick/hover/fill/type/key/scroll/drag/select/check；等待稳定和遮挡，不误点；原生及受控表单 | 中文、React/contenteditable、可信逐键输入、HTML 拖放与捕获指针拖动已实测；取消释放会触发 pointerup/可能 click，不能回滚。完整表单矩阵待补 |
| P07 | Frames 与 Shadow DOM | 同源/跨源 OOPIF/嵌套 frame/open shadow 内观察、定位和动作；导航后正确重建上下文 | 同源/OOPIF/嵌套/open shadow 已实测；递归 refs 在 iframe 前插、保留文档重排、20 次重复快照和 8 次替换循环后命中正确节点，frame 生命周期使旧 capture 失效；更多复杂组合仍待补 |
| P08 | 导航与页面生命周期 | goto/back/forward/reload、SPA、popup、关闭、wait URL/load；正确监听早到事件 | 原生 URL/load observer 的短注册与动作完成队列分离，冷 wait→click、五入口 ready→trigger→collect、快速/SPA/中间 URL/redirect、独立 DCL/load/networkidle 和当前状态立即完成均已实测。既有 goto/BFCache/刷新及 auxiliary 原窗口接管保留；原生 popup 创建仍抢前台，用户自行移窗后的渲染恢复待补 |
| P09 | 截图与后台渲染 | viewport/full-page/element/crop，尺寸格式正确；闲置后台 tab 重复截图与输入稳定 | viewport/crop/full-page 与离屏根/同源/OOPIF/嵌套截图、导航后新内容已实测；frame-owner 预滚修复 stable 等待。新 ref 截图按真实 Frame 预滚，与普通定位器截图字节一致，尺寸按原生裁剪和实际 DPR 校验。独立 popup 原窗口内首次点击与截图已验；用户自行移组后的渲染恢复和压力范围待补 |
| P10 | 文件与数据 | 上传/chooser、下载等待/路径、文本及富剪贴板、媒体/页面导出；真实文件字节验证 | 正式并发 chooser→click、主 frame/OOPIF 上传字节及空列表清空通过；下载按所属 tab/epoch GUID 归属，路径映射明确不支持。剪贴板/媒体导出与完整下载链路待补 |
| P11 | 调试与诊断 | console/errors、network、完整受控 CDP、事件流及必要等待；错误可定位 | diagnostics 的主页面/OOPIF、分页/丢弃/截断/换 owner 隔离经 native Edge 验证；新增 request/response ready→trigger→collect，五入口及冷 main/OOPIF、headers-before-body、redirect/503、精确匹配、历史拒绝和有界终态通过 Chromium 验收；更广调试与流读取仍待补 |
| P12 | 后台并行与可视反馈 | 多任务 tab 隔离；鼠标不动、前台不变；光标、点击和目标实时可见，结束后无迟回复活 | targetId 归属修复并实测；最新套件保留五次新未聚焦 popup 自身 tab 激活；原 sentinel 不变，页面操作未切窗口焦点。仅测试主动打开控制面板的精确焦点序列单独归因，光标/蓝框/点击圈可见；原生 popup 创建激活与多任务压力仍有缺口 |
| P13 | 取消与恢复 | deadline、取消、旧 turn 失效、detach、worker/host 重启、断线；不得静默重试有副作用操作 | 持久 epoch、结束取消、显式 beginTurn、worker stop/start 和原生暂停已验；网络/导航 handle 在 end/Pause/detach/关闭/转交/worker 重启后失效，恢复不重放。导航 timeout 不打断同页其他点击；短 setup、warm attachment 保留、触发动作权限检查耗时及迟到原生清理由确定性回归覆盖。auxiliary membership 经真实 worker 重启保留；未决原生存储写可能令 end 保持 closing。完整浏览器/host 重启和更广移组回收仍待补 |
| P14 | 用户控制与数据边界 | 全局暂停/恢复、网站访问可配置、任务只能操作其拥有的 tab/target、上传下载边界明确；凭据不入日志 | 工具栏全局暂停、持久阻断、旧 epoch 失效、清理失败重试及真实 popup 已验收；自身扩展页和已知 raw Target 隧道受限。session ID 仍是路由标签而非认证；网站策略 UI、未知持久写与完整浏览器重启边界未完成 |
| P15 | 完整任务与性能 | 同一组动态表单、研究、多 tab、frame、上传下载、诊断任务重复运行；记录成功率/时延/资源和 Codex 基准 | Windows Chromium 156 正式 `run-9ZuGbE` 43/43，新增五入口导航等待、冷并发 wait/click、独立加载状态和原生请求完成证据；保留 popup、网络、snapshot/ref、文件、输入及 worker/Pause。361 项扩展/构建测试、JS 66、Python 39 及 Go 全包通过；原始激活/焦点事件按精确 fixture 与 UI-open 索引保留归因，无未解释切换。Codex IAB 仍仅只读快照基准；原生 popup 创建、完整任务集、其他平台浏览器和同组完整任务比较未完成 |

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
