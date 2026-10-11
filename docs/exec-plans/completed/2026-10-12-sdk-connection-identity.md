# SDK connection identity and recovery

## Goal and starting evidence

继续完整Browser Use对齐目标，补P02/P13跨连接的实例身份边界。前一拖放
分片已提交推送`27843a1`，122/122完整浏览器与1788/1788 Node证据已归档，
属于progress。本片不创建PR、不替换既有preview，不操作系统鼠标或用户标签页。

只读审计发现三SDK在连接关闭后保留控制epoch、turn和能力缓存。JS下一次
request重新connect同一socketPath；Python的传输错误调用close后也可再次
connect；Go NewClient未指定SocketPath时在下次连接重新ReadActiveSocketRecord。
这不是重放原wire请求，而是后续新调用可能把旧实例的绑定带到新连接。

当前JS dist的10个JS成员已与TS内存编译逐字节核对。实际Windows named-pipe
对照覆盖EOF/显式close与三个B端控制状态，共6项、actualexit0。同路径
替换后的B收到首条browserAction，没有重新getInfo/getControlState；请求
保留A的session、turn、tab7、epoch1，wire ID则由3变4。直接执行生产
ControlLedger时，B已独立bootstrap同session且epoch1会接受；B为epoch2
或未知session时拒绝。所有测试server/socket已关闭，无浏览器运行。

这个证据证明客户端未绑定连接身份及控制层数值碰撞的条件，不证明真实
浏览器发生误点击。实际SessionStore还要求B中tab属于同session的精确
group/auxiliary，且site/control/attachment gates均开放；B浏览器重启的
incarnation失效、未知session、不同epoch或非拥有tab仍会拒绝。JS普通
host使用随机endpoint，本反例适用于显式复用路径或端点被替换；Go active
registry切换及Python实际transport行为尚未实测。

## Required behavior and open design choices

- 首次选择浏览器后，旧client、tab、locator、wait/download handle不能因
  active registry或endpoint被替换而静默迁移到另一实例。
- 不自动重放已经发送的副作用请求。原期限包含连接与发现；不通过重置
  epoch、能力缓存或turn把旧对象当作新实例授权。
- 区分首次连接尚未成功、已建立连接丢失、显式close及用户明确的新连接。
  结合现有MCP固定实际连接的实现确定SDK公开恢复契约，再实施；不能仅
  依赖可复制的profile UUID、socket路径或两个实例恰好不同的数字epoch。
- 保留原SDK并发/排队、通知、部分帧、晚响应、取消与复合操作预算行为。
  比较真实生产调用链，不以模拟server接受冒充真实browser业务成功。

## Work and acceptance

- [x] 复核三SDK调用链、MCP已有绑定实现与JS原生named-pipe条件反例。
- [x] 确认Go discovery切换和Python原生transport的具体反例及正常恢复对照。
- [x] 确定统一恢复契约、实现三SDK边界，补旧对象/并发/晚响应的回归。
- [x] 同一端点重用和两个live endpoint切换均核对原始收发；否定组不能
  仅因B自己的epoch/owner门禁而假通过。
- [x] SDK/Go/类型及适当浏览器回归，来源/真实业务/无新增focus规则独立审计。
- [x] 同步文档、总计划和同任务history，完成本片实现与验收并归档；提交
  推送到fork的实际结果另在交付时核验，不创建PR。

## Relevant production paths

- JS：`packages/open-browser-use-js/src/index.ts` 的connect、close、disconnect、
  request及控制初始化；Python：`open_browser_use/client.py` 的_connect、
  close、_wire_request；Go：`client.go` 的Close、request及connectWithTimeoutLocked。
- `cmd/open-browser-use/mcp_connection.go` 已固定一条实际连接，EOF后保持
  失败；这是可比较的现有实现，不重新把该问题列为MCP未修复。
- `apps/chrome-extension/background.js` 的ControlLedger、SessionStore、
  requireSessionTab、authorize及rememberAttachmentOwner是服务端必要门禁。

持有drop guard时worker丢失的实机恢复、Codex同组文件/诊断、平台生命周期
及P01–P15其他未完成项继续保留；此分片不取代完整目标。

## Implementation and Windows acceptance

三SDK第一次成功connect后绑定实际连接，EOF/丢弃stream/close进入终态。
后续有效调用返回`OBU_SDK_BROWSER_DISCONNECTED`，旧handles、manual epoch、
beginTurn及Go active registry不能复活或迁移client；首次从未连接成功可
重试。JS健康socket响应timeout保留连接，Go/Python原有wire timeout丢弃
连接。完整业务错误及发送前预算/编码失败保留健康stream；初次connect
迟到不能覆盖显式close。原在途错误和不重放规则保留。

Go旧A/B同时live时健康连接仍留A，A原连接EOF后才按active重连B，解码收发
记录保留；旧Python四组各13个旧scope请求到B，
修复后均零旧请求且fresh恢复通过。JS连接身份专项17项对旧源12fail，新17pass。
交叉评审发现Python本地预检误终止健康连接与迟到factory复活风险，已修
且新增真实transport反例。Windows Node1792、JS142、Python110全过且零skip；
Go全仓519 test/subtest pass、26平台skip，8无测试helper编译通过；typecheck过。

专项`aZMiIx`4/4及完整`yVGT4D`125/125均actualexit0，旧122名称/相对顺序
保持。三SDK各EOF/close两个真实browser场景使用透明字节relay，旧client
四入口拒绝、零业务提交，fresh client明确协商后各一次trusted POST；
同document token、原始frame、实际子进程退出与双端close、tab/target回收
保存。该实机证据仍是同backend，跨实例碰撞仅原生IPC反例覆盖。

专项2753ms零focus/activation，完整244620ms仅原12activation/4controlpopup
focus，无新增豁免；sentinel身份/选择保持，高1222→1165。首host在重启
测试SIGTERM，替代host实际exit0。新9个Go bin的50生产构建输入前后hash
一致；扩展运行代码未变，旧preview不替换。独立专项/完整审计分别1093/
1371项断言，原始业务、连续focus账本、实际exit/close及源码来源通过。
报告hash前缀f55fc11e/15d356d7。恢复语义见
[契约](../../references/sdk-connection-identity.md)。

WSL2 Ubuntu真实Unix socket补验：Go523pass/10平台skip、JS142/142零skip、
Python109pass/1 Windows路径skip，新host/helper及JS构建通过，外层和六
子命令actualexit0。186源码/测试与当前源一致，20dist重建相同，四组
Python替换端点零旧请求/明确fresh恢复。首次临时目录被环境清空发生在
SDK测试启动前，失败保留；新持久短路径一次完成，无SDK失败重跑。未跑
Linux实机浏览器、macOS及CGO race。此分片完成，完整目标继续active。
