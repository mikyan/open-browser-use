# 子页面的人工弹窗

## 晚到URL提示核验与新的打包请求

用户询问是否结束，并再次要求新包；完整能力对齐仍未完成。本轮在77f6fa8
之后修复晚到URL通知误取消有效弹窗的问题，准备把两轮已验证修复一并发布。
当前human只记录待核验通知；新的人工操作用原candidate及原生根文档ticket
复核，限制五秒和八次检查，不推进结果登记。End唤醒等待并先取消原弹窗，
已发送操作保留原回执。实际Chrome读取和权限检查循环分别纳入清理，避免
Promise.all早失败或策略超时漏掉未决读取；退役检查阻止续读和撤销后继状态。

九项实际后台测试通过；两个真实读取保留反例先红后绿，原记录保留。
控制器/弹窗/预算195项、原生图谱/事件145项通过，独立窄审未发现阻断。
全新构建冻结432份源输入和77份扩展文件，2828项Node及Go test/vet通过。
源清单新增实际执行的顶层脚本测试及锁文件；首次浏览器预检因runner漏列
这些输入而失败，发生在启动浏览器前，原失败保留并修正清单。

两runner改用共用输入选择函数，仍严格比较全部构建输入；55项相关测试通过。
同一冻结构建的`mrd-nHnhSe`、`mrd-LLcuP1`和`mod-97DqRB`三场均实际退出0，
分别完成首帧前出现、导航时出现和四稳定布局的原prompt回答、唯一POST、
End及正式Stop，cleanupErrors为空。Opening早于首帧不等于回答早于首帧；
晚到通知的特定时序由后台反例验证，不把普通真实导航通过当作同一时序证据。

三场原事件独审1437/1458/426项、生命周期70/71/88项通过；26/27/30个原
PID及创建时间身份全部退出，6/6/20张PNG解码，代表界面已目视核对。
正式Stop和原资源清理均确认，没有强制终止；审计器格式适配失败另存，原报告
不改写。构建绑定独审2837项通过，全部Node命令测试输入均纳入432份源快照。

## ff1d9d3交付后的原上下文和并发结果记录修复

继续完整Browser Use目标，本轮不新增包或PR。页面准备只等待已观察原commit的
首个默认context，成熟后保持原严格身份；新导航、context替换、End及超时均
不能补权，起始可选事件证据缺失保留冷路径。控制器按原事件唤醒，并保留实际
准备Promise和清理义务。结果记录使用有界原记录队列，真实journal回执先推进
lineage再拒绝退役调用者；同目标共享提交结果、旧异文档不能回退，撤权删除等
原commit和完整队列，未知写失败不重试。

定向反例先失败后通过，controller147项、graph/context125项、真实journal等
26项通过，独立审查未发现阻断。新冻结构建Go全包test/vet与2791项Node全部通过，
412份输入、77份扩展及EXE经2736项绑定核对；16个未入selected snapshot的脚本
测试仅另核当前HEAD内容，不夸大原快照范围。生产输入冻结后未修改。

readiness runner补充被动URL/status事件，并修正对已脱敏promptText字段的误读。
原`mrd-9Xezna`的正确回答与POST不改变整场exit 1结论；修正有先红后绿反例，
36项定向检查通过。新`mrd-R2RlH5`和`mrd-1yX7Xa`实际exit 0，分别完成首帧前
出现与导航时出现的原prompt回答、唯一POST、End及正式Stop。Opening早于原生
首帧，回答时发布阶段为preparing/navigating，不宣称原生回答先于首帧。
同构建`mod-44Rx1T`四布局四个prompt全部回答，实际exit 0。各原失败保持不变。

两准备期原事件独审1411/1432项、生命周期各69项通过；各25个原进程身份退出、
6张PNG解码。四布局事件426项、生命周期44项通过，31个原身份退出、20张PNG
解码和目视检查。所有正式Stop与原清理均确认，无强制退出；精确Native身份用
原uint64 FILETIME。9Xezna另100项审计确认清理，整场仍失败；审计器两次格式
适配失败保留。新导航URL更新早于Opening，未覆盖晚到更新问题。

晚到URL提示撤代仍未修改，不能从一次导航通过推断竞态已消除。完整能力对齐、
公司Edge和其他未覆盖边界继续开放；这批开发修复不在ff1d9d3安装包内。

## 准备期测试修正与再次打包请求

用户询问是否结束并再次要求新包。完整能力对齐仍未完成；本次保持 ecbda21
产品功能，收尾测试与诊断记录后从新的干净提交重建，未加入未验收的竞态修复。

runner 保存原 preparing/null viewport 的首次 pendingDialog 发布，而非要求
后续读取时仍未就绪；同租约、代次、弹窗可在回答前正常进入 active。原 Opening
仍须早于原生首帧，记录回答阶段但不声称回答早于首帧。原 select/Begin 回执确认
旧 view 清理，不再依赖原记录中没有的 onDetach 通知。旧 latest/null 及 onDetach
假设各有先失败反例；原两场真实失败不改写，本次不重新运行网页业务。
修正后的 runner/fixture 定向测试31项全部通过；两份原运行的离线回执与状态
检查、语法及 diff 检查通过。原成功回执的 active view、preparing human、
清理状态和退役序号均逐项核对，没有用新协议假设替换原证据。

独立 controller 诊断的四项测试实际 exit 1：两个对照通过，两个目标行为失败。
同文档 updated 可取消异步捕获中的弹窗但不独自清空租约；准备时先固定空默认
context 身份、随后默认 context 到达，可导致整租约撤权。均保留一次原输入与
原清理，无生产修改。原导航日志缺内部 ACK/error，不能声称已确定唯一原因。
诊断报告 SHA256：`89167fee3a516c8c6ec7d732b265962d539e4e66f39420980382cc41d5cd9de2`。

源码已提交并推送 `ff1d9d348bc630f0516e27e33f8b10383de44cc9`，新包发布为
[preview-20261019-ff1d9d3](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-ff1d9d3)。
完整包/扩展/Skill为104/77/7文件；411份生产构建输入、77份未加key扩展与原已测
快照相同。发布EXE单独重建，离线CLI/MCP30工具、8,974项独立包审计、四资产
上传回下载及108份本地副本核对通过。稳定扩展ID、安装与覆盖升级说明保留。
完整包10,473,233字节，SHA256：`08706fa6f951d4813319b00444b39fa97c6f55d6b031eb07d1651ed95a74c542`。
包审计报告SHA256：`0407db5447a82398a3a4a106830362286542fa3edfbdd330f624d86000cb3444`。
本次打包请求完成，产品行为与ecbda21相同，没有新增真实浏览器验收或PR。

## 两阶段接管与ecbda21预览交付

用户再次要求新包。本轮源码将human Begin改为在原Pause、风险记录、attachment
及listener建立后返回preparing handle；原Begin响应以前，早到状态不开放End或回答。
generation 0仅End，正generation还须原文档证明和精确pendingDialog，输入始终等
active与真实首帧。新增原生文档事件门禁，Opening固定原frame/loader/default
context后核浏览器侧身份；不借弹窗中的新renderer查询或旧URL补授权。

回答旁路旧输入/渲染清理，后继画面仍等旧清理；End先取消原弹窗再join原证明。
准备预算、元数据发送前Opening竞态和退役证明迟到失败均补了先红后绿反例，
没有替换实际Promise、冒充Closed或释放回执。当前内部构建411份生产输入、77份
扩展文件，2758项Node全部通过；本轮Go全包/vet通过，最终构建复用未变Go/UI输入
的原检查。此前旧Begin测试假定active的失败保留。

同一构建的`mod-O0QjZc`四布局回归五步实际exit 0，completed与featurePassed
均为true；root/same/nested/oopif四个原prompt均answered，正式Stop通过且报告无
cleanupErrors。这是固定Windows CfT与原fixture范围的新结果，不证明公司Edge
或完整能力对齐，也不把旧构建验收自动归于新源码。原事件与回执独审422项通过；
生命周期独审另行记录。

正式`mrd-BfhoHa`与`mrd-yWnzNj`均实际exit 1，featurePassed false。前者确有
preparing/正generation/null viewport及pendingDialog，后继首帧先于runner断言到达，
未发回答；后者有新loader/default context和原Opening，约19ms后Closed=false，
没有pendingDialog、回答命令或POST，不能唯一归因；等待导航期弹窗界面状态超时。
两阶段实现不等于这两边界验收通过。
原失败、原构建和已有发布记录保留；旧四布局通过结果不自动归于本次源码。
本次源码提交`ecbda2114b8a83da86b46102f36a1fb00ab6b88a`已推到fork，并发布为
[preview-20261019-ecbda21](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-ecbda21)。
104/77/7文件、离线CLI/MCP30工具、8,926项独立制品检查、四资产回下载与108个
本地副本校验通过。生命周期独审45项、20张PNG及30个原进程退出通过；两失败
运行的清理也另行确认，没有据此修改其功能失败结论。
打包脚本变量重名的初次失败与原1,243条成功命令保留，续跑重新核对411份冻结
源码并使用独立日志。发布EXE从干净提交重建，77份未加key扩展匹配原实测制品。
完整包SHA256：`b4b761cfe1d1c724d60b0c5bacb59b22ac3e8721e4bfbab580ed848ea4c0f42b`。
本次打包请求已完成；首帧、导航弹窗和完整能力对齐仍未完成，未提PR。

## 已发布的5e830dc重打包（历史）

用户再次要求新包，已从干净提交 `5e830dc8d8c5da466cb6c48c15358008cfe74568` 发布 [preview-20261019-5e830dc](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261019-5e830dc)。
产品功能与上一包e3fee2a相同；其后提交只有文档及诊断，本轮首帧/导航弹窗开发仍未验收，全部未提交改动留在工作区、未入包。
407份生产输入匹配已测快照和Git对象，76份扩展文件匹配已测制品；完整包/扩展/Skill为103/76/7文件。
发布EXE单独重建，离线CLI/MCP30工具、8434项独立包检查、四资产回下载和107本地文件副本核对通过。
未为重打包重跑网页业务；普通公司Edge和完整能力对齐仍开放。

完整包SHA256：`fa7b5076e1549940963bd2d24328bb861d5ce9a6605d01eb8bd70872a81a651e`。未提PR。

此前交付已发布为 [preview-20261018-e3fee2a](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-e3fee2a)，源提交 `e3fee2a35cb4b4d0e52b3c84e95314c867c7b33b`。
完整包/扩展/Skill为103/76/7文件，407份源码输入匹配冻结实测快照及Git对象，76个未加key扩展文件字节相同。
发布EXE单独重建，离线CLI/MCP30工具、8417项独立包审计、四资产回下载及107本地文件副本核对通过。
完整包SHA256：`ab4e6107ec9b7f69e602fba0f499ac2adce00d3b3805aee9d56b4677da84dbe1`。未为打包重跑网页业务，未提PR。
覆盖升级仍先结束旧会话，覆盖文件后重跑安装脚本并重新加载扩展及更新Skill。普通公司Edge和完整能力对齐仍待完成。

继续推进 Browser Use 能力对齐，不提PR。首轮用户要求再打新包，在已验证实现提交后单独构建，发布记录保留如下。原版本只接受主frame弹窗，同源子页的原生prompt会立即取消并结束接管。

新增独立默认执行上下文登记模块。原附件在Page/Runtime enable确认后，固定原frame、loader、context uniqueId和祖先实际源；URL生成的securityOrigin不授予权限。上下文销毁或替换撤销原资格，退役身份有硬上限，不能被重复事件复活。同源子页复用原typed回答、输入预算和清理责任。

Closed现在要求原frame身份。没有确认原关闭又收到Opening时，禁止尚未发送的回答和取消，保留已发送的实际Promise，等待原target销毁证明。独审发现最后一次清理检查之后仍可能收到歧义事件的P1；原反例先失败，修复后在焦点清理与detach前后复核，detach ACK不替代在途响应结算。

增加独立四布局fixture/runner。每页由公开SDK正式交付，只经一次真实查看器点击，原emitter提交唯一POST。首轮基线失败来自测试误收上一lease清理回执，已由先红后绿反例修为等待完整原租约。后续基线诊断完成，主页面答复、同源/嵌套取消均复现。

新源码真实五步验收通过：主/同源/两层嵌套prompt回答Unicode，跨站OOPIF原生弹窗明确取消；四个原文档和POST保留，正常Stop和资源清理确认。OOPIF根树缺远程节点不等于页面不存在，旧SDK子session已detach不能用于人工接管授权。继承源、动态iframe、跨域、首帧/导航和beforeunload仍待补齐，不声称全能力持平。

最终2576项Node测试通过、无跳过，Go源码未变沿用原全包/vet。独审两个终结反例及289项聚焦通过；fixture/helper22项通过。运行绑定405生产输入、75扩展文件和882份验收源码。原失败及冻结产物均保留，详见[子页面计划](../../exec-plans/active/2026-10-18-human-frame-dialogs.md)。

事后独立事件审计386项通过；构建及验收输入匹配、19张已保存PNG完整解码、31个原进程身份和私有资源退出均独立确认。事件投影并未记录所有导航事件或原始enable命令ACK，不扩展为未记录事件绝对没有发生的证明。

截图确认同源和嵌套弹窗在查看器中展示。结束截图属于明确标注的保留画面；成功清理后残留“正在释放”的文字为后续UI状态修正项，不用截图替代原回执。

## 用户要求的新包

用户最新要求的新包已从干净提交 `6a3bee5b1c05c154bce945fa35abce2fbe3422c2` 发布为 [preview-20261018-6a3bee5](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-6a3bee5)。
本包新增已验收的稳定同源及两层嵌套页面人工prompt；完整包/扩展/Skill为102/75/7文件。
405份生产输入逐项匹配已测快照及提交，重建扩展75文件与已测制品字节相同；
发布EXE单独重建，离线CLI/MCP30工具、独立制品审计及四资产上传回下载校验通过。
发布时未重跑网页业务，原验收属于冻结内部构建。OOPIF、继承/动态子页、首帧导航、
公司Edge及完整能力对齐仍开放；成功End后的陈旧释放提示已在包内披露。

安装仍为完整解压、运行install-edge.cmd或install-chrome.cmd、加载extension和复制完整Skill。
覆盖升级须先结束旧Agent/MCP与managed会话，重新运行安装脚本并重载扩展。
仅在独立clone恢复经Git对象证明的已测换行字节，不修改开发工作区；原失败证据保留。
完整包SHA256：`70a52a05d10d66388893e7019239e1922e0ab7aae01780e47f1259a1743ad72b`。未提PR。

## 跨站 OOPIF 与查看器提示续轮

用户再次明确要求新包。本轮先完成当前人工附件拥有的远程文档图：有界递归 flat
sessions、每层实际默认 context/origin、两轮完整原生树和同一图谱 revision。
原 siteProof 同时固定策略与导航版本，回答前逐层检查实际源。父文档替换不允许
旧远程 session 用迟到 context 重新授权，原实际 setup 和 detach 清理责任仍保留。

独立反例发现原输入可能在等待风险记录后越过已失效的远程默认 context。
新增与弹窗权限分开的身份 fence，准备读取前固定原集合，准备尾和最终发送复核；
两个反例先失败后通过，空弹窗快照的第三反例亦通过。普通隔离世界事件不撤销
原输入身份。查看器释放提示按原租约、提示类型和 UI epoch 管理，匹配清理状态
先到也能清除进度；未知输入错误、新错误和后继租约不会被旧响应抹掉。新增18项
回归、完整84项 UI 测试通过。

新内部构建407份生产输入、76个扩展文件；2656项 Node 测试无失败或跳过，
本轮 Go 主模块全包测试/vet 和构建均实际 exit 0。固定 Windows CfT 的
`mod-BENPnK` 五步实际通过，root/same/nested/oopif 四个原 prompt 均回答 Unicode，
每个原文档一次点击与唯一 POST。四次 End 原清理及界面进度清除、正式 Stop 通过；
事件417项及生命周期40项独审通过，20张保存PNG均解码，29个原进程身份与私有资源退出确认。
首次生命周期审计脚本误用Stop wire状态的失败已保留，修正依据原协议，未改浏览器结果。

新包现已发布为 [preview-20261018-e3fee2a](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-e3fee2a)。弹窗卡片没有单独显示子站来源；继承/动态及
复杂 iframe、子页 alert/confirm、接管前/首帧/导航弹窗、beforeunload、公司 Edge
和完整 Browser Use 能力对齐仍未全部覆盖，不以这四个通过案例替代完整验收。

## 首帧与导航准备期诊断

新增独立fixture、runner和23项纯测试，生产实现与已发布包未改动。原生请求、
实际发送及ACK分别记录；附着确认前事件不给新附件权限，取消在实际发送前
重检原对象。两个独立所有权反例先红后绿，原失败保留。事件截断不能算完成，
观察期限不丢弃原Promise，失败仍执行正式Stop。

两个不同原场景实际exit 0。导航时画面stop/start在弹窗期间确认，五个renderer
元数据探针只在原取消/Closed后确认；该场原pointer-up已提前确认。附着前场景
没有取得原Opening，未尝试取消，不能据此断言弹窗存在或不存在。两场共29个
已观察原进程身份与私有资源退出，原输入、文档、唯一POST和截图证据各自保留。
这些是原生诊断，featurePassed始终false，不替代正式viewer验收。

该诊断轮次计划先验证原事件能否提供完整文档证明，不能假定弹窗中可以新读renderer
元数据。独立controller、bridge、Go及UI反例和设计均保留；后续两阶段实现及未通过
的正式边界验收见本页开头，不把旧诊断改写为功能通过。
详见[诊断范围与序列](../../references/managed-modal-readiness-diagnostic.md)。
