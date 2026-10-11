# 质量评分

用这份文档按产品区域和架构层次记录当前质量水位，方便持续知道最薄弱的地方在哪。

## 建议的评分标准

- `A`：覆盖完整、行为稳定、文档清楚、运行风险低。
- `B`：整体可接受，但还有明确短板。
- `C`：能用，但需要针对性补强。
- `D`：脆弱、缺少规范，或很多行为尚未定义。

## 当前评分

最新完整`FjHwEx` **111/111、exit0**，修正后受影响专项`Zth7Xv`14/14，
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
