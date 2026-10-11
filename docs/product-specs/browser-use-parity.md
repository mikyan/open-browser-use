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

同日又完成[共享研究任务](../references/shared-research-workflow.md)：本项目
五入口×三布局15项全部通过，专项16/16、全套104/104；当前Codex Edge三
布局最终报告3/3，无浏览器方法失败或替代。任务比较当前资料、计算全部
约束、保存准确来源并保留报告/关闭研究页，属于有限合成任务；不是开放
网页研究或全面对齐证明。该端证据导出与服务退出限制另行保留。

## Acceptance matrix

Go chooser调用器补齐失败partial和原阶段，诊断采集明确限于原生trace、
浏览器metadata及focus，不重新取scope/attach或读取任务DOM。脚手架339项
和Go helper包通过；无hook专项`JWc1eT`9/9、完整`npV0kp`105/105，实际
exit0。完整焦点仍只有既有六激活/四focus；旧`X2wiUq`超时没有复现，
根因仍开放。后续仅修报告原结果被注释污染、采集完整性漏守卫及措辞，
最终诊断`PbIrsJ`2/2；诊断`acceptancePassed`始终false，不能代替能力验收。

选择器提交新增单次消费及原控制完成检查，保留change后合法导航。
旧源码新增回归23项失败、修复后通过；最后补稳定消费错误的一项也有
旧失败/新成功对照。当前Node864+59+296通过，专项`frp1Zt`9/9；初版
完整`WUe0YQ`105/105。最终源码`X2wiUq`实际exit1、104/105：Go动态OOPIF
首轮chooser等待超时，root/已有OOPIF均已真实上传及清空，动态页无POST。
原调用器失败时没有阶段文件，不能区分arm/collect或证明click ACK；未
定位根因、不延长等待、不重放。新单次提交case通过不抵消该失败。
最终源码全套焦点校验通过，仍只有原六次fixture激活和四次popup focus，
不是全套零焦点事件。目录枚举完成、系统钟诊断及完整矩阵继续开放。

MCP现固定stdio服务首次选中的实际连接，断线后明确要求重启服务，不会
将旧tab/epoch带到重新发现的实例。Windows真实IPC边界测试及浏览器
专项`run-ykbo3D` 2/2通过；首次匹配歧义、各SDK重连和跨平台范围仍按原
规则保留，详见[MCP连接生命周期](../references/mcp-connection-lifetime.md)。
同版本默认`k5giEj`实际exit1、103/104，唯一失败是JS动态跨源frame下载
等待超时；原104项、制品及焦点规则独立复核通过，不把专项当作全套成功。
完整P02/P13与下载触发的未定位问题仍需继续。

下载有界诊断`avWmSX`采集完整、两原case通过，旧故障未复现且没有生产
修复。随后默认`Ve7nKv`原104项87通过/17失败另有最终focus失败；用户
确认对应时段手动操作窗口，因此保留外部干扰背景，不作为干净焦点回归。
五入口下载与下载生命周期均通过，但完整目标及低频触发根因仍未完成。

最新检查点：新生产首次连接检查在Vivaldi `yeWkzC` 中，无TASK_READY即
完成原goto（82ms），但输入仍空、任务失败；更早 `wv2kHQ` 在扩展安装前
About求值超时。默认Brave `i40fyX` 通过且零焦点事件。同版本主回归
`run-p0iiaM` **104/104**、终端exit0及独立审计通过，原case集和焦点豁免
未变。旧 `run-chNw0r` 41/104及最终focus-ledger失败保留；用户确认在
对应时段操作过测试浏览器，不能把它当作无外部操作的回归对照。
完整CI1079项Node（827+53+199）、JS115、Python82及Go通过。目标仍未完成。
后续DOM.focus诊断 `ntZmPW` 原goto73ms、四命令22ms且原节点获焦，
但原fill无输入事件/POST空，诊断完整而任务失败；原 `YMxiBJ` 失败保留。
最终脚手架217/217；默认Brave `KKcjBO` 完整任务、零焦点与独立审计通过。
本片生产/SDK/host/ZIP未改变，无额外点击的Vivaldi输入缺口仍开放。
随后显式hover诊断 `Fm2cYE` 确认原输入框进入悬停状态，但原fill仍没有
输入事件、POST为空；552ms零前台事件。默认Brave `zwqwku` 完整任务、
实际PNG、697ms零前台事件及独立审计通过。脚手架231/231，独立定向63/63；
两轮冻结383源码/230旧结果/47制品成员均一致，没有生产改动。已排除
hover足以修复该输入的假设；下一片补P04，仍不宣称整体能力对齐。

P04位置快照已完成三种原生DPR的五入口专项：`oVaN3m`、`wTM1CH`、
`x5s4pZ`各10/10及独立审计通过，45张PNG与frame内坐标匹配，观察期间
零焦点事件。完整CI通过，最终测试脚手架238/238。新主回归`7YcNf9`
原104项99通过/5失败，另有最终focus账本失败：动态OOPIF chooser未见
原生打开事件并超时，后段窗口变为minimized且popup无法打开。原因仍待
定位，不能以专项成功代替全套通过；旧DPR emulation失败也保留。
用户随后表示本轮“可能点了点窗口”，故该轮可能存在外部操作，不能
作为无外部操作的焦点回归对照；更早chooser超时仍单独定位。
随后opt-in诊断`Yh4Yz7`原两项通过、terminal0，独立核对69条命令ACK、
6次chooser/POST及零前台事件。此次未复现，旧失败原因未定；没有生产
修补，诊断acceptance保持false，失败后只读DOM分支尚未实机触发。
关闭探针后的默认完整回归`ZzBRWH`实际terminal0、原104/104及独立审计通过，结果
不含诊断对象或hook，旧失败仍保留。P04专项与本轮全套均完成，但更广
品牌兼容、平台及矩阵其余边界仍开放，整体目标保持active。
该轮194500ms连续账本仅原六次auxiliary创建激活及四次设置popup focus，
无新增后台豁免，初末root均normal/focusedtrue；不声称全套零焦点变化。
详细边界见[生产首次连接检查](../references/vivaldi-input-diagnostic.md#生产首次连接检查)。

| ID | 能力 | 必须验证的行为 | 2026-10-11 当前证据与剩余缺口 |
| --- | --- | --- | --- |
| P01 | 正式入口 | CLI、MCP、公开 SDK 可做完整任务，不依赖 Codex 私有 native pipe 或临时内联脚本 | JS/Python/CLI/MCP 已通过正式 browserAction 链路；Go facade 已接通，完整任务范围继续扩展 |
| P02 | 本地通信与安装 | Windows/macOS/Linux host、CLI、各 SDK 可连接；多 profile 选择明确；掉线可恢复 | Windows named pipe、Linux Unix socket 的真实 host/SDK CI 通过；Windows Edge native registration、大消息分片及旧版本拒绝已验。最终 Windows Chrome 原生 launcher `native-lifecycle-dnAdTC` 3/3：真实 host 崩溃恢复、运行/暂停扩展 reload 与 EOF 清理，无 Port adapter。packed 重连 alarm 的 heartbeat 饥饿已修复且有确定性回归；实际 packed 唤醒时序、macOS 通信及其他平台安装待验。Edge 隔离配置的生命周期焦点验收仍失败 |
| P03 | 浏览器兼容 | Chrome、Edge、Brave、Opera、Vivaldi 的安装与发现正确，按品牌确认 profile 布局及独立或共享的 native namespace | Edge Stable 已有 Windows 注册验收，原生生命周期焦点仍失败。Windows Brave/Opera/Vivaldi selector 和默认 profile 发现已验；手动 ZIP 入口已实现，隔离导出/加载/原生启动已验，生产固定名称安装未实测，共享 Google namespace 保留原 origin；复制 UUID 歧义明确拒绝。Opera 无组路径 `7IDBb7` 与 Brave 原分组路径 `vC2mkf` 真实后台多页验收通过，零焦点事件。Vivaldi 旧初始化失败及无点击fill/逐键空值保留；新 `ttYgKb` 在首文档检查及一次明确输入框click后，原fill、提交、截图和关页通过、零前台事件，其后生产首次连接检查在 `yeWkzC` 无TASK_READY完成goto，但输入仍空，见[输入诊断](../references/vivaldi-input-diagnostic.md)。Linux 仅有官方源码确认的 Brave；其他系统和更广生命周期未验，见 [浏览器安装](../references/chromium-browser-installation.md) |
| P04 | 页面观察 | 结构化语义快照含角色、可访问名称、值、状态；页面/文本/DOM/截图信息可验证 | 原生 ARIA 与 scoped 快照已实测；有界 `snapshotAI` 递归 frame 快照和 capture refs 的真实元数据、五种限额、过期与取消通过。新增 opt-in boxes/结构化frame视口数据，明确各frame内CSS坐标；五入口×三布局×三原生DPR共45张PNG独立核验通过，见[坐标契约](../references/snapshot-geometry.md)。跨frame原子性、父变换的全局投影与更广动态观察仍未保证；最新默认全套`ZzBRWH`104/104，旧失败保留 |
| P05 | 定位器 | CSS、role/name、text、label、placeholder、testId、链式筛选/nth；多匹配严格报错；动态元素等待 | 既有原生 locator、strictness、遮挡等待与 capture ref 生命周期已验。新增有界 `has/hasNot/visible/and/or`、同 client/tab/frame 边界和递归 selector 守卫；最终 77/77 中三个布局、重复/隐藏卡片、同源/OOPIF 组合通过五入口。更多动态网站组合仍待扩展 |
| P06 | 输入与动作 | click/dblclick/hover/fill/type/key/scroll/drag/select/check；等待稳定和遮挡，不误点；原生及受控表单 | 中文、React/contenteditable、可信逐键输入、HTML 拖放与捕获指针拖动已验。七个完整表单流程覆盖label、多字段descriptor与混合多选、幂等check/uncheck、真实frame保存及准确提交；select change本身不要求硬件可信。取消释放可能触发click，不能回滚。Vivaldi `QAMMuD` 的insertText及 `HrDsGN` 的78条key均ACK但无输入；`ttYgKb` 明确click后原fill收到可信输入并正确提交。后者仅证明单次显式流程，不是通用fill生产修复；品牌兼容、更多受控表单与Unicode仍待补 |
| P07 | Frames 与 Shadow DOM | 同源/跨源 OOPIF/嵌套 frame/open shadow 内观察、定位和动作；导航后正确重建上下文 | 同源/OOPIF/嵌套/open shadow 已实测；递归 refs 在 iframe 前插、保留文档重排、20 次重复快照和 8 次替换循环后命中正确节点，frame 生命周期使旧 capture 失效；更多复杂组合仍待补 |
| P08 | 导航与页面生命周期 | goto/back/forward/reload、SPA、popup、关闭、wait URL/load；正确监听早到事件 | 原生 URL/load observer 的短注册与动作完成队列分离，冷 wait→click、五入口 ready→trigger→collect、快速/SPA/中间 URL/redirect、独立 DCL/load/networkidle 和当前状态立即完成均已实测。既有 goto/BFCache/刷新及 auxiliary 原窗口接管保留；Opera 新建单页组消失已用明确无组归属修复，并有真实多页导航、handoff/恢复及关闭验收。原生 popup 创建仍抢前台，用户自行移窗后的渲染恢复和 Vivaldi 更广启动时序/输入待补 |
| P09 | 截图与后台渲染 | viewport/full-page/element/crop，尺寸格式正确；闲置后台 tab 重复截图与输入稳定 | viewport/crop/full-page 与离屏根/同源/OOPIF/嵌套截图、导航后新内容已有验收；frame-owner 预滚修复 stable 等待。启动 trace 将首窗口停滞定位到 root Surface 依赖和 Chromium testing 实验组；受控基线禁用 testing config 后，定向 3/3、完整 headed 61/61。这是测试环境修正，原配置失败保留，不能宣称插件已兼容所有实验设置；普通 tab 移组撤权与显式恢复已验。新增 `run-ttHLU9` 2/2：两页原生命令静默310.088秒，首次恢复截图及后续更新通过，182图逐像素/原生clip核验；document visibility仍visible，不称hidden节流。更长闲置与更广压力待补 |
| P10 | 文件与数据 | 上传/chooser、下载等待/路径、文本及富剪贴板、媒体/页面导出；真实文件字节验证 | 上传/chooser、主 frame/OOPIF 文件字节与清空已有验收。HTTP(S) 新 GET 下载的五入口、cookie、精确 ID 路径/取消以及 PDF/MHTML 产物已验；剪贴板固定 Headless 8/8。`run-XnREpF` 70/70 包含有限 image/video/audio HTTP(S)、data/同 frame 同 origin Blob、Canvas PNG 的五入口文件下载；36 实际文件、8 MiB 边界、分区隔离/DRM/污染/超限负例与四种真实 pending read 取消独立核验。HTTP 是新 GET，不复现页面原响应；嵌入字节上限 8 MiB。chooser 准备确认 `run-bE4e26` 9/9、完整 `run-3OY97j` 83/83，30 条上传/清空 POST 与另6条生命周期请求已验。最新页面下载准备确认 `run-lMFHcB` 9/9、`run-k3mDiy` 89/89 覆盖五入口两连接、root/既有及新建OOPIF、原生GUID/范围通知与24份原始响应及实际文件；取消观察后原传输仍能完成。超过嵌入限制的媒体、headed OS 剪贴板、Page GUID→路径/实际取消及更多平台仍待补；Content-return 的具体语义及当前 Codex 基准尚未确定，已有正文、PDF/MHTML 与剪贴板内容返回不算缺失 |
| P11 | 调试与诊断 | console/errors、network、完整受控 CDP、事件流及必要等待；错误可定位 | diagnostics 主页面/OOPIF、分页/丢弃/截断经 native 验证。新 CRPage 时间戳边界在原 root/OOPIF/worker handlers 创建 handles 前过滤历史 console/exception/Log；raw CDP 通知保留，实际重放、新 console/error 与换 owner 通过最终 70/70。历史 `run-WMOIim` 69/70 失败保留。边界依赖稳定系统钟，系统时钟跳变后的隔离仍待补。request/response ready→trigger→collect 五入口及冷 main/OOPIF、headers-before-body、redirect/503、精确匹配与有界终态已验；更广调试/流读取未完成 |
| P12 | 后台并行与可视反馈 | 多任务 tab 隔离；鼠标不动、前台不变；光标、点击和目标实时可见，结束后无迟回复活 | targetId 归属、光标/蓝框/点击圈及后台操作已实测。此前完整 `run-5TPsWz` 104 项连续 observer 中，六次测试窗口创建各有首 tab 激活；四条 focus 仅来自两次明确控制面板打开，均精确归因，原 sentinel 不变，没有额外前台事件。新增研究专项16/16为零激活/零focus，75创建、60关闭、15个非活动报告保留且既有tabs元数据不变。新增后台专项3独立任务、31轮、172POST、490渲染区间/563跨owner重叠，A闲置310秒、C结束时B原scope继续，8创建/8关闭、零激活/零focus。不是全套零事件；原生 popup 创建激活与更长/更广压力仍有缺口 |
| P13 | 取消与恢复 | deadline、取消、旧 turn 失效、detach、worker/host 重启、断线；不得静默重试有副作用操作 | 持久 epoch、结束取消、移组/跨窗口撤权、可信输入释放、网络/导航/下载 handle 失效与 session incarnation 已验。真实 browser restart/reload `browser-restart-w5chI9` 8/8 含未知输入经 startup witness 的保守恢复。最终 Chrome 原生 launcher `native-lifecycle-dnAdTC` 3/3 增加实际 host 退出和两次原生 EOF exit0；挂起请求及时失败，原 deadline+250ms 无迟到动作，暂停经同 popup 显式恢复。主回归 `run-aZyBs1` 77/77。Edge `native-lifecycle-R7MPzo` 清单隔离通过但出现未知窗口 focus，整项失败且 reload 未执行。未决原生调用可能阻止清理，worker 丢失下载 handle 不保证底层传输取消；签名更新/禁启、packed alarm、其他 OS 及更多压力顺序待补 |
| P14 | 用户控制与数据边界 | 全局暂停/恢复、网站访问可配置、任务只能操作其拥有的 tab/target、上传下载边界明确；凭据不入日志 | 全局暂停与真实 popup 已验收；新增 exact-origin all/allow/block，保存暂停且旧 epoch 失效，整页 frame 验证、导航撤权、受限 raw/data 入口拒绝和 worker 持久化通过。策略是 Agent 文档控制而非网络防火墙；受限模式更多数据能力、peer 认证、未知持久写及更广浏览器/扩展恢复顺序仍待完成 |
| P15 | 完整任务与性能 | 同一组动态表单、研究、多 tab、frame、上传下载、诊断任务重复运行；记录成功率/时延/资源和 Codex 基准 | 此前 Windows Chromium 156 主 headed `run-5TPsWz` 104/104，新增五入口×三布局研究15项：当前资料、跨源/动态frame、准确比较和来源、单次报告、实际75创建/60关闭/15保留。专项16/16与全套均独立核验原始请求/收据，扩展新增无组任务页与失败创建撤权，Opera/Brave 原生多页另行验收通过。本轮CI Node1079（827+53+199）、JS115、Python82、Go全包通过；另有opt-in后台长闲置2/2，原有默认104项范围不变。Codex Edge共享研究最终3/3，无浏览器方法失败/替代；无独立OS焦点证据且测试server强制退出，限制另记。此前共享表单3/3、部分方法替代及严格frame指针0/3与87/89窗口失败均保留；不推断速度或完整持平。原生Chrome生命周期3/3不代替Edge失败；开放研究、文件/诊断同组任务及更多重复/平台比较仍待完成 |

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


最新原生 launcher 验收使用实际 Windows connectNative，无 Port adapter，
Chrome `native-lifecycle-dnAdTC` 3/3；Edge `native-lifecycle-R7MPzo` 因未解释
的 focus 保持失败。相同禁同步测试策略、完整管理 API 清单、连续 observer、
两次 EOF 与 deadline 后的原文档/server 证据，以及所有历史失败和清理范围
见 [验收记录](../../scripts/browser-integration/README.md#recorded-acceptance-and-remaining-edge-focus-issue)。
真实 packed 扩展唤醒、签名更新及跨平台能力仍不能由 unpacked 结果推断。


Edge 原生空闲对照 `native-lifecycle-XlNQ9o` 在无 SDK 动作、host 终止或
reload 的 10,002ms 观测中仍出现一次 focus，与开发者模式气泡日志相差1ms；
Chrome `native-lifecycle-K2qRSM` 的10,015ms无事件。两者诊断完整但 passed:false，
不充当生命周期验收。新脚本默认 Chrome 三场景 `native-lifecycle-0B1hfL` 3/3；
Edge 的真实恢复验收仍未通过，气泡因果未直接证实。内容返回的模糊基准项
不会被替换成凭空设计的媒体 API。跨连接 chooser 与页面下载准备握手均已完成本片验收，详见 [文件传输](../references/file-transfers.md)；未做当前 Codex 上传下载对照，完整 P10 继续部分完成。
