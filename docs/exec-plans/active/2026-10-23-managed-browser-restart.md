# Managed 浏览器进程重启后的任务接续

## 目标与基线

上一轮为 progress：已提交两轮正式研究验收，发布并核验用户要求的新包
`preview-20261023-9163ec8`。用户随后再次要求新包，已从 `1e1881d` 独立构建并
发布 `preview-20261023-1e1881d`，独审和回下载通过。交付记录提交为 `c904d54`；
恢复功能尚未提交，不纳入该包。完整目标继续 active，只推用户 fork，不提 PR。

P13 要求旧轮次和句柄失效、确切清理及不静默重试副作用。现有 managed Recover
只在原 Browser 存活时替换 Native/worker；Browser 退出会结束 Session 和 supervisor。
独立会话文档将跨浏览器进程接续列为开放项。既有 Codex 比较没有提供杀浏览器后
恢复的同题证据，因此不能把新实现自行称作 Codex 同等能力。

## 设计约束

- 新浏览器必须是同一专用 profile 下的新 run；旧 tab/target/document、SDK、turn、
  viewer 链接和人工输入租约全部失效，不伪装成原 DOM 或恢复旧授权。
- 浏览器原生会话恢复的 GET/POST、历史与延迟加载行为先由原生证据验证，再决定
  是否适合作为显式接续入口。不能凭 URL 或同名分组恢复旧页面权限。
- 未知提交和输入不自动重放。站点持久登录、存储与草稿同消失的内存状态分开记录。
- 静态截图/文本保存不算活页任务恢复。离线归档不是 P13 明文要求；只有确有用户
  价值且不能由现有能力覆盖时才引入独立持久结果模块。
- root 独占任务所属 headless 浏览器启动，不使用个人 profile、系统鼠标/键盘或剪贴板。
  普通公司 Edge 人工授权按用户要求继续延期。

## 执行与验收

1. 并行核查生命周期、结果交付与原 P13 证据，确定最小但完整的正式使用链路。
2. 保存原生恢复试验的首次结果及失败；该试验不替代正式 managed 验收。
3. 实现显式接续接口和必要持久状态；跨进程原身份拒绝、并发 profile 锁、损坏/缺失
   记录、未知副作用与失败资源归属须有实质性验证。
4. 从冻结生产源码构建后，在正式 CLI/SDK/查看器完成原任务、实际进程退出、新 run、
   新身份认领及独立后续业务；核原提交次数、结果可用性和两代进程/资源实际清理。
5. 适用检查、独立审阅、文档/history 和推送完成后关闭本计划；完整 P13/P15 与
   多平台等未完成要求保持开放，不以本片代替整体目标。

## 当前进度

2026-10-23 新续轮：上一轮为 progress，完成正常恢复实现提交 `b71be03`、
新包真实交付及记录提交 `c1f0b44`。随后用户再次明确要求新包，本轮先收口
验收脚手架并刷新交付；生产能力与 `b71be03` 相同，完整目标保持 active。
新增独立 `crash-authenticated` 用例：正式第 0 代通过网页一次合成登录，服务器
设置场景限定的持久 HttpOnly cookie，正常 Stop；A 是新 Browser，先由原服务器
确认同一认证仍有效，再完成原报告。实际 Browser.crash 后，B 原生恢复须保留
已有认证和原服务器成果，旧权限拒绝、明确 Resume、新 SDK/claim、独立后续提交、
真实查看器交付及各代资源清理全部完成才算该用例通过。

已有登录、A 刚写入的浏览器 draft cookie、localStorage 和内存草稿分别记录。
新增用例不修改 `crash` / `crash-established` 原断言或原失败；不增加自动登录、
cookie 备份/回写、页面重载或业务重放。该用例只验真实网站接续的一类前提，
不将任意状态崩溃耐久性改成已实现，也不替代 P15 同材料正式入口比较。
生产代码暂不变，复用 `hpfufae_` 的确切 480 份已测输入与原产物；脚手架单独
冻结及测试，不声称已发布 EXE 重跑网页。root 独占隔离 headless 浏览器启动，
运行期间生产和全部 integration 输入禁止修改。

当前交付状态（2026-10-23）：用户再次要求新包，本轮先交付正常关闭恢复和配套
启动/复制修复。Go/CLI 与 JS 两份独立生产审查未发现阻断试用发布的问题，当前
生产源码与 `mbr-build-hpfufae_` 480 份输入逐字节一致。新包从提交后的干净源码
重建并核验，打包不再启动浏览器。两种 crash 原失败继续保留，本计划保持 active，
不将完整崩溃接续或整体能力目标标为完成。

Cookie 只读调查：原 fixture 明确 Max-Age=86400，A 原请求携带 cookie；保存到
发起崩溃约 8.2 秒。保留 Cookies 原字节在内存 SQLite 中解析总行数为 0，原文件
与结果摘要前后不变。固定 Chromium 原生写入使用 30 秒/512 操作提交窗口，正常
Close 会提交，支持异步落盘窗口的解释；不以此修订旧失败断言。下一步仍应检验
已有持久登录下原服务器成果的崩溃接续，并与本轮新写 cookie、localStorage、内存
状态分别报告，不扩大为任意网站状态备份，也不自动重放未知业务。

以下记录按发生顺序保留，各次“正在/未发布”描述仅指当时状态。

- 已核查 Session 退出与 Recover 限制，选择显式 `managed run --restore`，
  在同一专用 profile 中创建新 run；默认启动与 setup 行为保持原样。
- Go/CLI 最小实现和定向测试完成；冻结构建 `mbr-build-lkibennt` 的完整
  Go test/vet、Node、主程序及扩展构建实际退出 0，生产输入未在构建中改变。
- 原生探针 `run-KtHhKj` 保留 exit 1：GET、PRG 与可缓存 POST 页在新进程中
  读取到原回执，三笔原 POST 各保持一次；no-store 页未按原 URL 匹配，
  尚无错误页 DOM 证据。直接 CDP 的原页均报告可见，不能证明后台页面恢复。
  两代原浏览器退出，专用 profile 查无剩余进程；此探针不算正式验收通过。
- 独立业务 fixture 的 11 项测试及最终 runner/support/recorder 的31项检查通过。
  首轮正式默认启动对照 `mbr-d-rQuJ9H` 实际退出1：原任务完成三笔 POST、
  四份真实查看器画面和正常 Stop；同一 profile 的第二代默认启动 Native 超时。
  原两代 Browser 均退出、Job 为0，补充检查原 profile 无进程，第二代注册表
  两视图均不存在。原失败及原冻结源码保留，不能算作默认行为验收通过。
- 第二代日志反复请求第一代 Native host；磁盘配置和 profile 扩展路径均已是
  第二代。正在核查扩展 service worker 对同版本模块的复用，修复后再运行。
  同时补强完整 HTTP 账本、原/新 target、最终交付库存和崩溃清理断言。
  正常退出恢复和崩溃恢复尚未执行。
- 仅更换受管扩展 manifest version 的候选经完整 Go test/vet、Node 和构建通过，
  冻结产物为 `mbr-build-hx2r3z3w`。补强后的41项脚手架检查通过，但正式默认
  对照 `mbr-d-mV2jce` 实际退出1：版本从 `10592.29324.16260.32979` 自然增加到
  `36760.3914.47335.13730`，第二代仍请求第一代 Native host 并启动超时。
  两代 Browser 正常关闭、各自 Job 为0、清理无错误；保留全部原失败证据。
- 精确 Chromium revision 的源码核查表明：manifest version 变化触发注册，
  同脚本 URL 的已有 service worker 注册仍可能直接返回，未刷新模块图。
  正在给每轮 staging 新增唯一 module 入口，并让下载绑定、人工控制和后台
  文档重连保留精确入口校验；完整原生 nonce/Port/worker 身份挑战不变。
  普通安装的入口保持原样，恢复同一 run 的 worker 也保持该 run 的入口。
  此候选尚未通过真实浏览器验收，不进入已发布包。
- 唯一入口候选的完整构建 `mbr-build-v1gdybj9` 已实际退出0：Go全仓16包
  通过、14包无测试，vet通过；123个扩展/查看器/构建脚本测试文件共3,379项
  Node检查通过。独审确认479份输入、产物及原始命令日志摘要相符；SDK的13份
  源码和dist原字节不变，明确复用此前构建。另有99项Go定向检查和43项重启
  脚手架检查通过，不将其混称为上述完整Node范围。真实验收等待脚手架冻结。
- 同构建正式默认对照 `mbr-d-6PqfNw` 已实际退出0：第二代自然降版本仍通过
  新 native 绑定，两次当前库存均只有 blank，三笔原提交未变；两代资源退出。
  正常关闭恢复 `mbr-n-dY3rI5` 也实际退出0：GET工作页与PRG报告有新文档/target，
  持久草稿和cookie保留、内存草稿消失；显式Resume、新SDK/claim、原回执读取、
  一笔独立后续提交、两页重新交付和正式Stop通过。root目视两张恢复后查看器截图。
  可缓存POST页读取到原回执；no-store页两种只读尝试均失败，未证明其错误DOM或
  具体网络错误，不把这项计为可恢复页面。独立证据审计仍在进行。
- 首次崩溃验收 `mbr-c-6k4Ebb` 实际退出1，未进入第二代恢复：原Browser非零退出、
  Job清空、Native退出和controller原树终结完成，但脚手架拒绝了此前未知的
  Windows原CDP连接重置错误。原完整错误、失败及源快照保留；独立源码核对确认
  其来自原Browser.close写入，正在补严格错误分类和反例测试，不追改旧结果。
  root额外只读查明原profile无进程、两视图注册项和endpoint条目均不存在。
- 第二次崩溃验收 `mbr-c-sWjQxm` 原崩溃和实际清理通过，但新 run 尚未创建时，
  启动递归检查发现旧 run 私有 Windows 缓存 junction，实际退出1。独审确认
  旧进程、注册项、管道和 endpoint 均已清理；不把脚手架因缺少第二代 lifecycle
  追加的错误当作实际资源泄漏。原失败与缓存树未改动。
- 最小修复不再递归消费历史 run；root/name 仍校验实际路径、归属 marker 和 ACL，
  profile 在名称锁后完整校验，新 runs/run 路径先检查且独占创建，扩展源完整
  检查保持。28项 Go 定向测试及独审通过。脚手架增加启动前后目录差与原进程
  实际终结的严格诊断，49项检查通过，不将原启动失败转为成功。
- 最新冻结构建 `mbr-build-zjwqmf0j` 完整 Go test/vet、Node 和产物构建实际退出0。
  新默认对照 `mbr-d-FnoftD` 与正常恢复 `mbr-n-GRymnA` 各七步实际退出0；
  崩溃恢复正在执行。上一构建的下载回归 `managed-download-hlinfF` 五步退出0，
  其来源明确为 `mbr-build-v1gdybj9`，不混作本次最新构建的回归。
- 最新崩溃用例 `mbr-c-CsgGmL` 实际退出1：两代绑定及资源清理通过，原三笔
  POST未变，但第二代仅有新标签页，没有四个原业务页面，尚未Resume/claim或
  后续提交。独审保存确切失败；正在核对 Chromium 原生崩溃恢复策略。
  同构建 worker 接续回归 `mwr-c-U2d0Sy` 六步实际退出0。
- 同构建的隔离内存剪贴板回归 `mhc-TEBY19` 在首次seed写入超时，原日志证明
  offscreen不提供`runtime.getManifest`。不使用系统剪贴板。修复从同包、严格
  校验的managed配置派生精确worker入口，普通null配置仍使用原入口；117项
  剪贴板和配置定向检查通过，真实回归和新构建待执行。原失败记录未修改。
- 剪贴板修复后的构建 `mbr-build-_8vm5icv` 完整 Go test/vet、Node 与产物构建
  实际退出0；`mhc-ykKnIG` 七阶段真实回归退出0，覆盖7个复制/剪切用例、
  后续人工接管、唯一提交与实际Stop。两个浏览器均经固定版本内存剪贴板
  guard，不访问系统剪贴板。独审进行中。
- 精确 Chromium 源码显示 `--restore-last-session` 不绕过新 profile 和崩溃
  启动的两个门。显式恢复候选增加 `--hide-crash-restore-bubble`，不修改原
  prefs或退出回执；三个恢复 Go 定向测试通过。独立 `crash-established`
  用例将先正常建立 profile，再确认原A的Crashed标记实际持久化后执行一次
  Browser.crash；保留原首次profile失败及其限制，新候选全量构建进行中。
- 双开关候选冻结构建 `mbr-build-hpfufae_` 完整 Go test/vet、3,381项Node和
  主程序/扩展构建实际退出0，480份输入独审通过。52项脚手架检查通过后，
  最新默认 `mbr-d-Wik1FD` 和正常恢复 `mbr-n-1YhV7o` 各七步实际退出0；
  独审核对934份运行来源和480份构建输入，root目视新原报告/后续回执截图。
  本次正常流程的cache和no-store两页均未读到DOM，不沿用旧场cache恢复结论。
- 独立成熟资料用例 `mbr-c-1HPqxv` 实际退出1：0代blank正常Stop，原A真实
  等到Preferences的Crashed标记写盘后执行一次Browser.crash；B恢复了GET/PRG
  页面和原localStorage，内存草稿未恢复，但新Cookie显示“未保存”。因此
  尚未Resume/新SDK/claim/后续提交，完整接续仍失败；不降低原数据断言。
- 最新首次资料用例 `mbr-c-JTmfpz` 实际退出1：即使双恢复开关，B仍只有新
  标签页。本次A实际退出后、B启动前明确读到Preferences不存在；该新证据
  不回填旧失败。两次失败均无cleanupErrors或liveRunnerChildren，原POST
  账本与各代实际清理交独审核查，原记录保留。
- 下一步先完成Cookie失败的只读机制核对，区分刚写入但尚未落盘的数据与
  已持久化数据。保持生产与脚手架冻结，不重提业务或修改profile来让原测试
  变成功。当前新功能继续未提交/未发布；用户要求的安装包已另行完成交付。

2026-10-23 交付更新：已发布并核验 [preview-20261023-b71be03](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261023-b71be03)，源码 `b71be03af56283a8c7bd70cd60edce9974491eac`。
正常恢复及连接/复制修复进入配套包；两种 crash 原失败、普通公司 Edge 和整体
目标继续开放，本计划保持 active。打包未运行浏览器，原验收按冻结来源引用。

2026-10-23 本次收口：独立 `crash-authenticated` 验收脚手架已完成，
64/64 项 fixture/support/recorded-SDK 检查、语法和 import-only 检查通过；
仅本地 HTTP 与静态检查，真实 Browser 场景尚未执行。受保护请求绑定单次
合成登录、精确 cookie 与当前代次的服务器 GET；最后响应完成后再持久化证据。
旧四模式的数据门槛和原失败保留，新增场景不作为产品恢复成功的证据。
按最新用户请求从此次提交重新构建安装包，原 480 份生产输入沿用已测基线，
打包仅运行构建和离线检查，不启动浏览器；交付完成后记录确切资产和摘要。

2026-10-23 再次刷新交付：已发布并核验 [preview-20261023-db87f52](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261023-db87f52)，固定源码 `db87f52958d134923c75cbc81fb5ef66f813795e`。
生产功能与前包 `b71be03` 相同；新认证验收仅静态/HTTP 64 项通过，真实 Browser
尚未执行。新 EXE 独立构建、480 输入绑定、80 扩展/7 Skill 一致性、离线 CLI/MCP、
独立制品审计、四资产上传回下载及本地副本核验完成，本次没有启动浏览器。
完整 ZIP：10,724,932 字节；SHA256 `3c94e11e2a05001e08e717bd0a5d5ad4dcc0b11c533ad7b67740422983484d15`。
只推用户 fork，无 PR；两场原 crash 失败与完整目标继续开放。
