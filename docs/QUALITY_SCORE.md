# 质量评分

用这份文档按产品区域和架构层次记录当前质量水位，方便持续知道最薄弱的地方在哪。

## 建议的评分标准

- `A`：覆盖完整、行为稳定、文档清楚、运行风险低。
- `B`：整体可接受，但还有明确短板。
- `C`：能用，但需要针对性补强。
- `D`：脆弱、缺少规范，或很多行为尚未定义。

## 当前评分

当前源码支持人工接管真实重复按键，Go test/vet和2,926项Node检查通过。
正式`mhr-rm5fRL`七步覆盖六场连续删除/移动/网页取消/持键End，原handoff唯一
提交和Stop通过；独立事件及生命周期核验通过，70张PNG解码、30原进程退出。
440份输入和77份扩展与实测构建绑定；用户已要求新包，交付另记。范围见
[人工重复按键](references/managed-human-key-repeat.md)，完整能力对齐仍开放。

当前源码修复人工 Enter 的原生字符阶段；新构建通过 Go test/vet 与2,898项
Node检查。正式`mhk-9zc3G0`七步通过，七场编辑/取消/隐式提交及原handoff
分别核原事件、唯一POST和Stop；28项验收脚本检查通过，详见
[人工 Enter](references/managed-human-keyboard.md)。

用户要求的新包已发布为 [preview-20261019-99c1be1](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-99c1be1)，源提交 `99c1be13a71d2b844f2f5c3cfb657540c109f1a1`。
437份构建输入与上述已测快照及提交对象相同，77份重建扩展与实测字节一致。
完整包包含主机、扩展、安装脚本及Skill；离线CLI/MCP、独立制品审计、
四资产回下载及本地副本核对通过。发布EXE从干净提交重建，本次打包没有
重跑Go/Node或网页业务。公司Edge、系统输入法及完整能力对齐仍开放。
完整ZIP为10,580,608字节，SHA256：`4b7dd5835e9118988d8a9f334a2bc39cc50c1add9cad9469a74ee4f57e14c443`。

已发布d07ae52包的实际EXE/77扩展通过`mhi-66idOk`六步浏览器组合输入流程。
九阶段候选/确认/取消、两次原文字回执、唯一356字节POST及正式End/Stop已验。
新增验收脚本21项聚焦检查通过，437份产品输入与此前Go/2888项Node测试相同，
本轮未改产品、未重跑旧测试。Windows实际输入法与全部能力对齐仍开放；
独立记录核验及确切边界见[组合输入](references/managed-human-ime.md)。

本轮人工接管增加本地纯文字粘贴，保留原修饰键释放及逐次回执，结束或换页后
不重放待发送文字。全新437份输入、77份扩展文件通过2888项Node与Go test/vet；
验收脚手架另有16项聚焦检查。`mhp-hAL2oX` 六步真实流程通过：固定内存
剪贴板的可信Ctrl+V、一次47字节文本请求、原多行值、持Shift时End释放、
唯一351字节POST及正常Stop。首轮`mhp-q6wHyJ`的后续滚动命中失败保留，
只调整测试脚本的当前画面命中后新建独立验收；不重放原业务。
新包已发布为 [preview-20261019-119179c](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-119179c)，从干净提交`119179c93730475ee00ea141214ddb0867924365`重建；主程序、77份扩展、Skill和安装脚本配套交付。离线CLI/MCP、独立制品核对、四资产上传回下载及本地副本校验通过。发布EXE单独重建，未重跑网页业务。完整ZIP为10,580,189字节，SHA256：`8c2988013fb06daae169afb2cd14e58589f2f99cd133d944d1c1e2f0c89e68b8`。
普通系统剪贴板、公司Edge及完整能力对齐仍未完成。

用户再次要求的新包已发布为 [preview-20261019-3241ff0](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-3241ff0)，源提交 `3241ff0585ccfe292bd195ac74cfc9360b8dd58f`。
新增原生弹窗来源标签，完整包包含配套主机、扩展、安装脚本与Skill；旧主机
严格解析器不接受新来源字段，因此主机与扩展需一起更新。完整包108文件、
扩展77文件、Skill7文件，补齐x/net和x/text许可证；原其他依赖版本保持。

全新437源输入的2878项Node、Go test/vet及三场固定浏览器流程通过；主/同源/
嵌套/单层OOPIF和两准备期场景的来源、原回答、唯一POST、End/Stop均已核对。
新包从精确干净提交重建，77份扩展与实测字节一致；离线CLI/MCP、独立制品
检查、四资产上传回下载及本地副本核验通过。发布EXE单独重建，打包阶段没有
重跑网页业务；完整能力对齐、公司Edge和既有平台限制继续开放。
完整包10,578,613字节，SHA256：`ab24d35b3560220e2f867a5bf3f7e0f64e43d1be624467965814e2f0eae0222b`。


人工弹窗卡片新增独立来源标签，显示原生默认执行上下文确认的 HTTP(S) 来源
与主/子页面类型。来源来自原发起页面；父页面网址和网页消息不能补造来源。
原弹窗身份固定来源（包括缺失），证明失效后不能降级继续回答；缺失时显示
“来源未提供”。展示元数据不进入回答或回执身份，主机与扩展必须配套更新。

新增严格来源解析及原 claim 记录固定，值类型避免副本共享；旧状态和迟到错误
不能改写来源或撤销后继接管。Go 增加 x/net 0.60.0 的 IDNA 校验及其所需
x/text 0.42.0，原 x/sys 0.48.0 保持。相关许可证纳入新包。

全新437份源输入、77份扩展文件的冻结构建通过2878项Node测试及完整Go
test/vet。原始失败反例保留，独立Graph到Dialogs组合18项与UI状态4项通过。
同一构建的`mrd-tDRuyY`、`mrd-48B22h`和`mod-VSZqzi`
分别完成首帧前出现、导航期出现、主/同源/嵌套/单层OOPIF的原prompt回答，
来源与原默认上下文一致、独立纯文字显示、唯一POST、End清空及正式Stop。
三场实际退出0，原事件与生命周期独审通过；这不证明回答早于首帧，也不
扩大到动态/继承源/复杂跨进程页面、公司Edge或完整Codex能力对齐。

用户再次要求打包；该切片完成后从精确提交构建配套Windows预览，不提PR。


用户要求的新包已发布并核对为 [preview-20261019-bcc8304](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-bcc8304)，源提交 `bcc8304e47af75902d3dc4cd4e6e470f9fc51227`。
包含原上下文准备、并发结果登记和晚到URL提示修复；432份源输入与已测构建
及Git对象一致，77份未加key扩展逐字节相同。发布EXE单独重建，完整包/扩展/Skill
为104/77/7文件，离线CLI/MCP30工具、9,074项独立制品检查、四资产
回下载及108份本地文件副本核对通过。浏览器验收属于上述冻结内部构建，
打包阶段没有重跑网页业务；公司Edge及完整能力对齐继续开放。
完整包10,477,560字节，SHA256：`5cec4c33da5bd53cfa2958e78df708e7bd126fcb3934c51264c6fc65fcdee50a`。

2026-10-19 新源码修复晚到URL提示误取消有效人工弹窗的问题。原文档身份复核
只阻挡新的人工发送，End可先取消；每个实际浏览器读取都保留到结算，退役读取
不能撤销后继状态。两个原始清理反例先红后绿，九项后台与195项控制器定向检查
通过；全新432份输入/77份扩展构建的2828项Node与Go test/vet全部通过。
新正式`mrd-nHnhSe`、`mrd-LLcuP1`和`mod-97DqRB`三场实际退出0，首帧前出现、
导航时出现及四布局prompt的原回答、唯一POST、End/Stop通过。用户再次要求
新包。三场原事件与生命周期独审均通过，原进程和资源清理确认；发布制品
核对后交付，普通公司Edge及完整对齐仍开放。

2026-10-19 ff1d9d3交付后的开发版修复原默认context等待和同结果记录的并发
journal推进。全新构建Go test/vet与2791项Node全部通过；412份源输入、77份
扩展与EXE绑定独审通过。首帧前弹窗`mrd-R2RlH5`、导航弹窗`mrd-1yX7Xa`
均完成原回答、唯一POST、End及正式Stop，四布局`mod-44Rx1T`回归也通过。
`mrd-9Xezna`原脱敏投影断言失败保留，修正后36项runner/fixture测试通过。
新修复尚未进入已发布包；URL提示竞态、公司Edge及完整对齐仍开放。具体范围见
[人工网页弹窗](references/managed-human-dialogs.md)。

2026-10-19 用户再次请求新包。本轮仅修正准备期 runner 的原状态保存和退役
证明，不修改生产功能；允许同一原弹窗在首帧到达后回答，但不放宽 Opening
必须早于首帧的要求。两个旧测试假设有先失败反例，原两场真实失败保留。
独立 controller 时序诊断为两个对照通过、两个目标行为失败，尚未修复或唯一
归因原导航失败。新包沿用 ecbda21 已验证产品范围，完整对齐仍未完成。
已发布 [preview-20261019-ff1d9d3](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-ff1d9d3)：
104/77/7文件，411份原构建输入及77份扩展字节核对通过；离线CLI/MCP30工具、
8,974项独立制品检查、四资产回下载和108份本地文件副本核对通过。EXE从干净
提交重建，本次没有新增网页业务验收；31项 runner/fixture 定向检查通过。

2026-10-19 新一轮源码候选已通过 2,758 项 Node 检查；完整 Go test/vet
通过，后续仅修改旧 JavaScript 测试后重新构建。411 份冻结生产输入、77 份
扩展文件对应 `mrd-build-fw1j0vrq`。双阶段接管允许准备时结束，普通输入仍须
等待当前帧；同网址导航与异步页面身份读取的竞态已补回归。
当前构建的 `mod-O0QjZc` 五步通过，四布局 prompt 和正式 Stop 均成功。
首帧前场景确有 preparing 弹窗状态，但未在该状态完成回答验收；导航场景
未取得预期弹窗界面。两失败保留，均不列为新增支持。新包已发布为
[preview-20261019-ecbda21](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-ecbda21)。
104/77/7文件、离线CLI/MCP30工具、8,926项独立制品检查、四资产回下载和108个
本地副本校验通过；四布局事件422项和生命周期45项独审通过。
普通公司 Edge 和完整对齐仍未完成。

用户再次要求新包，已从干净提交 `5e830dc8d8c5da466cb6c48c15358008cfe74568` 发布 [preview-20261019-5e830dc](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-5e830dc)。
产品功能与上一包e3fee2a相同；其后提交只有文档及诊断，本轮首帧/导航弹窗开发仍未验收，全部未提交改动留在工作区、未入包。
407份生产输入匹配已测快照和Git对象，76份扩展文件匹配已测制品；完整包/扩展/Skill为103/76/7文件。
发布EXE单独重建，离线CLI/MCP30工具、8434项独立包检查、四资产回下载和107本地文件副本核对通过。
未为重打包重跑网页业务；普通公司Edge和完整能力对齐仍开放。

首帧/导航弹窗新增独立原生诊断，尚未增加生产支持。导航场景中，stop/start画面
传输在弹窗期间确认，但页面树、布局及Runtime/Performance查询只在Closed后确认；
该场原pointer-up在Opening前已确认，不证明输入互等。附着前场景没有取得原Opening，
未发送取消。两场正式Stop及14/15个原进程和私有资源清理通过，均明确标记非功能验收。
后续证明不能依赖弹窗期间的新renderer查询；详见[原生准备期诊断](references/managed-modal-readiness-diagnostic.md)。

用户要求的新包已从干净提交 `e3fee2a35cb4b4d0e52b3c84e95314c867c7b33b` 发布为 [preview-20261018-e3fee2a](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-e3fee2a)。
包含跨站 OOPIF 人工prompt及结束接管提示修复，完整包/扩展/Skill为103/76/7文件。
407份生产输入匹配冻结实测快照及Git对象，76个未加key的扩展文件与实测制品字节相同。
发布EXE单独重建，离线CLI/MCP30工具、独立包审计、四资产上传回下载及本地副本校验通过。
本次打包未重跑网页业务。初始/导航、复杂iframe、来源展示、公司Edge及完整能力对齐仍开放。

2026-10-18 当前源码通过稳定跨站 OOPIF 人工 prompt 与 End 提示修复验收。
`mod-BENPnK` 五步实际 exit 0，root/same/nested/oopif 四个原页面均回答成功，
每页一次点击和唯一 POST，四次原清理确认后界面没有残留释放提示；正式 Stop 通过。
完整内部构建407份生产输入、76个扩展文件，2656项 Node 测试及本轮 Go 主模块
全包/vet 全部通过。独立输入身份反例先红后绿，空弹窗快照仍有原上下文保护。
事件独审417项、生命周期独审40项通过；20张保存图片解码及29个原进程退出已核实。
跨站来源未在弹窗卡片单独显示；初始/导航、动态或
复杂 iframe、子页 alert/confirm、公司 Edge 及完整能力对齐仍未全部验收。
该源码随后按用户要求进入上述e3fee2a预览包，旧6a3bee5不包含这些续轮改动。

上一轮用户要求的新包已从干净提交 `6a3bee5b1c05c154bce945fa35abce2fbe3422c2` 发布为 [preview-20261018-6a3bee5](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-6a3bee5)。
本包新增已验收的稳定同源及两层嵌套页面人工prompt；完整包/扩展/Skill为102/75/7文件。
405份生产输入逐项匹配已测快照及提交，重建扩展75文件与已测制品字节相同；
发布EXE单独重建，离线CLI/MCP30工具、独立制品审计及四资产上传回下载校验通过。
发布时未重跑网页业务，原验收属于冻结内部构建。OOPIF、继承/动态子页、首帧导航、
公司Edge及完整能力对齐仍开放；成功End后的陈旧释放提示已在包内披露。

2026-10-18 源码新增稳定同源子页面的人工弹窗：`mfd-sH1gAh` 五步实际通过，
主/同源/嵌套 prompt 经查看器回答，四个原页面各一次POST，正常Stop及原清理
确认。OOPIF确有原生弹窗，但缺当前远程证明而取消，不算成功或浏览器抑制。
最终2576项Node测试、独立289项聚焦及两个终结歧义反例通过。旧版诊断与首轮
测试等待错误均保留；该开发成果随后进入上述6a3bee5包，继承/动态子页、跨域和首帧导航继续开放。
结束后查看器残留“正在释放”文字已记录，实际原清理回执独立验证。

用户再次要求打包，已从干净提交 `95e7b29e3c079506445c52d3db192561adca6ced` 发布 [preview-20261018-95e7b29](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-95e7b29)。
本包新增人工接管主页面网页弹窗、累计五分钟等待预算及更新后的 Agent Skill。
完整包/扩展/Skill 分别为101/74/7文件；离线CLI/MCP30工具、独立制品检查、
四资产上传回下载和本地副本校验通过。403份已测生产输入匹配提交；七份源码
仅恢复已测换行格式后，重建扩展74文件与最终已测制品字节一致。
发布EXE单独重建，本次未重跑网页业务；子frame弹窗WIP未入包，完整对齐仍未结束。

以下保留各原开发轮次的验证与发布状态。

2026-10-18 人工弹窗等待预算已补齐当前主页面范围：普通输入30秒、同原输入
累计最多300秒原生弹窗等待，每个原弹窗另有上限；旧能力不隐式延长。
正式 `mdb-r5BfFQ` 五步实际通过，40775ms后Unicode回答、300004ms自然取消、
两原唯一POST和正常Stop/清理已验；旧版自然30秒失败诊断保留。Go全包/vet、
2516项Node测试和821项事件独审通过。接管前/导航/子frame、普通公司Edge及
完整P01–P15仍开放；本轮源码未发布，见[等待预算](references/managed-human-dialogs.md)。
验收后另补连续弹窗累计额度的回答前检查，三个迟回调反例先失败后通过，
相关114项测试通过；仅控制模块与测试改变，真实运行未重跑，不将旧运行
作为该最终修正的实测证明。最终内部重建及2519项Node测试通过；Go源码
未变，沿用原全包/vet检查记录。

2026-10-18 源码新增人工接管的主页面 alert/confirm/prompt：独立 typed
回答、原 native ACK/Closed 分离、撤权取消与持键释放。正式 `mhd-ozO6fy`
六步/六弹窗 actual exit 0，两个原结果页面各一次 POST，End 取消与正式
Stop/原进程退出通过；首次第二页未交付的测试失败保留。Go 全包/vet及
2495 项扩展/构建/UI 测试通过，后续仅 UI keyup 捕获修正重新通过64项并
重建。该轮长时间人工等待尚未实现，已由上方续轮补齐有限预算；
接管前/导航/子frame弹窗与beforeunload仍开放，
未打包，不等同完整能力持平。见[人工网页弹窗](references/managed-human-dialogs.md)。

2026-10-18 的五入口组合测试发现并修复 Go SDK 原子页面 scope 的 epoch 类型丢失：
下载、chooser、navigation、network typed API 现复用原 scope 的合法整数表示，
新 turn 仍拒绝旧句柄。定向反例先失败后通过，Go SDK/全包/vet 和五入口 mock
18 项通过；Skill 增加专用会话连接与恢复说明。正式五入口 `mwf-6nmDto` 九步
actual exit 0，20 原请求/5 POST、五原子页/原件/结果及正常 Stop 通过，独审
1,978 项。62 张保存图片完整解码，30 原进程身份退出；318 次鼠标位置采样一致、
0 前台事件，仅为本次观测而非连续或全平台保证。内部候选制品独审 9,301 项，
未自动发布；最近打包请求已由 853ea92 履行。见[五入口验收](references/managed-entrypoint-workflow.md)。

用户再次明确要求打包，已从干净提交 `853ea9211b15ccdebe84dd3fe0df955853b80a0b` 发布 [preview-20261018-853ea92](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-853ea92)，首次将已验证的 worker 替换恢复放入 Windows 包。
离线 CLI/MCP 30 工具、独立制品 8,437 项检查、4 个资产回下载及 103 个本地文件校验通过。
完整包/扩展/Skill 分别为 99/72/6 文件。本轮未重跑网页业务；发布 EXE 单独重建，原始功能验收和失败证据保留。
下一轮 workflow/OS 观测脚本及 Skill 草稿未纳入本包；完整能力对齐仍未结束。

专用会话的真正 worker 替换恢复已进入上述新包。原功能验收限定固定 Windows
CfT 156.0.8078.12 的 `mwr-r-esLC1h` 与独立 held-input `mwr-h-Fv7gx8` 各六步
实际 exit 0：原结果唯一 POST 保留、新 viewer 仍暂停、旧权限拒绝；未知持键
不恢复且正式 Stop 正常结束。Go 全包/vet/build 和扩展 2,075 项通过。
两个场景停止后分别独审 12/8 组通过、14/4 PNG 完整解码，32/31 个原进程
身份现时退出且私有资源清空。此前
路径、自动启动测试假设、Stop 临时错误及晚到帧清理失败均保留并修复对应问题；
浏览器重启、Stop 后保留窗口、公司 Edge 和完整能力持平仍开放，见
[worker 恢复](references/managed-worker-recovery.md)。

用户要求的新包 [preview-20261017-6588984](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-6588984) 已重新构建发布，运行功能与 a4e6b0c 相同；
558 项既有验收源码输入与新提交 Git blob 完全一致，提交差异仅文档。新包离线
CLI/MCP 30 工具、独立制品 5,507 项检查、4 个资产回下载和本地副本校验通过。
该包发布时，扩展后台重启恢复仍为未集成、未验收的工作区开发内容，不进入新包；该轮未重跑
网页业务，不能把重新打包计为新增能力或完整对齐。

当前 a4e6b0c 预览包含同 worker 的显式 Native 连接恢复，限定真实流程已验。
首轮 `managed-native-recovery-LPY0ZE` 暴露推荐 CfT 155 缺少结果页查看/人工
接管所需的原生捕获时间字段；官方固定标签及零业务原生诊断均确认该差异。
推荐版本改为 CfT 156.0.8078.12，缺少能力时返回明确提示，捕获屏障不放宽。
正式安装、离线 status/reuse 和旧 155 缓存共存已通过：独审确认原 309 个文件
不变、新 305 个原文件逐项匹配官方 ZIP。Go 全包/vet/build、runtime/CLI
专项及扩展改动模块 70 项通过。最终 `A6UPE3` 六步实际 exit 0：15 项人工输入、
17 原帧、唯一 POST、同 Browser/worker/document/receipt 的显式恢复、新 viewer
保持暂停、旧票据拒绝及两代 Native/原进程清理通过，运行后缓存离线复用通过。
停止后独审 9 组通过，20 PNG 完整解码、30 原进程身份退出和原资源清理均确认。
三轮失败原样保留，后两轮为测试 public 字段和关闭事件观察的错误假设。
这些改动已进入用户要求的新包 [preview-20261017-a4e6b0c](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-a4e6b0c)。
离线 CLI/MCP 30 工具、独立制品 5,510 项检查、4 个发布资产回下载哈希及本地副本核对通过。
完整包/扩展/Skill 分别为 98/71/6 文件，499 项源码输入逐项匹配。
发布 EXE 从干净提交另行重建，本轮未重跑网页业务；不计作完整能力持平。

Windows 新增显式推荐浏览器安装和离线默认选择：runtime 专项 75 条通过记录，
CLI 8 组定向及 Go 全包/vet/build 通过。生产 EXE 安装/离线状态/复用实际通过，
305 文件与官方 ZIP 的独立清单一致。最终默认选择 `managed-viewer-1wBVEd` 四步
实际 exit 0，40 原帧、唯一 POST、Pause/Resume/Stop 和原进程清理通过；运行后
离线状态与复用通过，停止后独审 10 项、47 PNG 完整解码通过。
首轮 `7dxhON` 运行后新增字典触发缓存拒绝；修为仅接纳有界 bdic 运行数据，
原 305 文件仍严格校验。首轮失败审计和生产 status 拒绝保留。
Windows 原目录身份的延迟读取缺陷已由反例修复；先前失败记录保留。新包按用户
请求发布为 [preview-20261017-81cfdae](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-81cfdae)：
干净重建、离线 CLI/MCP 30 工具、独立制品 5,488 项检查和四资产回下载哈希通过。
完整包/扩展/Skill 为 98/71/6 文件；发布 EXE 单独重建，未重跑网页业务。
可见 setup、本轮普通公司 Edge 与完整能力对齐未验。

正式 managed 原下载 `managed-download-LWwtqG` 五步实际 exit 0：自动 Native
binding、8 项原流程、7 文件/17,524 B、真实取消与仅取消等待、16 次越权拒绝，
17 条完整原请求和正常 Stop/原进程/Job/注册清理均通过。确定性反例促成 Go
attach 回执的 session 发布顺序修复，全包/vet/build 通过；该修正尚未进入
d0605b1 已发布包。此前三轮失败和验收脚本修正均保留；这不是普通公司 Edge、
多平台或完整下载恢复验收。见[原下载](references/original-page-download-delivery.md)。

当前源码补齐正式 finalize 后的原结果页查看与人工接续。固定 Windows Chromium
`managed-result-VGrDlV` 六步实际 exit 0：50 项输入回执、原导航和唯一 POST，
两次 Begin/End 保留同一原结果且不 Resume；普通 viewer `o6PuJl` 四步回归通过。
扩展 2,053 项、UI 54 项、Go 全包/vet/build 通过。首次新标签预期失败保留，
只修正测试文字。用户要求的新包
[preview-20261017-d0605b1](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-d0605b1)
已发布：干净重建、离线 CLI/MCP 30 工具、独立制品 5,442 项检查和四资产回下载
哈希核对通过，完整包/扩展/Skill 为 98/71/6 文件。结果流程独审 868 项、44 PNG
完整解码通过；普通 viewer 独审 8 项、45 PNG 通过。发布 EXE 单独重建，未重跑
网页业务；worker 重启恢复、Stop 后保留窗口和普通公司 Edge 验收仍开放。

此前源码新增单租约连续人工接管，当时尚未进入 93f54a1 包。固定 Windows Chromium
的 `managed-human-navigation-fRIjwN` 六步实际 exit 0：47 项输入、302/子 frame/
SPA、正确当前标题地址、唯一 POST 及正常清理；独审完整解码 59 张 PNG。
扩展 1,995 项、UI 47 项、Go 全包/vet/build 通过。首轮标题地址滞留和跨层
竞态均修复并保留原证据；附加同文档回归的 PID 复用观察器失败也已保留。
修正 helper 后 `managed-human-w1KteZ` 六步实际 exit 0，30 输入、原按住
输入的断线释放、同文档唯一 POST 及正常退出通过，生产运行源码未再改变。
停止后独审通过，37 张 PNG 完整解码，运行扩展、EXE、SDK 与导航验收一致。
范围和待验事项见[隔离会话计划](exec-plans/active/2026-10-16-managed-browser-session.md)。

上一交付为 [preview-20261017-93f54a1](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-93f54a1)，
已包含限定的同文档人工接管。运行源码与已验证的 9ac3a04 一致；干净重建后
离线 CLI/MCP 30 工具、独立制品检查 5,388 项及四资产回下载哈希核对通过。
完整包/扩展/Skill 分别为 97/70/6 文件。此轮打包未重跑网页业务；以下原始
验收和失败记录仍为历史证据，跨文档、真实登录及公司 Edge 等要求不变。

实验性同文档人工接管 `managed-human-6U55vc` 六步实际 exit 0：30 项
人工输入、原按键/鼠标断线释放、同文档显式接回、唯一 299 B POST 和原
清理通过；普通 viewer 回归 `q5L0so` 四步实际 exit 0。扩展 1,966 项、
UI 37 项、Go 全包/vet 与实际 bridge 输出的跨层清理测试通过。功能已进入
上述新包，完整输入法/登录/跨文档/跨平台仍待验收；先前六次失败原样保留。详见
[隔离会话计划](exec-plans/active/2026-10-16-managed-browser-session.md)。

此前按用户要求重新交付 `preview-20261017-2547e6e`：793 个应用、SDK、
依赖及构建/验收脚本 Git 对象与上一包 b3fd56a 相同，无新增运行功能。
干净重建后的离线 CLI/MCP 30 工具通过，独立制品审计 5,324 项、96/69/6
成员及四资产上传后回下载哈希一致。本地 100 文件复制一致；历史网页验证
未重跑。人工接管仍在开发、未入包；整体目标和普通公司 Edge 验收保持开放。

新增实验性 Windows `managed setup`：可见专用窗口登录后显式关闭，再由
`managed run` 串行复用持久数据。`managed-setup-QyXNkx` 五步与同源码
viewer 回归 `managed-viewer-cOCeeU` 四步均实际 exit 0；后者独审 19 项
通过。Go 全包及 vet 通过；没有重跑未变更的扩展全套测试。两次零业务前置
失败与其中一次查看器强制清理如实保留，详见独立会话参考。真人 SSO/MFA、
同文档中途接管、普通公司 Edge、OS 前台焦点及完整能力对齐仍开放。
`preview-20261017-b3fd56a` 已从干净源码发布：离线 CLI/MCP 30 工具通过，
独立制品审计 5,322 项、96/69/6 成员及四资产回下载哈希一致。登录流程
停止后独审另有 10 项通过；真实浏览器使用提交前验收 EXE，发布 EXE 单独重建。

已按用户要求交付 `preview-20261016-dfb9e6b`，运行功能与 e83c6d8 相同，
重建主机、离线检查、制品独审及上传后回下载哈希核验通过。新增显式隔离
Headless 原型在真实 Native Messaging 下完成五步验证（含原表单、原生子页、
截图和实际 EOF 清理），两次零业务前置失败保留。当前新增实验性 Windows
`managed run/status/stop` 和 CLI/MCP 名称选择，正式入口在 Chromium 156
完成三步原始业务/清理验证，实际 exit 0；停止后独审 37 项证据检查通过。
用户要求的新包 `preview-20261017-dde4d40` 已发布：干净提交重建、离线
CLI/MCP、94 文件完整包独立解压校验及四个上传资产回下载哈希均通过。
再次按用户要求交付 `preview-20261017-f2d3421`：隔离干净源码重建，432 个
生产 Git 对象与上一包一致，运行功能相同；新包离线检查、独立制品审计及
上传后回下载校验通过。开发中的 viewer 未入包，本次没有重跑网页业务。
本次开发已加入本地实时 viewer 和可信暂停/继续/停止，原始
`managed-viewer-5xVYLn` 四步实际 exit 0：38 个 PNG、真实 DOM 控制、同一
原生子页唯一提交、旧句柄拒绝和实际进程退出均通过；Go 全包/vet、扩展
1,873 项、builder 25 项、UI/辅助 20 项通过。登录接管仍未完成，这些结果
不替代普通浏览器焦点或公司电脑验收。新包 `preview-20261017-41577de`
已从干净提交发布：离线 CLI/MCP、96/69/6 文件独立制品检查及四资产上传后
回下载哈希核对通过。见
[隔离会话计划](exec-plans/active/2026-10-16-managed-browser-session.md)。

此前完整任务对照：

六任务两轮、双方共 24 次原始尝试已结算并完成停止后独审。OBU 12 项：1 blocked-environment、1 failed、10 success；Codex 12 项：1 blocked-environment、9 success、2 unsupported。
保留两项环境阻塞、OBU 首轮研究的桥接清理失败及 Codex 两项隐藏输入限制，
未以重跑覆盖。生产仍为已发布的 `e83c6d8`；本轮只改验收设施和文档。
这不证明速度、跨平台或完整能力持平，普通安装 Edge 与独立 OS 前台观测仍
开放。详见[两轮完整任务对照](references/paired-task-comparison.md)。

此前 e83c6d8 发布基线：

网络注册超时清理竞态已修复：原截止时间返回 TIMEOUT，注册开始后由原 registry
保留 enable/disable 回执，Pause/end 完成实际清理后才释放 Page。旧源确定性
EXPIRED/提前 detach 反例保留。最终完整浏览器 `3GBPrq`180/180、读中导航
`K6hnZi`2/2、普通导航 `4tsar9`2/2 均实际 exit0；Node3933pass/1既有
Windows权限skip，无源码漂移。读中导航是原生成功回复的受控延迟交付，核验旧
候选撤销和原资源释放，不能写成浏览器自然延迟。用户要求制作新预览包；完整
Codex能力对齐仍未结束；普通Edge人工安装保持开放，本次有限任务对照见上方。

此前完整导航基线：
同标签同源完整导航新增 `Ri2zjD`2/2 actualexit0；换页前后两原PNG、B首次输入前
隐藏检查及唯一可信提交通过。共享上下文判定器优先用uniqueId，避免数字ID复用
时误删后继；这是验收代码修正，未据此宣称生产缺陷。相关world `6jh6nS`与根
替换`BFDPU7`各2/2 actualexit0，Node3919pass/1既有Windows权限skip，无源码
漂移。生产源保持此前`SfCCYW`180/180基线；读中导航、BFCache及完整矩阵仍开放。

此前同文档根替换基线：
同文档根替换后的下一次冷读取已验：`0l1om9`2/2、相关`fi8VZ5`22/22，
均实际exit0且无源码漂移；新旧按钮位置/尺寸不同，保留原Document/loader/
context，两原PNG及唯一可信提交通过。Node3902pass/1既有Windows权限skip。
本轮只改验收代码；此前生产基线`SfCCYW`180/180继续适用，未声称重新全跑。
原`R58uno`因结束后已分离回执误判的exit1保留。导航、读中替换与完整矩阵
继续开放，详见[坐标反馈](references/raw-frame-feedback.md)。

此前兼容 worker 基线：
兼容 worker 世界复用已取得真实红绿证据：旧 `EuhlIy` exit1、同页1/2/3世界；
新 `e6vgkl`2/2 exit0、同页及context身份不变且始终1世界，原Input/PNG/POST/
End及清理独审通过，6689ms焦点零事件/零许可。持久身份失败只跳过可选读取，
不等待原输入；撤销仍清原资源。Node3881pass/1既有skip，冷六布局与清理专项
均通过。最终 `SfCCYW`180/180 actualexit0，名称/顺序保持；540693ms仅原
12activation/4control-popup许可，原输入/截图/正文/清理独审通过，无源码漂移。
导航/根重建/child替换及更广矩阵继续开放。

此前冷原生集成基线：
冷原生坐标反馈已接入生产：`JVWwm9` 六布局PNG/POST与原生资源独审通过，
`WbyEaV` 三场清理/真实worker替换通过；两轮均2/2、actual exit0。原输入
保持后台操作，真实held风险不会被私有连接恢复清除。Node3837pass/1既有skip。
最终完整 `ZXPe7X`180/180、actual exit0；原 `6L9esM`179/180、actual exit1
保留。旧失败是MCP正文测试在原单次Page.close后立即查询仍见一个tab，
补充真实close ACK/移除事件及有界完成观察后，专项`SN2lmN`7/7亦通过。
该修正只改两份fixture，生产源与冷路/重启专项保持相同字节。世界复用、事件
共存、普通Edge、全屏及整体矩阵仍开放，见[坐标反馈](references/raw-frame-feedback.md)。

此前的基础阶段证据：
冷坐标读取候选 `5pTnPP` 六布局原生矩形与独立 CSS 几何吻合，13原文档不变；
198原生调用全部结算，39对象对应12组释放ACK，6独立target实际attach/detach。
1,479ms零activation/focus/许可；runner和host原exit0，精确测试进程无残留。
Node3744pass/1既有Windows skip，源码/运行时无漂移。该阶段候选未接生产backend，
未以此宣称冷路PNG/POST通过；之后的生产接线与有限生命周期由上方新证据覆盖。

坐标高亮 warm 增量完整 `xS4ddv`180/180 actual exit0，旧178名称/顺序保持；
Node3666pass/1既有Windows symlink权限skip。18原PNG/POST（42,559B）、65原
对象释放ACK、39原文档及输入/截图记录独审通过。533,948ms仅原12activation/
4control-focus许可；可选读取不延长原错误/超时，必要清理和完整detach屏障保留。
早期冷CDP另有三原成功提交但误框的保留失败，不在该默认180通过数中；普通Edge、
全屏及整个能力矩阵仍开放，见[坐标反馈](references/raw-frame-feedback.md)。

可视消息清理完整 `HZSmT4` 178/178 actual exit0，旧176名称/顺序保持。
原消息结算、最终隐藏、pagehide token退役、本地iframe缓存恢复及同版本worker
恢复已验；独审覆盖原PNG/POST、截图原错误来源、源码/构建和精确进程清理。
527,274ms仅原12activation/4control-focus许可，受控视觉场景内无焦点事件。
Node3620pass/1既有Windows symlink权限skip。未使用时间容差、输入重放或
新增焦点许可；旧失败和预览ZIP保持。普通Edge、任意跨worker在途传输、
旧版升级、恢复登记前移除、OOPIF缓存、raw叶目标及全屏仍开放，见
[可视消息清理](references/visual-delivery-cleanup.md)。

iframe 内原元素高亮专项 `k2sWDv` 2/2 actual exit0：六布局原 PNG 的按钮四边
及祖先框排除、六点击圈、六原 POST/14,185B 和十三原文档均独立核验。
结束576ms仍隐藏；13,056ms零activation/focus/许可，精确进程清理通过。
相关回归 `za8xMZ` 17/17 actual exit0；Node3536pass/1既有Windows skip。
旧源六框错误和首候选nested点击圈丢失的真实失败保留。矩形是原节点快照，
raw跨域叶目标、全屏和普通安装仍待验，见[iframe元素反馈](references/frame-target-feedback.md)。
完整 `rkN0eF` 176/176 actual exit0，旧175名称/顺序保持；536,859ms仅原
12activation/4control-focus许可。原始视觉/业务、源码/构建和精确清理独审
通过；该历史基线的同文档跨turn边界由上述新切片继续处理，旧预览ZIP保持。

受限网站原页面 Blob 下载专项 `Y00W3K` 2/2 actual exit0：五入口×三布局
15原文件2,633B，十边界另6原下载1,091B；原default context、文档、GUID、
路径和字节独立核验。HTTP两份原拒绝分别保存，opaque共享Blob由浏览器
先行阻止，原日志前缀与最终日志一致；不能据此声称旧产品误接纳。49,806ms
零activation、原两次popup focus；延迟原release回执覆盖Pause失败且期间
策略未变，清理后才显式恢复。Node当前各组3478pass/1既有Windows skip；
旧失败保留。HTTP/POST完整来源及普通安装仍开放，见
[受限页面下载](references/restricted-page-downloads.md)。完整 `8zKuaa` 175/175
actual exit0；原有下载 `NnimoV` 2/2、负例/来源 `2gHGdI` 3/3均actual exit0，
后两轮30原文件5,200B及绑定/中断/恢复独审通过。完整旧175名称/顺序保持，
533,980ms仅原12activation/4control-focus许可；源码/构建与原键盘输入核验通过。

受限网站原生文件选择器专项 `btlfEb` 8/8 actual exit0，五入口×三布局与六
边界共31原POST/12,779B；15次原上传、15次显式清空及一次延迟ACK上传，
原文件、节点/文档/session、实际清理均独立核验。34,925ms零activation，
仅原两次popup focus。完整Node3398pass/1既有skip；仅修fixture断言后重跑
受影响整组1598pass/1skip，合计当前各组3400pass/1skip。Pause/end/detach
及引擎释放等待原文件操作；普通安装与整体持平继续开放，见
[受限文件选择器](references/restricted-file-chooser.md)。完整 `mAKsEd` 175/175
actual exit0，旧169名称/顺序保持；529,321ms仅原12activation/4control-focus
许可。31原POST字节、源码/构建身份及精确清理均独立核验，旧预览ZIP未变。

受限网站诊断和原正文读取通过专项 `gapwcs` 8/8 actual exit 0：五入口×三布局
及九边界共22原POST/17,316B、17原native正文读取；16返回原字节，另一次原ACK
后受控延迟最终超时。原request/context/document、策略与清理独立核验。
24,354ms零activation，仅原两次popup focus。Node3363 pass/1既有Windows skip。
共享订阅ready/清理等待真实ACK；自动失败不重发，明确清理可重试原Page资源，
迟到ACK不能detach继任。来源不明的worker/Log记录仍排除，普通Edge及完整
能力对照继续开放，见[正文契约](references/original-response-bodies.md)。
完整 `Q6zSPw` 169/169 actual exit0，旧163名称/顺序保持；502,193ms仅原
12activation/4control-focus许可，原业务字节、无重取、源码/运行时/构建和
精确清理均独立核验。该结果不改变普通安装或整体持平的开放状态。

受限网站的请求/响应等待已通过专项 `mYijy5` 8/8 actual exit 0：五入口×三布局
15 原 POST/11,842B，13 边界另九原 POST/7,919B，原请求/文档/redirect及清理
独立核验。22,970ms零activation、仅原两次设置popup focus。真实订阅/退订ACK
与原权限绑定；新建空白页在原期限内先等准备再验全树。Node3319 pass/1既有
Windows skip。导航无响应仅证明原超时，未冒称原生取消；旧失败、普通Edge和
完整能力矩阵继续保留。完整 `EiU6cQ` 163/163通过，旧157顺序保持，476,719ms
仅原12 activation/4 control-focus。之后仅runner失败取证/清理步骤调整，最终
专项 `5SV1It` 8/8通过，20,993ms零activation、原两次popup focus；两轮各自
版本的产物及清理均独立核验，见[网络等待](references/network-waits-design.md)。

同文档根节点重建后的反馈丢失已有真实红绿证据：旧源 `bxYaz2` 三原提交成功，
两个根重建场光标/目标框像素为零；修复 `RttFgP` 2/2 actual exit 0，三原
POST/13,147B、图层归属及像素核验通过，结束567ms仍无残留。4574ms零焦点/
activation；相关 `ppBrxc` 11/11通过。Node 3270 pass/1既有Windows skip。
下一有效反馈才恢复，隐藏、空根与页面同ID冲突不创建；旧动画不报告到达。
完整 `uLJcAS` 157/157 actual exit 0，原156名称/顺序保持；三原POST/13,039B、
原PNG与574ms结束清理独立核验。460,718ms仅原12 activation/4 control-focus
许可，源码/运行时/构建及进程清理通过。普通安装及P12完整范围继续开放，
见[重建反馈](references/dom-rebuild-feedback.md)。

受限网站现支持原生 alert/confirm/prompt 决策，固定原 emitter、文档及策略，
收集在实际清理完成后再验原权限。允许的 iframe 在权限检查期间提交不再误撤权；
只重读完整允许快照，沿用原一秒期限且上限八次，绝不重放输入。专项 `cin0qm`
10/10 actual exit 0，五入口×三布局 105 原 POST/26,592B、120 原生响应独立
核验；37,425ms 无 activation，仅原两次 popup focus。Node 3251 pass/1 既有
Windows symlink skip，原失败和诊断保留。完整 `BNmZJb` 156/156 actual exit 0，
旧150名称/顺序保持；466,299ms仅原12 activation/4 control-focus许可，源码、
运行时、构建及清理均独立核验。普通 Edge 和
`beforeunload` 后台限制继续开放，见[原生弹窗](references/native-dialogs.md)。

已补网站权限损坏记录的显式替换：用户独立选择新权限，原生保存后仍暂停；
运行时代号与 revision 防止旧请求和旧文档证明复用。专项 `cnAeAG` 4/4
actual exit 0，原 get/set ACK、唯一 1047B trusted POST、旧任务拒绝及原
13,298ms 焦点账本独立核验；Node 3187 pass/1 既有 skip。完整 `k3A9Lo`
150/150 actual exit 0，旧149顺序保持，444495ms仅原12 activation/4 control-focus
许可，无源码/运行时漂移。普通安装和完整持平继续开放，见[网站权限](references/site-access-policy.md)。

根 CSS zoom 导致的 AI 光标、目标框与点击圈二次缩放已修复，实际输入坐标
和原页面样式保持不变。旧源 `Ku2blX` 四次原提交成功但三场反馈错位，
正文缩放对照正常；修复专项 `pm3Zkp` 2/2 actual exit 0，四场 PNG/几何/
原提交与结束清理通过。Node 3151 pass/1 既有 Windows symlink skip。
完整 `AMMJED` 149/149 actual exit 0，保留旧 148 名称顺序，428874ms
仅原 12 activation/4 control-focus 许可，无源码/运行时漂移。
动态缩放在下一次实际反馈更新；普通安装和全屏等范围继续开放，见
[缩放反馈](references/zoom-feedback.md)。

网站权限启动读取失败现可从真实 popup 明确重读，保持原 revision、不写策略，
恢复后仍暂停；核心控制失败、在途操作及未确认清理不授予恢复权限。
拆开输入启动与读取恢复的等待，避免未绑定请求和启动 Pause 循环等待；
未知设置不再显示为默认已保存，丢失回复和同版本内容变化有反例覆盖。
专项 `yU2VGw` 2/2、相关 `GT3npA` 8/8 actual exit 0。原生读取成功后注入
派生交付失败，不能称自然 storage 故障；相关验收复用原控制 popup，不增加
焦点例外。首轮完整 `8Fe9ev` 146/148 的截图预算断言和第三次开弹窗失败
均保留，修正只在 fixture。最终完整 `O0mB6k` 148/148 actual exit 0，旧 147
名称顺序保持，430,422ms 仅原 12 activation/4 control-focus 许可，无源码
或运行时漂移。Node 最终 3137 pass/1 个既有 Windows symlink skip。
该读取恢复分片之外的普通安装继续开放；损坏记录替换进展见上，
见[网站权限](references/site-access-policy.md)。

HTML 模态框、嵌套模态框和手动/自动 popover 上方的 AI 光标与目标框已修复。
保留原实机 `FYfrul` 三次业务成功但反馈像素均为零的红例；Shadow DOM 内
手动 popover 修复后 `kVaOVU` 2/2、相关 `gTjanh` 9/9 均 actual exit 0。
三张原截图分别核对光标/边框，三个原 POST 与焦点/选区/弹窗事件账本保持，
结束后自有层 open 0、光标 opacity 0、点击圈 0。相关回归 14,003ms 无
activation/focus/许可；普通/CSP 八页 PDF 独立复核仍无反馈污染。
Node CI 3092 pass、1 个既有 Windows symlink skip。完整 `7uoTMN` 147/147、
actual exit 0，原 144 名称顺序保留；424,958ms 仅原 12 activation/4
control-focus 许可，无新增许可，源码/运行时无漂移。
普通安装、全屏、原生 UI 和完整持平仍开放，见[弹窗反馈](references/top-layer-feedback.md)。

AI 光标、点击圈和目标框现仅在屏幕显示，不再进入 PDF 打印布局。保留原
实机红例 `vNvX0d`；修复专项 `4A9CWZ` 3/3、相关回归 `h0x9xz` 8/8 均
actual exit 0，普通/严格 CSP 页四份 PDF 的八页原始渲染与前后反馈核验通过。
相关回归 10,369ms 零 activation/focus/许可；模块 26/26、PDF oracle 5/5。
打印尺寸变化可清除旧框，下一次悬停重新定位；MHTML 不做清洗。该次为定向回归，
普通安装与完整持平仍开放，见[页面导出](references/page-exports.md#fidelity-and-limits)。

原诊断响应正文已接入 JS/Python/Go/CLI/MCP，保留原 POST 与最终 native
session，禁止 URL 重取；异步授权、队列外等待、撤权和实际在途清理均有覆盖。
最终专项 `dx9EXR` 7/7、actual exit 0，五入口共 60 次原正文读取，含三布局与
15 个空响应；另有五个生命周期边界。完整 `tRDnRM` 144/144、actual exit 0，
旧 138 名称顺序保留，419,725ms 仅原 12 activation/4 control-focus 许可。
此前 fixture 类型/错误码/顺序失败保留。
正文上限不是 Chrome 内存上限，普通安装及完整 P01–P15 未完成；见
[原响应正文](references/original-response-bodies.md)。

首次键盘输入诊断已前移到导航前，并保留一次原 End、真实 native 回执及页面
事件顺序；64/64 定向测试通过。两次预声明隔离验收 `UplYfR` 2/2、`5eI49Q`
5/5 均 actual exit 0、零 activation/focus/许可，trace 无输入抑制记录。
旧 `bDKdec` 缺 down 未复现，生产输入代码未改。随后正文功能所需完整回归
`tRDnRM` 144/144 也未复现；九 End 与原生 trace 完整，仍不宣称旧偶发已修复。
见[键盘诊断](references/keyboard-chords.md#initial-key-delivery-investigation)。

网站策略已结算保存失败可从真实 popup 审阅并重试原候选，保持暂停与版本检查。
最终专项 `Y4Qq0W` 2/2、Node 2939 pass/1 既有 Windows symlink skip，actual exit 0。
完整 `bDKdec` 137/138、actual exit 1：本次权限重试通过，但首场键盘准备 End
缺少页面 keydown，保留原失败并优先诊断，不宣称整体回归通过。原生焦点账本
仅沿用原 12 activation/4 control-focus 许可。见[网站权限](references/site-access-policy.md)
及[剩余债务](exec-plans/tech-debt-tracker.md)。旧 preview 保持不变。

原生 alert/confirm/prompt 新增一次性明确决策，五入口×三布局已真实验收；
完整 `uZgxYp` 138/138，后续加强原输出/子目标清理证据的专项 `oYbXyC`
7/7，均 actual exit 0。`beforeunload` 原生 UI 激活任务页仍使后台验收失败，
保留原红例和严格诊断。完整矩阵与普通安装继续开放，见[原生弹窗](references/native-dialogs.md)。

CLI/计划文件选择器新增显式`--clear`，MCP接受必填的`files: []`；保留字面路径，
拒绝遗漏、null及会改变顺序的混合参数。Go803 test/subtest pass、27既有Windows
平台/权限skip，Node integration1383 pass/1既有symlink skip，actualexit0。
专项`IlKHn0`5/5、完整`7LDGsE`132/132 actualexit0，旧130名称/顺序保留；
六真实便捷流程12POST/4954B、194文件字节、六原文档空FileList及精确清理通过。
专项10938ms零focus/activation；完整362296ms仅原12activation/4controlfocus。
两轮fixture失败保留：lazy epoch采样及原64会话空闲回收；默认套件改在实际复用
主页面前显式恢复，不重放失败动作。原生安装和完整矩阵仍开放，旧preview未变。
见[文件入口验收](references/file-transfers.md#verification-and-remaining-scope)。

组合键现以固定parser完整校验，INVALID零输入且保留既有持键；部分执行的
UNCONFIRMED清理原attachment，原期限及继任隔离保持。Node2874 pass/
1既有Windows symlink skip、actualexit0。专项`l3BraN`9/9，完整`BGZwxy`
130/130 actualexit0，旧129名称/顺序与源/运行时哈希保留。九键盘场各轮
9POST/36074B，五invalid零Input、两受控partial及显式恢复通过；专项
74999ms零focus/activation，完整350576ms仅原12activation/4controlfocus
许可。无效键名内的错误码不再触发错误清理，旧红例保留。P12、普通安装和
完整P01–P15仍开放，旧preview未改。见[组合键边界](references/keyboard-chords.md)。

普通fill的原生文本分支新增原编辑宿主可信input确认，ACK单独不能报告成功；
页面取消/受控丢失投递明确失败且不重放。保留格式化、原生删除内部span、
Delete及setter边界，原attachment清理不影响继任。Node2800 pass/1既有
Windows symlink skip、actualexit0。最终专项`qyho7y`2/2含17场、11原POST/
33416B，六失败零提交，20157ms零activation/focus；完整`c4vgmp`129/129、
actualexit0保留旧128顺序，328568ms仅原12activation/4controlfocus许可。
四轮fixture失败保留；原生安装、Vivaldi路由和P12仍开放，旧preview不变。
见[文本投递证据](references/fill-delivery.md)。

当前会话自动发现补 IPv6-only loopback：原TCP拒绝才同端口回退，授权拒绝等
不触发重连，原身份和期限保持；Go518 pass/27既有skip，vet/跨编译通过。
`m0BgyU`五入口2/2 actualexit0，30原文件5200B与13415ms零focus/activation
已核实。普通启动Edge fixture两轮bootstrap失败保留，第二轮定位到误认外部
输入法daemon为测试进程；按实际可执行文件角色与精确身份修正，未知browser
helper仍阻断，外部进程不终止。第三轮`5klS04`原browser/host exit0、普通
参数重启及清理通过，停在人工扩展安装/授权之前，未发起业务；STOPPED exit0
不等于验收通过。P01–P15未完成。见[普通启动验收](references/normal-browser-downloads.md)。
随后确认该新profile受到Windows自动登录/同步影响，新增只读白名单检查，
拒绝污染且对日志脱敏；终态v3被明确拒绝，不是新实机通过。文件证据/清理
复用有界读取；修复后`aa3Fjb`五入口2/2、30文件5200B、14813ms零focus。
最终integration Node1332 pass/1既有Windows symlink skip，0fail/cancel，
actualexit0；runner68/68和normal proof36/36。不能代替普通授权/业务闭环。

原文件下载新增准备确认：五入口通过`requirePath`在一次性导出前固定原绑定/
generation/root target，准备中断线不能ready，ready后断线撤销旧waiter；
显式重绑仅服务新等待。Node2605/2605、JS158、Python122、Go SDK111与
CLI137顶层通过（24项既有平台/权限skip）。专项`99xibC`3/3含四页零触发与
原负例NetLog，4007ms零激活/focus；五入口`2WEsDf`2/2、30原文件/5200B，
13350ms零激活/focus。完整`9YXWxm`128/128 actualexit0，原名称顺序不变，
303905ms仅原12activation/4controlfocus许可。保留端口与relay归档的两次
脚手架失败，不放宽原门禁。
这不保证ready后未来传输成功，也不补普通启动授权、原生安装与跨平台范围；
旧preview不变。见[下载准备证据](references/original-page-download-delivery.md#readiness-verification)。

普通idle hover现同时确认原生ACK与原目标event-time pointermove，已送达不因
菜单遮罩/目标移动移除重放；兼容mousemove仍到达菜单初始化。已确认持键/
持按钮才可走旧路径，实际输入错误须显式释放。Node2552/2552，最终专项
`TTV0uq`8/8 actualexit0，六原POST/6704B、Pause10015ms、八原tab/target
清理通过，43538ms无activation/focus/豁免。同Node relay验证剩余预算与
回复因果，原两次fixture失败保留。最终完整`Ghqqmo`128/128 actualexit0，
旧126名称顺序不变；302099ms仅原12activation/4controlfocus许可，
本轮Pause10006ms、六原POST/6704B与清理核验通过。force/trial/已持输入及原生安装不扩充
保证，旧preview不变。见[悬停证据](references/hover-delivery.md)。

截图超时不再提前释放原生 capture 的渲染队列与 Pause 屏障；实际发送前复核
原 lease/attachment，底层完成后才清理，不重放截图。Node2467/2467，专项
`kSmNJ7`3/3含五场，原七PNG独立解码，39291ms零激活/focus/豁免；sentinel
视口高度变化保留。完整`kuWd2o`126/126 actualexit0，旧125名称顺序不变，
282457ms只有既有12activation/4controlfocus。浏览器测试持有已生成PNG的
ACK交付，使用Native Port adapter及Backend Pause入口，不等同自然raster
挂起、安装或popup UI验收。旧preview不变；完整P01–P15仍开放。
见[截图完成与验收边界](references/screenshot-completion.md)。

新增原地交付真实Native Port中断验收，四场各3/3、actualexit0：两after-ACK
边界×hostloss/真实workerstop×三布局，12原POST/2680B、原deadline后250ms
无业务重放；部分claim、marker保留/回滚及旧权限拒绝符合契约。六原host
正常EOF exit0，120清理通过；每场仅3既有sole-popup activation、零windowfocus。
最终integration Node1129/1129无skip/cancel，生产与旧preview不变；强杀host
历史descriptor保留边界明确，普通125未重跑。normal源及其他前台状态未解决，
见[原生交付中断](references/created-page-waits.md#native-interruption-results)。

辅助页原地交付已落地：`auxiliaryDeliveryVersion=1`，保留原popup/created-page，
撤销任务归属，实际清理/存储/回滚结束前阻断新轮次。新增28后端例及独立gate
复核通过，全部Node2339/2339无skip/cancel。专项`iUAIHY`2/2、三布局589B
原POST、6原页交付、3工作页关闭、持久marker及21清理通过；3829ms仅原3次
popup创建activation，无windowfocus。普通`ZUgidL`125/125 actualexit0，名单/
顺序不变，244371ms仅原12activation/4controlfocus。旧preview保持；VM重建
不等于新增交付的原生restart验收，normal源抢focus及完整矩阵继续开放。
见[交付证据](references/created-page-waits.md#original-page-delivery-evidence)。

条件popup源路由`wLjyi9`2/2、actualexit0：三布局原生未owned child跨窗接管、
589B原POST及正常finalize撤权通过；20项清理、浏览器/host实际exit0。
三次既有sole-popup创建activation许可，零windowfocus；Node260/260。
前提是唯一normal窗口已focused，不能覆盖其他应用前台或修复normal背景源。
该历史轮生产/旧preview未改；当时未验的auxiliary deliverable由上方新片补齐，
真实native注册边界仍未补齐。
见[条件路由范围](references/created-page-waits.md#popup-source-routing-feasibility)。

修复导航/关页清理失败后，结束任务或Pause使旧handle失效而显式恢复卡住的
缺口。session bootstrap仅重试本会话，Retry Pause先阻断再重试，自动故障
暂停不重试；原pending共享，持续失败继续阻断。最终12例旧源2通过/10失败，
相关137/137及全部Node2238/2238通过。后续四场真实native专项完成定向quota
故障后的恢复验证：每场3次原生拒绝、1次成功删除，同host/worker、原期限与
旧权限拒绝保持；146项定向Node通过。四场仍因focus/activation实际exit1，
不算后台体验通过；这是主动参数注入，不代表自然storage故障。见
[原生恢复证据](references/created-page-waits.md#native-quota-failure-recovery)。
此前完整普通`B5TASC`125/125、actualexit0，原名称顺序及既有
12activation/4controlfocus许可不变，不替代故障专项。
见[显式恢复](references/created-page-waits.md#explicit-recovery-after-navigation-or-child-closure)。

修复 host 断开后显式恢复反复等待旧清理错误的问题；同7例旧源3通过/4失败，
修复后7通过，全部Node2226/2226。真实Native Messaging专项`9QWc6h`验证
同worker下matched未交付child及时撤权、旧连接/权限拒绝与fresh源页可用，
原清理完成仍余18558ms。此场景未注入清理失败，不代替retry实机验证。
原网页及窗口/组/pinned保持，11清理项通过；业务focus和清理activation/focus
仍使整体actualexit1，无新豁免。完整后台体验未达标，旧preview未变。
完整普通`h6a5W4`125/125、actualexit0，原125名称顺序与12activation/
4controlfocus允许事件保持；不替代失败专项。
见[host断线范围](references/created-page-waits.md#created-page-native-host-loss)。

修复 created-page 在 idle/已淘汰 ledger 后的重启清理缺口；同11后端用例旧源
4通过/7失败，修复后11通过。隔离`MIrY1h`三种root状态的真实worker替换、
原claim隔离→删除、旧权限拒绝及fresh来源可用已验；host未重启。原文档保留，
零child输入/POST；15清理项和browser/host实际exit0。专项仍因5业务focus与
失败清理事件actualexit1，无新豁免。Node2206/2206；完整普通`EIJz4r`125/125、
actualexit0，原名称顺序不变，242172ms仅原12activation/4controlfocus允许事件。
旧preview不变；完整生命周期和P01–P15未完成。见[重启恢复](references/created-page-waits.md#created-page-worker-recovery)。

未owned新页专项`n7WyEq` **1/2、actualexit1**，之前`ozpg7l`/`7GbZtP`同样失败。
两个root原生child首次辅助接管、matched取消与失败清理后的持久撤权已验；
原鼠标释放请求后发生窗口focus，早于adoption，但与ACK先后不固定。188调用未见显式
激活，含11个already-detached拒绝，不算全成功。80原request/ACK、两旧child
新turn拒绝与21项清理成立；Node111/111。三业务focus、两清理focus全部保留，
零新增focus豁免；OOPIF/full matrix与正常finalize未过，生产及旧preview未改。
见[未owned新页失败](references/created-page-waits.md#unowned-adoption-and-background-window-focus-failure)。

新页五入口`AGsTeb`2/2 actualexit0：五caller×三布局15child、15唯一POST/
2933B，原scope与15arm/collect/cancel由429原request/429ACK独立核对。
双全组门禁在实际wire序号上成立；7888ms零focus/activation/豁免，sentinel
选择保持但高度1222→1165。30页、两observer、外部caller进程、浏览器/host
实际清理通过。Node106/106、typed IPC九方法/32场景、Go vet/build通过。
全部child继承原组，未owned首次adoption与完整生命周期仍待验；普通125
基线未重跑，生产/SDK与旧preview未改。见[新页等待](references/created-page-waits.md)。

共享Pause权限修复后的完整隔离浏览器`eRYJ16`125/125、actualexit0；243654ms
只有既有12activation/4controlfocus允许事件，无新豁免。七条等待/数据入口
不再把未验证预约的tabId作为detach权限，真实pending保持；14旧源码反例
全失败、修复后全过。扩展/build/fixture1123/1123，首次旧未绑定ID断言失败
保留且只修权限预期，未放宽原期限与迟到操作检查。新页专项`BQyEWc`2/2、
六POST1160B与3561ms零focus通过；Go客户端从当前源重新构建，旧preview
不变。五入口新页、未owned首次接纳与完整P01–P15仍未完成。见
[控制生命周期](references/control-lifecycle.md)。

正式新页等待已接三SDK/CLI/MCP，能力门禁为pageWaitVersion1；独立frame文档
台账、原monotonic期限及原scope返回Tab已实现。隔离JS`T7Nh7G`2/2 actualexit0，
双任务×三布局返回六原生child并提交六POST/1160B，未来iframe在ready后加入；
3360ms零focus/activation/豁免。全部child继承原组，未owned真实首次接纳、
五入口实机全流程及worker/host丢失仍待验。扩展/build/fixture1109通过，
SDK JS153/Python118/Go204零skip，CLI347pass/24既有skip；清理环及多余download
取消失败原证据保留，定向回归与全量单位测试修复通过。普通125浏览器基线
未重跑，preview未更新。见[新页等待](references/created-page-waits.md)。

新页来源可行性`FjJons`2/2 actualexit0，双JS任务×三布局产生六原生后台子页，
六独立原HTML nonce/六POST共1160B；外来任务拒绝，3454ms零激活/focus/豁免。
所有子页已继承原任务group，显式claim不算未owned页首次授权；正式新页
ready/collect接口在该可行性片尚未实现。16定向测试通过；首6697受限端口失败保留，HTTP
fixture改用有界动态端口绑定，未改浏览器策略或生产。12页/监听/浏览器host
回收已核，旧preview不变、125基线未重跑。见[新页证据](references/created-page-waits.md)。

原文件负例最终隔离`AtJMQl`3/3 actualexit0，Node79/79零skip/cancel。JS验证
合成未owned页的path/cancel拒绝、HTTP中断、原Browser流在private path在途
后切断、Native Port/普通操作保持健康、旧句柄断开及显式重绑后仍拒绝，新
下载可交付。三原文件49152B含独立observer未owned文件，不算Agent获得它；
3184ms零focus/activation/豁免。一次额外GET由完整NetLog同source归到Chrome
Download Manager resume并被405拒绝；旧三轮失败保留，不宣称零GET或自然
网络丢失。relay关闭有原cleanup警告，不冒称reset ACK。生产、61构建输入/
10bin及旧preview未改；未重跑125基线。五入口全负例、危险文件、普通用户
profile授权及其他平台继续待验。见[原文件交付](references/original-page-download-delivery.md#unowned-downloads-and-browser-connection-loss)。

当前会话发现已接入生产CLI，选定Chrome/Edge根目录只读端口文件，随后仍核
原Native Port/worker身份。原10秒授权等待截断已修，真实11秒握手与拒绝/
取消/迟到连接通过；单条CDP仍10秒。隔离`h9Udpf`2/2、30原文件/5200B和
12853ms零focus/activation，手动`ZwGUxs`2/2、18原文件兼容通过。
WindowsGo654pass/27skip、Node68、WSL binding23pass/0skip、vet及交叉编译通过。
这不代表正常启动人工授权、Edge/defaultroot实际连接已验；拆除shutdown
警告保留，不冒称reset ACK；未重跑125基线，preview未改。见
[当前会话连接](references/current-session-connection.md)。

正式原文件五入口正例现已通过`Fb9uuB`2/2、actualexit0：30文件/5200B，
6组都先收到5个ready再释放点击，原字节/GUID/来源/通知逐项核对；14000ms
零focus/activation，零豁免。修复复制后Python路径、gate期间子进程退出与
迟到Add ACK后点击预算的测试缺口；Node673、Python8、Go15检查全过。
最终生产host源码的未绑定完整`U32iKd`125/125，238890ms仅原12activation/
4controlfocus允许事件。外国GUID与两生命周期仍为parent JS负例，未owned
用户下载、root断连/危险下载、现有profile授权仍开放。生产源码及preview
未变，此片增加验收证据；完整范围见下面的原文件交付参考。

原文件交付已有可选的正式Host/CLI绑定与扩展私有通路。最终修复后的
Windows Chromium `M8DwSY` 2/2、actualexit0，JS接口取得18份POST/Blob
原文件共3120B，root/OOPIF/动态OOPIF、同名三任务归属与通知隔离通过。
两份额外下载证明pending path超时、实际取消及关tab撤权不取消原传输。
撤销ledger不驱逐，迟到ACK按实际期限拒绝；身份核实前不写Browser配置。
最终Node1837/1837、JS142、Python110及typecheck通过；Go607pass/26平台
skip，native包Windows69/Linux70零skip，vet通过。先前checkpoint的完整
`bi7ASp`125/125覆盖普通未绑定路线，不冒充最终bound修复后的完整套件。
旧preview未变；普通扩展安装尚不可交付Page GUID路径，未owned用户下载、
各入口完整负例、连接丢失/危险下载、当前用户profile授权及跨平台仍待验。详见
[原文件交付](references/original-page-download-delivery.md)。

最新SDK连接分片通过完整`yVGT4D` **125/125、actual exit0**，旧122项名称/
相对顺序保持；专项`aZMiIx`4/4。三SDK断线/close后保持终态，旧handles及
手工epoch不能重连，恢复需要新client、新handles和显式新turn。六真实
browser场景均旧操作零提交、新客户端各唯一可信POST；同backend实机与
跨实例原生IPC反例严格区分。Node1792、JS142、Python110全过零skip/cancel；
Go全仓519 test/subtest通过、26平台skip、8无测试helper编译通过，typecheck过。
完整244620ms仅原12activation/4controlpopup focus，新增零豁免；专项2753ms
零事件。新9个Go bin/50生产输入冻结，扩展运行源与旧preview未变。恢复
边界、原始失败与更多平台范围见[连接身份](references/sdk-connection-identity.md)。
Linux WSL2真实Unix socket另验Go523pass/10平台skip、JS142pass、Python109pass/
1 Windows路径skip，全新host集成及helper通过；186源码与20重建dist一致。
独立专项/完整原始业务、focus及构建来源审计通过。首次临时目录清空导致的
启动失败保留；未运行Linux真实浏览器、macOS或CGO race。

此前拖放分片通过完整`I0B25O` **122/122、actual exit0**，Node **1788/1788**，
零skip/cancel；旧121项名称/相对顺序保持。普通dragTo输入前绑定原两节点，
source在down前确认可信move与几何，提交后不重放；HTML目标在原生over后及
drop事件时复查原节点/CSS平面，修复hover旧点、替换目标及同AABB内部热点
误投。十场覆盖root/变换OOPIF、capture、显式位置和五拒绝场，旧错误POST与
初候选协议/旧断言失败均保留。透明探针110记录调用/唯一ACK（77Input及
11guard生命周期）、12原文档/HTML、5正确POST/28633B和精确回收独立核实。
237777ms仅既有12activation/4controlfocus，无新增豁免；sentinel身份/选择
保持，高1222→1165。专项`rxSklf`2/2、4328ms零focus。实际取消/释放预算逐
命令检查，迟到ACK及异常句柄保留归属，已确认操作不重发；正常500ms资源
释放与原输入deadline区分。51生产/53stage已核；最终包仅MODIFICATIONS
一句预持输入说明较实跑收紧，其他50成员完全相同。旧preview未替换，
Go/SDK未重跑，49源/八bin按已有manifest核验。worker丢失时guard恢复、
更广CSS/跨文档drag、force/trial/预持输入及P01–P15仍未完成，详见
[拖放提交与边界](references/drag-delivery.md)。

此前元素边界框/截图分片通过完整`iRrKtt` **121/121、actual exit0**，Node
**1723/1723**、零skip/cancel；原120项名称/顺序保留。正式boundingBox和
元素截图按实际renderer local-root映射原生border四角再求AABB，保留
负坐标、离屏、零尺寸及已知无布局null，原剩余期限贯穿私有dispatcher。
七场/八图核实际PNG字节、CRC、内部及边框像素，旧五个OOPIF错误裁切
反例保留。专项`yXtuCJ`2/2、3704ms零focus；完整新增223条原生调用及唯一
ACK、零Input、15原文档/HTML、118442B PNG和精确回收均独立核实。
237085ms仅原12activation/4controlfocus，无新增豁免；sentinel身份/选择
保持，高1222→1190。51生产/53暂存成员和普通ZIP一致，旧preview未改。
Go/SDK未重跑，49构建源/八bin沿用manifest核验。跨renderer退化平面、
更广perspective/DPR、非原子读取等边界仍在，完整parity未完成。详见
[变换元素边界](references/transformed-element-bounds.md)。

此前显式元素position本片通过完整`DF0lUQ` **120/120、actual exit0**，
Node **1699/1699**、零skip/cancel。旧119项名称与顺序保留；新八场覆盖
元素scale/rotate/zoom/perspective、同进程/OOPIF及hover/首击后几何变化。
单一HTML padding plane按原生quad投影，叶几何加入click指纹；旧生产八场
全部误位的证据保留。最终专项`gQRNO2`八场正确POST，3150ms零focus。
完整25Input、8唯一POST/83571B、11原document/HTML及八页/targets回收
独立核实；227112ms仅原12activation/4controlfocus，无新增豁免，sentinel
身份/选择保持，高1222→1187。原生root投影≤0.025CSS；OOPIF原事件逐轴最大
偏差0.173981CSS仍记录，投回root逐轴最大0.256823物理像素，非相同亚像素承诺。
SVG/非替换inline/fragment保留旧约定；hover/drag未获得click的提交后门禁。
51生产/53暂存成员、正常ZIP核验通过，旧preview不替换。Go/SDK未重跑，
原Go源和八个复用bin按build manifest核实。详见[元素position几何](references/element-position-geometry.md)。

此前变换iframe输入本片已通过完整`t0MP0c` **119/119、actual exit0**，
Node **1673/1673**、零skip/cancel。原118项仍通过，新增七场覆盖同源scale、
旋转OOPIF、nested、hover后遮挡/移位、首击后遮挡及旋转12×12显式position。
旧`SDqvcJ`真实三种父层误投保留。新adapter按实际renderer local-root
投影原生quad，以fractional CSS尺寸建平面并逐层命中原iframe；初始/hover后/
后继down比较原几何指纹，缺失或变化不放行按钮。专项`WmZggR`七场通过，
7859ms零focus，独立矩阵/原native/DOM/POST核实，七页及targets回收。
该历史分片不证明全部3D/pinch zoom、leaf自身transform的position或完整parity；
临时handle仍是上游best-effort dispose，非native释放ACK。完整证据及
限制见[变换iframe输入](references/transformed-frame-input.md)。

正式locator文件上传已完成本片验收：最终`tQEVZJ` **118/118、exit0**，
Node1642/1642、无skip/cancel；JS SDK134、Python99通过，Go全包通过且保留
26项既有平台skip。五入口×三布局hidden input及JS root目录共16次原node
上传/清空、16唯一POST/17909B与50文件实例/563B独立核实，零Input/chooser。
目录复用原native ACK+可信input，清空为合成事件；未知ACK与失败remote
release保留原锁/清理闭包。legacy省略epoch兼容修复有旧候选失败及四回归。
223212ms焦点账本仅原11激活/4控制popup focus与一项精确新增目录窗口首tab
激活；sentinel身份/选择不变，高1222→1165。16任务页/targets及新目录窗口
回收、两代host与51生产成员/53暂存成员独立核验。Go源树现明确包含.go。
此前`QL84QJ`6/7目录准备错误、旧源专项`Plei2M`7/7及完整`DSSqzQ`118/118
保留。它们不代替最终legacy修复后的完整验收；完整P01–P15仍未完成。
详见[直接上传边界](references/locator-file-upload.md)。

此前完整`WLM6bV` **112/112、exit0**，最终专项`uLGdWq`3/3，Node1581/1581，
零skip/cancel。门禁扩展到普通多击、双击和显式modifiers；首down后不重放，
后续down在原root点复核祖先命中及原receipt，每attempt在finally恢复键盘
baseline。旧候选的祖先遮挡、framePoint变化、断开三反例均确实失败，新
固定bundle定向50/50、独立含tracker75/75通过；变换frame与非原子边界仍在。
四真实场景共27条Input、4唯一POST/19,723字节，首击导航后拒绝第二击并
在原5秒预算内350ms确认新文档。完整212,803ms账本仍为原11激活/4控制
popup focus，无新增豁免；sentinel身份/选择保持，视口高1222→1202。
原111项名称/顺序保留，host测试重启及精确任务页回收通过。50生产成员、
暂存允许差异和当前SDK/host字节经独立核验；旧preview ZIP未更新。

初次完整`NNr3Bp`111/112仍保留：新增fixture把server GET错当文档提交，
读到旧loading文档。最终只读条件观察沿用原5秒预算，超时后不发布迟到
样本，不能声称已发出的读取被取消。此轮不证明自然Viz根因、全部变换
祖先命中、所有修饰键组合或P01–P15已经完成。

此前完整`FjHwEx` **111/111、exit0**，修正后受影响专项`Zth7Xv`14/14，
Node1544/1544、零skip/cancel。普通单击采用原节点可信mouse pointermove
及实际/预计两点局部命中门禁，保留原root路由、原期限和按钮不重放。
受控丢首move后恢复唯一提交，丢全部move在原5秒期限失败且零按钮/POST；
七份表单21个原始POST的值与一次提交通过独立核验。完整212,380ms焦点
账本仍为原11次精确激活/4次控制popup focus，无新增豁免。旧预览包不变。

首候选`hb2m29`100/111的11项旧frame/form超时及暂存诊断`9FyKTv`2/5
仍保留：原±1坐标谓词把已到原按钮的可信移动误拒绝。修正没有扩大固定
容差，也不将不同来源的布局坐标当作native事件认证。本片不证明自然Viz
故障已根治、后续按下路由已预留、跨平台或P01–P15全部完成。

统一被动pointer诊断已首次保留自然误投现场：`OBaCi6`12/13、exit1，Python
dynamic首轮click已返回，完整root ledger记录父IFRAME上的move/down/up/click，
当前child无pointer/click/change；原业务仍失败。7ms观察发生在cancel及实际
子进程close后，不是click时文档或native command关联证明。Node1482/1482、
独立143/143；默认受影响上下文`XXyxbu`13/13通过，尚未修复生产输入。

此前完整 `1OmROv` **110/110、exit0**，普通专项`ulluP9`13/13、exit0。
本片仅补CLI/MCP/Python失败partial与阶段、原错误保留，以及所有普通外部
调用器失败读取前的实际child close和精确身份门禁。Node1467/1467、独立
定向106/106通过；生产代码与前轮相同。专项18轮click ACK/collect等阶段、
36个child实际close及原POST字节已独立核验，成功无failureObservation。
两轮未复现动态点击故障，新增失败读取尚无本轮自然故障实测，问题保持开放。
完整193,286ms连续focus仅原11激活/4控制popup focus，零新增豁免；sentinel
身份/选择不变，初始高1222、末active查询1165而populate快照1204，几何及
采样差异保留。原host预期重启后新进程exit0，精确任务清理通过。

此前完整 `0prwDM` **110/110、exit0**，原109项名称与相对顺序保留，新增
录屏并发用例通过。root raw start/stop与内部渲染共享真实原生命令队尾，
frame ACK独立通行；旧实机负对照`rjMBXn`1/2、新专项`hmPQNY`2/2，确认
修复截图清理误停新录屏的竞态。Node1416/1416、独立定向107/107通过。
完整178702ms连续账本仍为原11次精确激活与4次控制popup focus、无新增
豁免；sentinel身份/选择不变，视口高度1222→1192，不能称几何完全不变。
本轮chooser成功不解释此前跨调用器的动态OOPIF失败，P01–P15仍未完成。

显式 `createTab({backgroundWindow:true})` / SDK `newTab` 已接入正式路径：
创建独立、不聚焦的 normal 窗口，任务页只在自己的新窗口中选中；省略或
false 保留原路径。能力协商、混合分组归属、持久撤权和只关闭自有 tab 的
finalize 已实现。它会增加一个可见窗口，未解除默认 inactive 页的目录限制，
也没有把点击、移动用户页或激活用户窗口作为隐式补救。

此前完整 `XHmJdq` **108/109、exit1**：原105项名称/顺序全部保留且通过，
新增四项通过三项。后台窗口目录用例在 dynamic OOPIF 首轮 collect 超时，
尚无 chooser、setter、失败时 DOM 或原生输入记录，不能确认点击是否到达。
root/static 共12轮核验9POST、20份文件载荷、272实际字节；8次可信目录选择、
一次合成清空、三项拒绝。连续186630ms内仍为11次精确激活、四次既有控制
popup focus、零未知事件；sentinel不变，精确任务清理与额外页保留通过。
普通 chooser 本轮通过并不解释上一轮失败。生产、host及SDK与上一轮同源；
新增普通 chooser 失败后观察未被本轮成功路径调用，Node1369/1369通过。

目录失败观察补齐后Node1373/1373通过，专项 `JwX2Bc` **10/13、exit1**。
四项新检查全过，但JS单次/JS双连接/Go双连接的dynamic首轮collect均超时。
三份自然失败观察完整，分别耗时6/3/5ms：精确当前root/child文档中，root
有一次可信frameAdd，child的clicks/changes为空，输入框连接且未禁用、无文件。
JS在cancel前读，Go在原子进程cancel/close后读。它们不证明点击时文档身份、
down/up序列或原生命中表根因；不能以观察完整宣称业务通过。下一步需分辨
点击序列的实际投递，而非重放输入或改用可能绕过祖先遮挡的child直发。

显式JS诊断现可记录每文档有界被动pointer/mouse序列，仅在失败后读；默认
六种HTML逐字节不变，Node1380/1380、独立定向22/22通过。一次`Cq7i08`
2/2、exit0未复现，三布局pointer观察均未请求/未验证；不能称点击问题修复。

轻量 `pointer-only` 复用默认失败后的精确 documentId 读取，去掉额外原生命令
包装与预先握手，成功不新增 DOM 读取。Node1388/1388通过；`S5wSpZ` 2/2、
exit0，6POST/97实际文件字节核验通过，零激活/焦点/豁免。未触发失败读取，
pointer完整性仍为null，不能替代此前13项上下文中的失败。随后保留原
13项名称及顺序，仅在目标JS双连接页面启用被动记录，观察上下文中的投递。

该 `pointer-context` 已通过Node1391/1391和独立57项。三轮固定顺序诊断为
`yLC7OT` 13/13、`NuEbdZ` 12/13、`HakXg4` 13/13，实际退出分别0/1/0。
中间轮Go dynamic首轮collect再次超时，无chooser结果/setter；6ms失败后
精确文档观察仍见root可信frameAdd、child无click/change。JS均通过且pointer
未读，不能当作投递证据或生产修复。下一步覆盖实际失败的Go路径。

Go目标观察随后接入相同13项上下文，定向及独立60/60通过。三轮`N6jxEP`、
`a95b4d`、`gx2jRn`分别12/13、13/13、12/13，实际exit1/0/1；MCP及Python
发生chooser timeout，Go仍未触发pointer读取。两失败路径只保留root/static
各2POST与dynamic零POST，缺少完整阶段/点击ACK/失败DOM，不能宣称新根因。
生产源码在这组实验中未改，跨调用器的动态输入稳定性继续未完成。

此前完整 `zyiYQg` **106/109、exit1**，原105项名称/顺序保留，四项新增
检查全部通过。JS 单次提交、JS 双连接和 Go 双连接的动态 OOPIF 首轮均在
collect 超时，尚未调用该轮 setter；缺少原生 Input/intercept 投递证据，
根因及与本轮变更的关系未定。目录正式新窗口路径完成16轮、13个真实
文件 POST、30份文件载荷共408字节；12次目录选择有可信 input，另一次
显式清空沿用合成事件。同步 witness 在 setter 返回的第一条回调检查，
没有用后续轮询冒充完成。三项非法提交拒绝，默认 inactive 负例可信
cancel 且零上传；混合分组/后台窗口 finalize 保留了额外的非任务页。

全套连续账本为11次精确激活（四次新窗口创建、一次自然继任、六次旧
fixture动作）、四次既有控制 popup focus、零未知事件；新窗口用例没有
window focus，原 sentinel 保持不变。首轮 `UPWXAL` 4/5 的 inactive
fixture 冷 scope 错误已修，原失败保留。该轮 Node **1347/1347**、JS129、
Python94通过；受影响 Go SDK87与CLI109个顶层测试通过，另有23项既有
平台 skip，不能写成全平台无跳过。旧发布 ZIP 不含本 feature；P01–P15
范围不变，动态 chooser 稳定性与整体目标继续开放。

目录 setter 现已修正完成契约：原生 ACK 加原节点可信 `input` 才能成功，
取消/超时不能冒充完成；同节点目录、普通文件和清空共享占用，未知枚举
不因断线或超时开放给后继提交。新增独立 setter deadline 和三 SDK 可选
超时参数。Node 1311项通过，包含真实 CDP Error object 形状的回归；这些
检查不等于默认后台目录上传已可用。固定 Chromium 156 会取消隐藏或非
窗口选中 tab 的目录枚举，默认 inactive 路径仍未解决。

前一轮默认完整 `Ob0pFy` **103/107、exit1**：原105项名称/顺序保留，增加
目录完成和隔离世界两项。目录首轮收到可信 cancel、0文件POST；JS/MCP/
Go 动态 OOPIF chooser 等待另有三项超时，失败密度增加，尚不能排除本轮
变更关联或回归。独立核源码/制品、成功分支24POST/380文件字节、原六激活/
四focus及原任务页清理；这些通过不抵消四项失败。实验 `Nl0c74` 的独立
不聚焦 popup 内 root/已有 OOPIF 目录上传成功，但动态 Add upload frame
动作超时，整体仍失败；它有三个新窗口首 tab 激活、零窗口 focus，不能
算默认 inactive 能力，也没有扩充主套件的焦点豁免。P10及整体目标仍开放。

Go chooser现会保留失败阶段和partial；显式诊断用有界父子握手记录原生
命令及失败后的浏览器metadata，默认不装探针、不增加动作或延长期限。
脚手架339项与Go helper包通过。诊断`nFsRPz`2/2、无hook专项`JWc1eT`9/9、
无hook完整`npV0kp`105/105，均实际exit0；完整焦点仍为原六激活/四focus。
评审后另修报告注释污染原caller结果及文件不一致仍标采集完整的问题，
最终诊断`PbIrsJ`2/2、exit0。后两项仅报告处理，未改生产或浏览器步骤；
完整运行在这两项报告修正之前。旧`X2wiUq`故障未复现且根因仍未定，
不能宣称已修好；失败现场读取只经受控测试，实际该超时的读取尚未发生。
本片是可诊断性与回归进展，整体矩阵及目录完成/跨平台缺口继续开放。

最新选择器提交修复防止同一chooser并发写入及迟到撤权成功；清空释放
绑定原attachment，合法change导航保留。Node864/59/296通过，实际专项
`frp1Zt`9/9及初版全套`WUe0YQ`105/105。最终源码`X2wiUq`104/105、exit1，
Go动态OOPIF首轮chooser等待超时，尚未明确arm/collect和click原生结算。
新case与其余原104项中的103项通过，不把初版全绿代替最终版本结果。
最终焦点校验通过，原六次fixture激活/四次控制popup focus均保留；无新增
豁免。完整矩阵仍有缺口，目录完成及跨平台验收未由本片覆盖。

新生产版本同源码/包的主回归 `run-p0iiaM` **104/104**、终端exit0，独立
核379源码/226旧结果、host/六调用器/47制品成员通过。连续焦点账本的
六激活和四focus精确对应原有fixture动作，没有新增豁免。旧 `run-chNw0r`
41/104及最终focus-ledger失败保留；用户确认测试时段操作过浏览器，
该轮存在外部操作干扰，不能作为干净对照，也不逐条归因给用户。
完整CI为1079项Node（827扩展+53脚本+199脚手架）、JS115、Python82与
Go全包通过；真实Brave `i40fyX` 默认任务/清理和零焦点通过。Vivaldi
`yeWkzC` 已证明生产首连接检查后原goto可执行，但原fill仍为空；About
早失败 `wv2kHQ` 保留。继续验证无额外点击的输入候选，总体目标未完成。

随后独立DOM.focus候选 `YMxiBJ` / `ntZmPW` 均让原节点获得可信focus，
但原单次fill仍无输入事件、唯一POST为空，因此未进入生产。最终诊断
改用对象语义和同worker序号，避免字段顺序/跨进程时钟误判；原失败
未改写。脚手架217/217、独立新18/18通过。最终默认Brave `KKcjBO`
完整任务/实际PNG/744ms零焦点及精确清理通过；两轮最终独立审计核381
源码/228旧结果/47制品成员一致。诊断完成不等于任务成功或整体对齐。

显式hover候选 `Fm2cYE` 已完成独立核验：原输入框确实由未悬停变为
悬停，但随后原fill无输入事件、唯一POST为空，task/acceptance均失败。
552ms连续零前台事件及清理通过。默认Brave `zwqwku` 原12步、真实POST、
实际PNG、697ms零前台事件和精确清理通过；两轮独立核383源码/230历史/
47制品成员一致。脚手架231/231、独立定向63/63通过，生产/SDK/host/ZIP
未改。公开IME入口使用同一focused-widget选择，未发现值得重复输入实验
的新路由；下一片转P04观察元数据，Vivaldi通用fill缺口继续开放。

| 区域 | 评分 | 原因 | 下一步 |
| --- | --- | --- | --- |
| 产品面 | B | 三 SDK 与 CLI/MCP 已接显式后台窗口，正式目录上传及混合归属清理通过，默认 inactive 目录限制保留。最新完整 `XHmJdq` 108/109，原105项全过，新增目录dynamic首轮collect超时；旧普通chooser故障仍未定位。此前共享研究、页面下载、Chrome 原生 launcher 等证据保留；Edge 原生 focus 与 Vivaldi 输入缺口未解除。 | 定位动态 chooser 稳定性，继续 Page GUID 路径/取消、headed OS 剪贴板、其他浏览器/平台及更广同组任务。 |
| 架构文档 | B | 本地 IPC、动作协议、观察/capture refs、control 生命周期、暂停、来源边界与 incarnation/startup witness 已有 reference；新增 native 重连 timer/alarm 调度、真实 launcher/EOF 验收边界及 chooser 准备确认/原 deadline/实际清理契约。 | 查明 Edge 隔离原生恢复的未知 focus，补更多恢复顺序、签名更新及受限入口。 |
| 插件 UI | B | MV3 popup、content cursor 和打包校验具备；真实暂停/失败界面与三种网站策略已截图检查。恢复指导区分关闭原受控页、完整退出重开及可能额外重启，风险退役后立即撤下建议；20张实际恢复PNG已校验，关键三图已查看。 | 更广平台浏览器验证及网站规则可用性持续补齐。 |
| 测试 | B | 本片 Node1373、JS129、Python94通过；受影响 Go SDK87与CLI109个顶层测试通过，另有23项既有平台 skip。真实 `UPWXAL` 4/5 的 fixture 问题修复后，完整 `zyiYQg` 106/109、随后 `XHmJdq` 108/109；独立核原105项顺序、新case、已完成目录字节/返回时 witness、源码/host与精确focus。历史全绿和长闲置证据保留，不抵消当前失败。 | 补动态 chooser 故障所缺原生投递证据及完整回归，继续其他平台、恢复顺序、签名更新与更广同组比较。 |
| 可观测性 | B | 公开 diagnostics 有界记录真实 console/error/network；新 CRPage 在原生回调创建 handles 前过滤旧时间戳的 console/exception/Log，覆盖 root/OOPIF/worker，原 raw CDP 通知保留。真实重连/转交重放和新消息均已验收；时间边界依赖稳定系统钟。独立 network wait 有 ready 确认与原 deadline。 | 补系统时钟跳变后的隔离、可脱敏 debug trace 与更广真实站点场景。 |
| 安全 | C | 本地 IPC、control epoch、暂停和通知已有回归；popup 独占的 origin 规则、完整 frame 检查与受限模式禁未经验证入口。普通标签移出任务范围及 host 断线同步阻断旧操作，清理后只接受显式新控制范围，不重放请求。持久数字 ID 绑定 session incarnation，原生 Input 发送前记录风险并在持久化等待后再次检查 deadline/epoch/站点/释放状态。未知输入保持阻断；session ID 不作认证，策略不是网络防火墙。 | 受限模式更广 CDP/数据操作、peer 授权及安装审计；未知持久写、更多进程重启恢复及 extension reload/update 顺序仍需专项验收；数字 ID 碰撞已有确定性回归。 |

安装与发现本片新增 Windows Brave、Opera、Vivaldi 默认 catalogue、显式
selector 和共享 namespace 的 origin 合并/冲突校验；重复 profile UUID 保留
歧义。新 Go host 的 `run-Ov7GEM` **104/104** 通过，原 case 集与既有焦点
豁免未变。Brave `native-installation-brave-f2CLp5` 另以真实 connectNative
通过后台任务及清理；最终 host/脚手架的 `native-installation-brave-eF73Op`
再次通过，连续零激活/零focus。Opera 此前发现修复后仍有新页分组失败，
本片后续已修复并独立验收，见下文；
Vivaldi 实际连接/发现通过，后台输入与导航仍失败。生产固定注册仅只读核验，随机
HKCU 叶的导出验收不能代替生产固定名称安装、全品牌恢复或其他 OS。
完整边界及后续品牌结果见 [Chromium 安装](references/chromium-browser-installation.md)。

独立 Vivaldi 首文档诊断新增15项回归，脚手架合计 **157/157**。
`7y16Q1` 的管理页与观察页先提交再连接，229/155ms内完成，但实际fill
仍为空、唯一POST也为空；诊断完整不等于任务通过。默认Brave `t8wpE8`
通过及独立审计，生产/ZIP不变。新证据核371源码/214旧结果，清理完整；
已有初始化和输入缺口未解除，详见[首文档记录](references/vivaldi-initial-document.md)。

后续原生输入诊断与任务首提交检查增加23项，脚手架 **180/180**、独立
定向77/77。`PI0rSV` 在初始化超时、未到输入，失败保留；`QAMMuD` 等待
原blank文档提交106ms后goto完成，真实Input.insertText参数/目标正确且
ACK，但同文档原输入节点与唯一POST仍为空，没有输入事件。诊断完整
不能算任务通过或已确认底层原因。默认Brave `QC0zdV` 回归、实际PNG与
独立审计通过，四焦点检查点零事件；生产/ZIP保持不变，详见
[输入诊断](references/vivaldi-input-diagnostic.md)。

新的逐键对照 `HrDsGN` 已核78条正确native key命令全部ACK，但原文档无
键盘/输入事件，POST仍空。独立pointer对照 `ttYgKb` 则在一次明确输入框
点击后，原fill真实写入并提交正确文本；原截图、finalize和关页通过，
1068ms零前台事件，独立核379源码/220旧结果与完整清理。默认Brave
`TKisEN` 回归与独立审计通过。诊断任务成功不解除生产fill兼容缺口；
没有把额外点击加进生产或改写既有失败，原host/ZIP保持不变。

最终脚手架 **198/198**、定向独立94/94。首轮196/197的唯一失败是
Node fetch拒绝随机分配的端口，原日志保留；对应form单测改用真实
node:http并覆盖错误、截断和超时，机器配置及浏览器fixture未改。

最终 Opera 发现修复后的主回归 `run-ewJVHf` **104/104**，终端exit0。
364源码、203旧结果与host/六调用器身份独立核对；15研究任务90来源GET/
15POST、75建60关15留正确，六激活/四focus仍全为既有明确fixture动作。
上一片完整CI为947 Node/JS115/Python82/Go全包，没有新增焦点豁免。

普通无组任务页这一片的完整 CI 为 **1,001 Node（806+53+142）**、JS115、
Python82、Go全包通过。Opera `7IDBb7` 与 Brave `vC2mkf` 原生多页验收
各有四 GET/五 POST、handoff/显式恢复、精确跨任务拒绝、实际关页与
deliverable 新 scope 撤权，独立核验通过；两轮连续焦点均零事件/豁免，
原生进程与注册完整清理。Opera 无组路径和 Brave 原分组路径都有实际
证据。Vivaldi `b9p876` 则在独立焦点观察页求值失败，已原生连接但未到
任务，没有把它计为通过。制品和边界见上述浏览器安装记录。

最终主 `run-5TPsWz` **104/104**、terminal exit0，独立核369源码/210旧
结果、47制品成员、host/六调用器，以及15研究任务90来源GET/15POST、
75建60关15留通过。六激活/四focus仍精确对应原fixture，未扩大豁免；
默认Port adapter不替代另行真实native验收或长期/跨平台能力证明。

最新后台专项 `run-ttHLU9` **2/2**：三独立任务、两页命令静默310.088秒，
首次恢复截图及新状态正确；172原始POST、182PNG/2912像素、490原生渲染
区间/563跨owner重叠经两路独立检查。8页真实关闭、原4tabs不变，连续零
激活/零focus。默认 `run-NDr4vF` **104/104** 保持原case集合，其六激活/
四focus仍由已有明确fixture动作归因。首轮DPR几何失败保留且只修测试。
生产/原ZIP未改；document visibility实际为visible，不宣称隐藏页节流，
更长期/更广配置和其他既有缺口仍在，详见[证据边界](references/background-parallel-workflow.md)。

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

本轮组合定位与共享表单最终 `run-6SwxDM` **77/77**、专项 **8/8**、完整
CI **824**；独立核对七任务原始提交、五收据 PNG、旧媒体/诊断及连续焦点
账本通过。六次创建激活、四条主动 popup focus 精确归因，sentinel 不变。
Codex Edge 相同三布局最终任务 **3/3**，但方法失败/替代及严格跨 frame
指针 **0/3** 分开报告；不推断速度或完整能力对齐。最终 ZIP **1,246,279
bytes / 45 files**，SHA-256
`baa12d3e3627305565110172dcd4f0e432e05ad17102aa7311bacc5c99d27dfd`。
制品与实测源码一致，无测试钩子；新SDK源码/dist已追踪，Host沿用旧binary。

P13 本轮独立审计 `browser-restart-w5chI9` **8/8**：四次真实扩展reload
保持原浏览器和独立observer，旧request不重放。未witness的风险在第一次
真实startup只stamp、第二次退役，已witness风险一次退役；原页关闭本身
不清跨代风险。六代全部退出，五段重启空档明确；零tab激活，22条focus
严格归因11次主动popup。20张PNG、原始journal/Port/Target与源码hash均通过。
当前主回归 `run-FPduQP` **77/77**；未知原生写、真实native launcher/EOF、
签名更新和更多平台仍未覆盖，完整目标保持active。


最新原生生命周期范围见 [验收记录](../scripts/browser-integration/README.md#recorded-acceptance-and-remaining-edge-focus-issue)。
Chrome 最终三项成功与 Edge 严格焦点失败分别保存，前者不抵消后者。
单一 pending retry 消除 heartbeat 推迟重连，alarm 写入串行化；packed30秒
限制的回归是确定性模拟，实际 unpacked 验收不冒充 packed 唤醒证明。


Edge 空闲诊断在无 SDK 动作/host 故障/reload 时仍有一次焦点变化，与
开发者提示日志相差1ms；Chrome 同策略空闲对照无事件。诊断 complete
不等于 acceptance passed，原 Edge 恢复失败继续保留。新模式的默认 Chrome
回归 `native-lifecycle-0B1hfL` 3/3、脚手架75/75；生产及交付包未变。


最新chooser准备确认已通过专项 **9/9** 与完整 **83/83**。五入口30条原始
上传/清空POST及另6条生命周期请求均独立核验实际文件字节；全套连续focus
账本119643ms内六激活/四焦点均精确归因，sentinel不变。真实浏览器暴露的
timer receiver与新OOPIF commit-before-swap缺陷已修复并有回归，旧失败保留。
本片采用Port adapter，scope审计不含完整RPC transcript，焦点区间不含
启动和退出；没有新增Codex上传对照，也未解除Edge原生focus失败或完整P10缺口。

本片交付ZIP **1,251,944 bytes / 46 files**，SHA-256
`8990be12bf0702945e919b6f852246bea01feb56dfba7558939b91a3f85f5f9d`。
逐成员与unpacked及两轮实测hash/静态字节一致，无测试插桩或私有路径；
ZIP外的本地构建元数据不属于该审计的公开交付内容。

页面下载准备确认本片已完成五入口验收：Go1.26.9专项 `run-lMFHcB` **9/9**、
完整 `run-k3mDiy` **89/89**，16组独立检查通过。24份实际文件98,376字节、
原生GUID与scoped通知、OOPIF、取消观察后真实传输完成均核验。完整CI
**906** 项Node（771+53+82）、JS115、Python82、Go全包通过，无跳过。
新增官方go-winio0.6.3关闭修复及真实单次/并发Close回归；旧601秒CI失败
保留。初始normal/focused窗口下129,574ms账本六次创建激活、四次主动popup
focus精确归因；此前87/89的minimized窗口失败原因仍未知，新只读初末状态
快照没有放宽焦点规则。旧Edge失败、Page GUID路径/实际取消及完整P10缺口
均保留，也没有新增Codex下载对照或OS原生launcher验收。

最终ZIP **1,255,479 bytes / 47 files**，SHA-256
`cef6706a1cf69717835f168c4e96bd1f20146f0dfc610e9b28b58434a2c5a0c8`。
逐成员与unpacked、两轮实测生产hash及静态字节一致；无测试插桩或私有路径。
新主机和五个Go程序的Go1.26.9/winio0.6.3/xsys0.48.0及hash均独立核对。
证据不是签名或可重现编译证明；完整目标继续active，仅本地提交。

共享研究任务新增五入口×三布局15项：专项 `run-AOpN3n` **16/16**、全套
`run-WWWaGP` **104/104**，两轮独立审计原始资料/POST、准确来源与比较、
75创建/60关闭/15保留通过。专项连续focus账本零事件，全套仍为原有六次
fixture创建激活、四次控制面板focus，没有新增豁免；既有tabs元数据不变。
CI **920** 项Node（771+53+96）、JS115、Python82、Go全包通过，最终调用器
另有定向检查。仅增测试与文档，生产与上述47文件ZIP保持原SHA。

Codex Edge同fixture三布局最终报告 **3/3**，无浏览器方法失败/替代；
跨源和动态frame读取、单次提交与页面回收可见。任务后证据导出语法错误
及server stdin关闭导致的强制退出（exit1）保留，不记正常停机通过。
该端无独立OS焦点/原生生命周期账本，合成脚本任务也不证明模型的开放
网页研究水平；完整P15和其他既有缺口仍开放，详见
[shared research workflow](references/shared-research-workflow.md)。

位置快照新增opt-in `boxes:true`：三原生DPR专项`oVaN3m`/`wTM1CH`/
`x5s4pZ`各10/10，45张PNG、315目标框、180 iframe owner框和原生ref读取
经独立审计通过，坐标偏差0，三个观察区间均零focus/activation。完整CI
扩展836、构建脚本59、集成脚手架236、JS120、Python86及Go通过且零跳过；
随后只修测试DPR配置/Go截图编码，最终脚手架238及Go新增1项通过。
新48文件ZIP SHA-256为`48b3ebce87df69537f46ce55df8886412419e8a97c387a83c03aca2b3fc5309b`。

首次新版本完整回归`7YcNf9`实际exit1：原104项99通过/5失败，另有focus最终
校验失败。动态OOPIF chooser在点击ACK后未观察到打开事件，原10秒等待
超时；后段出现未归因focus事件，窗口最终minimized，两个popup失败。
这两种问题尚未定因，不能用本轮专项通过更新全套为通过。首轮动态DPR
失败`tIVleQ`及其审计、旧外部操作干扰轮都保留，目标继续active。

用户对`7YcNf9`时段反馈“可能点了点窗口”，因此补记可能存在外部操作，
不作为无干扰焦点对照，不把所有事件或更早chooser超时直接归因于用户。
新增opt-in chooser诊断和独立审计`Yh4Yz7`：69条原生命令均ACK、6次
原生chooser与真实POST、2691ms零前台事件，生产未改。本轮未复现，
失败后DOM采集分支尚无真实故障覆盖；采集完整与验收通过明确分开。
最终脚手架250/250、定向15/15、原HTML字节及制品身份核对通过。

关闭诊断后，新默认主回归`ZzBRWH`实际terminal0、原104/104通过，包括
此前失败的chooser、两个控制popup、撤权及host restart。结果无诊断对象
或探针hook，原case集及焦点豁免未改；这次通过不解释或抹去旧失败。
独立审计核194500ms同observer连续记录，六激活对应原auxiliary创建、
四focus对应原两次设置popup，后台豁免0，初末root均normal/focusedtrue。
十五研究任务的真实资料/POST/页生命周期及冻结制品身份通过；启动退出
仍不在焦点覆盖内，完整能力矩阵与平台缺口保持开放。

MCP固定实际连接分片：Go全包、Node1153（836+59+258）、JS120、Python86
完整CI通过，当前环境未运行CGO race检测。Windows真实IPC测试覆盖同路径
同UUID替换、迟到半帧、通知排空和未知结束结果；明确不重发现、不重放。
浏览器专项`ykbo3D` 2/2、terminal0及独立审计通过，原始stdio/两POST/
三次断线拒绝/页回收一致，5999ms焦点零事件、零豁免。仅覆盖同浏览器
Native Port adapter的host重启，不替代多浏览器或原生launcher验收。

随后同构建默认`k5giEj` terminal1、原104项103通过/1失败：JS动态跨源
iframe下载等待达到原10秒期限，文件端点GET和下载事件均缺失。四个
其他入口同类下载、15研究任务及恢复测试通过。扩展/JS路径与上一成功
轮字节相同，但现有日志不能判定点击时DOM或新child初始化顺序；不得
直接归因MCP或手动窗口操作，也不能把专项通过当作全套通过。完整目标
继续active，后续补有界点击/失败DOM诊断。

下载诊断分片新增独占开关、原调用阶段和透明有界native记录，失败后原
scope一次总3秒只读DOM；共享chooser记录器仅新增download白名单类型。
集成脚手架284/284、独立定向32/32及6份HTML字节一致核对通过，原10s/5s
期限与单次点击保持。诊断`avWmSX` 2/2、terminal0及独立审计通过：29原生
命令完整ACK、3GUID/真实GET/实际文件12,297bytes一致，3784ms无前台事件。
旧下载超时未复现，失败DOM分支仍无真实故障覆盖，不能称生产问题已修复。

关闭探针的`Ve7nKv` terminal1，原104项87通过/17失败，另有focus最终失败。
五入口下载及生命周期均通过；21:30:52新增focus后持续账本拒绝。用户
确认当时有窗口操作，因此不作为无外部操作的焦点对照，不把所有失败
直接归因于用户，不改写原记录。v30的405源码/241历史及原48文件ZIP、
主机/SDK保持，后续仍需完整无干扰回归和全部既有能力缺口验收。
