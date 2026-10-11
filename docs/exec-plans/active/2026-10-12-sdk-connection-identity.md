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
- [ ] 确认Go discovery切换和Python原生transport的具体反例及正常恢复对照。
- [ ] 确定统一恢复契约、实现三SDK边界，补旧对象/并发/晚响应的回归。
- [ ] 同一端点重用和两个live endpoint切换均核对原始收发；否定组不能
  仅因B自己的epoch/owner门禁而假通过。
- [ ] SDK/Go/类型及适当浏览器回归，来源/真实业务/无新增focus规则独立审计。
- [ ] 同步文档、总计划和同任务history，提交推送后关闭本片。

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
