# Original page download delivery

## Goal and current evidence

继续完整Browser Use对齐目标，补P10/P15中“网页生成文件后，Agent取得这次
原文件用于分析”的完整任务。上一片三SDK连接身份已实现并推送`19a39ef`，
Windows真实完整125/125、Windows/Linux SDK及原生IPC通过，属于progress。
旧preview保持不变，不创建PR、不移动系统鼠标或选中用户tab，不增加Pi适配。

现有`expectDownload`能确认Page GUID、原tab/frame/session/epoch并等待匹配，
`result()`在原始begin事件通过归属校验后返回，不代表文件已下载完成；
但`downloadPath`对Page GUID明确返回`OBU_DOWNLOAD_PATH_UNAVAILABLE`。可靠
路径仅来自本项目主动`chrome.downloads.download`返回的numeric ID；新GET
不能替代POST报表、一次性响应或立即撤销的Blob。现有浏览器测试已核原始
文件，但其私有下载目录差分只是验收手段，不是公开产品能力。

`chrome.downloads`没有Page GUID或source tab字段；既有实验已经证明普通
extension debugger拒绝Browser下载配置。冻结CRX中的对应分支只返回
resolved Promise，synthetic `/tmp/downloads`也不是原生路径证据。History
只读SQLite已有锁失败，不能再次把猜测、拷贝变化数据库或绕过锁当作方案。

历史Codex扩展1.1.4快照的`handleDownloadCreated`在浏览器控制活跃时向外
发送全局numeric ID、filename、URL；此层没有任务tab绑定。它是历史线索，
不是当前Codex能力或跨任务归属证明，更不是复制全局下载可见性的理由。
本计划建立时尚未做同场Codex验证；本轮root单次对照见下文，完整文件任务
验收仍未完成，不能以旧源码或公开工具表面替代真实输出。

## Candidate native mechanisms, not implemented claims

正式[Browser CDP协议](https://chromedevtools.github.io/devtools-protocol/tot/Browser/)
的downloadProgress包含GUID和可选filePath；Chromium从同一个DownloadItem
产生二者。真正browser-level连接可在default行为下启用events，或在专用
context使用allowAndName按GUID命名。前者也修改context下载配置，不能
覆盖其他连接的设置；后者改变保存位置/命名/提示，不能默默用于用户profile。
filePath缺失必须失败，不能补猜路径。当前extension transport没有此域。

官方[Chrome当前会话连接说明](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
提供M144+显式启用和逐连接授权的候选入口，存在授权UI/自动化横幅，其他
品牌不能外推。另一入口是host创建的独立受控profile，登录状态不同。
这些是待验证连接方式，不把改变运行模式当作既有扩展能力已经补齐。

Fetch原响应捕获可另行提供HTTP正文能力，但没有GUID归属且不完整覆盖Blob，
不能替代本片任务。网页重发GET、按URL/时间/文件名猜匹配都不接受。

## Work and acceptance

- [x] 核当前Codex同组文件流程：原POST、Blob、返回路径/内容及后续读取，
  记录实际支持与限制，区分IAB和扩展，不以旧源码或描述代替实测。
- [x] 以独立合成页面验证真正browser-level传输，固定实际browser身份，
  只读记录原Page/Browser事件；任何下载配置变化限于明确受控context。
  若当前profile入口需人机授权，先完成可审查的独立实现再说明真实需求。
- [ ] 正式入口保留ready→trigger→collect，原POST只允许一次；替代GET
  返回不同内容并计错。Blob触发后立即revoke，原GUID必须对应真实原字节。
- [ ] root、动态OOPIF、两个owner同URL/同filename并发及无关下载对照；
  依据原GUID/原生来源绑定，不泄露其他任务或用户文件。
- [ ] 在实际连接/控制范围内取得单一文件句柄，返回可用产物或可靠路径，
  字节数/SHA与原响应或Blob逐字节相同，Agent能继续分析这个原文件。
- [ ] 验证连接丢失、scope撤销、危险/失败下载、文件消失、取消与清理。
  继承上一片连接终态，不为恢复重新点击或重发请求。
- [ ] 验证任务tab后台、系统鼠标不动、连续focus记录；必要授权UI单列，
  不冒称原生连接无打扰。不得放宽旧验收或替换旧发布ZIP。
- [ ] 通过正式CLI/MCP/SDK的同组任务、来源与原字节独立审计后更新文档，
  再提交推送。若某入口未完成，明确保留，不能以窄模式成功代替完整目标。

## Relevant paths

- `apps/chrome-extension/background.js`：owned Page GUID、downloadPath与事件来源。
- `apps/chrome-extension/browser-downloads.js`：明确新下载的numeric ID、路径和取消。
- `internal/host/`、`internal/transport/`：实际浏览器连接的可能扩展边界。
- `scripts/browser-integration/download-waits-fixture.mjs`：已有原始响应、文件与等待验收。
- `docs/references/file-transfers.md`：现有完成语义及已验证限制。
- `docs/product-specs/browser-use-parity.md`：完整P01–P15矩阵。

后台新页ready/跟进、其他平台及guard丢失恢复继续开放；本片不改写整体
成功条件，也不把单独browser-level连接方案当作已解决所有浏览器的安装。

## 2026-10-12: original bytes and native path feasibility

前一问答仅给公司电脑安装步骤，没有能力验收进展。本轮完成可复用fixture、
原生观察器和真实对照，改变下一步实现依据，属于progress。生产扩展/host/
SDK未修改，公开`downloadPath`仍返回原限制；完整计划保持active。

当前Codex公开工具`waitForEvent('download')`后调用`path()`，单次root
IAB POST、IAB立即revoke Blob、Edge extension POST均返回可读路径，三个
原文件152/152/153B、nonce及SHA一致。Edge Blob一次可信点击后等待10秒
超时；未重试、未猜路径，不能断言浏览器未下载。两POST各一次、无替代GET。
此对照没有并发、OOPIF、native GUID或focus证据，不外推完整能力/隔离。

本项目真实`run-uK4EVu` default与`run-0CgnzY` allowAndName均2/2、actual
exit0。每次3 owner×root/OOPIF/dynamic-OOPIF×POST/Blob=18原文件，分别
3120/3210B。SDK begin GUID、原Page source/frame、同browser Browser GUID
逐一绑定；真正completed事件的filePath直接打开单一句柄读原字节并分析nonce。
三owner同URL/filename并发、通知和外国GUID请求隔离通过；第三owner是
无关任务，尚非未owned用户下载。default保留浏览器常规文件名，allowAndName
使用GUID文件名；两种路径都从事件读取，没有目录差分/拼名查询/重新GET。

Browser连接核实际子进程profile、DevToolsActivePort端口/path、同root内
extension worker与任务targets，完整保存原wire命令/ACK/events。两次
default/eventsEnabled:false复位ACK及socket close已确认。连续focus分别
7817/7494ms，均零activation/focus事件、零新增豁免；启动/拆除不在覆盖内。
fixture/observer合计24/24单测、零skip/cancel；生产构建50源与既有host匹配。
这两轮是独立设置的对照，不是对超时触发重跑。旧preview三ZIP保持不变。

下一步将已证明的原生通路接入正式host/extension权限与连接边界，完成
capability协商、原Page记录先授权、同连接GUID路径交付以及取消/失效/未知
ACK。没有真实Browser root通路的普通扩展继续明确不可用；不能只实现新
managed mode就宣称现有安装已对齐。完整证据与范围见
[原文件交付](../../references/original-page-download-delivery.md)。

## Next product integration sequence

1. `internal/host/relay.go`目前仅转发、无WebSocket客户端。新增明确绑定
   Browser连接的小模块；指定endpoint，不扫描端口/自动选择最近profile。
   先实测native port与原extension worker的随机nonce双通路挑战，将worker
   boot、extension instance与Browser连接generation绑定，不能只认extension
   ID/URL。host自建profile的PID/path证明作为另一路，不替代已有浏览器支持。
2. 新增按native port隔离的私有请求/响应分流。现有`obu.native.*`接收器
   对未知消息的处理不同，不能借SDK pending ID偷渡。身份及真实events ACK
   成功后才在`getInfo`披露能力；arm等待此ready，断连立刻撤销能力和缓存。
3. 保留`handleOwnedDownload`已有Page记录与scope授权，从该port私有claim
   发送GUID/frame/root target/attachment/原scope。host仅按同连接generation
   和精确GUID合流，处理事件/claim先后到达的有界缓存；不广播全局下载。
4. `downloadPath`完成原授权后请求host，等待原completed后用其filePath
   打开普通可读文件，返回前再核scope/record/deadline。随后做cancel、scope
   失效、文件消失、未知ACK和三SDK/CLI/MCP真实验收，不重触发或重新GET。

现有用户root入口必须显式授权配置且排他使用：default也设置context下载
行为，CDP没有读取/恢复其他控制端旧override的接口。没有授权原生通路的
普通安装保持明确不可用；本轮不修改用户profile设置、不新增授权询问。

## Production integration

安装指导回合没有完成能力开发；恢复时工作区有未编译的host/CLI/Browser
草稿，必须复核并补验证，不能混入已发布的preview。三模块分工：原生Browser
连接及GUID记录、Host私有分流及显式CLI、每个Native Port独立的扩展客户端。
root负责现有Page记录授权、构建清单、真实浏览器验收和文档整合。

冻结入口为`bind-browser --socket <exact endpoint> --cdp-url <literal loopback
Browser websocket> --exclusive`，不发现或扫描浏览器。Host先通过原Native
Port发随机nonce，扩展发布`globalThis.__obuNativeDownloadBinding`，原生
Browser读取同worker的nonce/extension/instance/boot/port全身份后才启用事件。
已提交连接属于Relay，CLI退出不撤销；未提交时CLI EOF取消。无自动重连。

私有方法统一`obu.native.pageDownloads`，无外层RPC ID，params包含version=1
和type challenge/response/ready/request/reply；ready和request/reply绑定nonce
及generation。操作claim/path/cancel/release只通过原Port，SDK不能注入。claim
包含GUID、frame、rootTarget、原session/turn/epoch/tab和每条Page记录唯一claimId。
wait在ready时保存原Port及generation，Page归属校验后才claim；path/cancel返回
前再次核原scope、记录、连接和期限。撤销立即删除本地记录，再释放原host claim。
路径只接受原completed事件filePath并验证普通可读文件，不按名称猜测或重新GET。

正式实现已完成JS原文件路径/取消的受控浏览器验收。`TYsHFS`2/2验证18份
3120B原POST/Blob、3owner、root/OOPIF/dynamic OOPIF及两held-download
生命周期。其后审查发现并修复Host迟到ready ACK越过期限、撤销tombstone
被128事件缓存驱逐两问题；4096 GUID独立ledger保留整个generation，满额
终结绑定。Browser ACK另做实际期限检查；只有身份核实且进入配置阶段才能
清理download override，preidentity迟到ACK零配置写入。

最终57生产输入/9bin重新构建，`M8DwSY`2/2 actualexit0复验同组正式路径。
原始`51yhd4`仅因生命周期错误文案断言不匹配失败，保留原日志；没有把失败
当成功、没有重放原下载。最终Node1837、JS142、Python110、typecheck与vet
通过；Windows全Go607pass/26平台skip，native包Windows69/Linux70零skip。
普通未绑定完整套件`bi7ASp`125/125通过，其源码checkpoint早于上述bound
修复；224026ms focus沿用12activation/4controlfocus允许项，新增零豁免。

安装指导回合自身未产生能力进展，本轮重新核工作区与源码冻结、完成最终
构建/真实浏览器/独立审查，属于progress。当前只证明显式排他绑定的JS路线，
没有收窄原计划成功条件。下一步先验Python/Go/CLI/MCP同原文件任务、未owned
用户下载隔离、真实root断线和失败下载，再解决普通现有profile的安装/授权
体验。所有未取得的范围仍保持开放，旧preview三ZIP不替换。

## Five-entry positive acceptance

前轮完成正式绑定、修复和实机验收并推送`6300413`，属于progress；本轮从
干净工作区继续。保持原JS三owner专项与未绑定125基线不变，新增独立
`five-entry`模式：JS/CLI/MCP/Python/Go各一个owner，三布局×POST/Blob共30
原文件，沿用同URL/同名fixture、原Page来源与完整字节判定。CLI/MCP必须
走真实子进程；Python/Go必须用正式typed ready/result/path且固定原epoch。
每个caller保留scope、逐阶段时间、原输出/错误、精确文件与实际进程close。
父进程再独立核文件字节、nonce与服务端原响应；不能用JS替另四入口操作。

并行研究普通安装的精确原文件路径来源，只读官方接口/Chromium实现与
现有参考代码。没有实际profile身份和原GUID证据，不允许以全局下载队列、
URL/文件名/时间相似代替归属。既有用户profile和未知下载数据本轮不读取。

最近的安装问答不计能力开发进展；本轮重新核工作树，完成正式五入口原文件
正例及最终host完整回归，属于progress。首次`2O6wkV`2/2得到30文件/5200B，
但没有保证全部waiter先ready，因此只保留为交付正例，不称并发验收。
新增6组all-ready barrier后，审查修复Python复制位置、动态Add后原预算、
typed/MCP在gate期间实际退出与CLI/MCP每次动作剩余预算；旧源码确定性失败
保留。`EKpLO0`2/2先通过门禁，随后预算修复后最终`Fb9uuB`2/2 actualexit0。
30份原文件/5200B、15一次性POST和15revoke Blob、原Page/GUID/字节/通知均核；
14000ms零activation/focus与零豁免。foreign path/cancel拒绝和两held生命周期
仍由parent JS检查，不冒充五入口全部负例，也没有未owned用户下载对照。

最终Node脚手架673/673、Python helper8/8、Go helper15/15（含子测试）全过，
无skip。58 Go/module输入与10bin冻结；生产扩展/Host/SDK相对`6300413`未变。
新host普通未绑定完整`U32iKd`125/125 actualexit0，case名称/顺序不变；
238890ms只含原12activation/4controlpopup focus允许项。Host重编译的VCS
metadata与M8不同，不能称二进制逐字节相同，57既有构建输入相同另行核验。
已发布三ZIP未替换。当前只完成该正例片段；原计划其余生命周期、授权、平台
和完整P01–P15继续active。

## Next: current-session connection

官方实现提供了普通现有profile的候选路径：Chrome144+和Edge均可由用户在
inspect页启用remote debugging，再从指定user-data根目录的`DevToolsActivePort`
直接连接Browser WebSocket。Chrome approval-only模式的HTTP discovery可返回
404，不能先用`/json/version`探活来判不可用。来源与区别见
[原文件交付](../../references/original-page-download-delivery.md#existing-profile-installation-research)。

下一生产切片可增加显式auto-connect发现入口，仍要求exact Native Host
socket与exclusive，不以目录名证明profile身份：端口文件只负责定位，实际
worker nonce/instance/boot/port challenge继续决定是否允许配置下载。只读
用户选定根目录的有界两行文件，不扫描端口、History或自动换profile。
CLI的总deadline应包含文件读取与授权等待；当前Manager把整个Dial截为10秒，
需要拆分授权握手总预算与后续每条CDP命令10秒上限，不能仅把CLI提示改成60秒。

本片正在实现该入口并补真实原生HTTP/IPC测试。Manager握手已改用原caller
deadline（最大120秒，无deadline仍10秒），每条CDP继续最多10秒；旧源码对
11秒真实HTTP Upgrade等待确实失败，新实现通过。CLI发现与真实五入口验收
继续推进，不能以单测代表普通浏览器授权已完成。

原生授权窗口由Chromium自身激活，computer-use规则禁止代用户操作权限
请求。因此正常启动、用户手动批准的验收单独保留；不写pref或改工具绕过。
先用现有隔离launch-flag Chromium验证实际端口文件→生产CLI→原worker
挑战→原文件交付，明确不是无调试启动参数的授权UI证明。真实拒绝/批准
超时、错误profile、多profile同ID worker、关闭授权及实际断连仍需补验。
授权与批准后后台工作必须分段记录；完整P01–P15和其余负例保持开放。

## Current-session discovery implementation and acceptance

前一目标轮已产生生产实现及真实HTTP反例，安装问答本身只交付安装说明；
本轮重新核工作区、完成CLI、集成和真实浏览器验证，属于progress。显式
`--auto-connect --browser chrome|edge`可读默认或指定绝对user-data根目录，
普通文件/4096B/两行/端口/路径校验后仍走原nonce挑战；无探活HTTP、端口
扫描、History或自动替换profile。Windows UNC/device拒绝；文件读取总预算
到期即拒绝迟到结果，最多一个尚未退出的reader，不冒称内核读可强制取消。

自动默认60秒、手动10秒、显式最大120秒，原总期限覆盖发现/IPC/授权/身份。
真实11秒握手旧实现10秒失败、新实现成功，每条CDP仍10秒；403、取消、
迟到握手、原总预算不续期和未知结果终态经原生peer测试。原1秒detach/
retirement清理预算保留，不借它继续setup。

最终隔离Chromium `h9Udpf`2/2 actualexit0：生产CLI仅获root未获URL，真实
端口文件发现、原Native Port/worker挑战、capability前后响应和generation均
保留；五入口30原文件/5200B、6组all-ready、原字节/来源/通知及JS生命周期
通过，12853ms零activation/focus/豁免。`YRvEbg`是未保存前后capability的
此前通过版；手动URL `ZwGUxs`2/2、18文件/3120B、9381ms零focus/activation。
拆除先关browser导致host记录原连接已断的shutdown警告，保留且不宣称reset
ACK已核。任务回收、实际host exit0和拆除界限分别记录。

Windows全Go654pass/27skip（另8无测试package），Node68/68；CLI287pass/
24skip，最终binding21pass/1权限skip，WSL实际Unix socket/FIFO/symlink23/23。
Linux/macOS测试二进制交叉编译及vet通过，61源/10bin冻结。此轮未重跑无绑定
125基线；没有修改扩展、SDK或旧preview三ZIP。

本片验证launch-flag隔离Chromium的生产发现，不等于正常启动的人工授权、
Edge实际授权或默认日常profile安装已完成。下一步继续原计划的未owned用户
下载、实际Browser断连/失败文件和多profile授权；具体契约及范围见
[当前会话连接](../../references/current-session-connection.md)。完整目标保持active。
